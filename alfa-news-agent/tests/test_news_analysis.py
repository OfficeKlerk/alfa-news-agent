"""Offline behavioral tests. Synthetic inputs are test fixtures, not trained deliverables."""

import copy
from datetime import datetime, timedelta, timezone
import itertools
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from company_context import ContextStore, build_database
from news_analysis import (PaymentGraph, LogisticRanker, analyze_news, evaluate_plan,
                           optimize_actions, prepare_training_rows, train_ranker)
from news_analysis.contracts import deduplicate, validate_event
from news_analysis.features import FEATURE_NAMES, FEATURE_VERSION, extract_features
from news_analysis.ranking import fit, evaluate, temporal_split

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests/fixtures/company_context"
AS_OF = "2026-10-22T18:00:00+03:00"


def event(**updates):
    data = {"news_id": "N1", "event_id": "E1", "title": "Тест изменения условий",
            "published_at": "2026-10-21T10:00:00+03:00", "event_type": "rate_change",
            "okved_divisions": [], "countries": [], "regions": [], "company_ids": [],
            "fact_status": "reported", "sources": [{"url": "https://example.org/test", "excerpt": "Тестовая новость."}]}
    data.update(updates)
    return data


def parameter(value):
    return {"value": value, "basis": "assumption", "source": "unit-test fixture"}


def case():
    def action(aid, effect, variable, fixed, max_fraction):
        return {"id": aid, "title": aid, "available": True, "max_fraction": max_fraction,
                "step": .25, "lead_time_months": 0, "effectiveness": parameter(effect),
                "fixed_cost_rub": parameter(fixed), "variable_cost_rub": parameter(variable),
                "liquidity_required_rub": parameter(10000), "prerequisites": "Подтвердить условия договора"}
    return {"case_id": "C1", "company_id": "U_A", "event_id": "E1", "kind": "rate_change",
            "currency": "RUB", "exposure_side": "cost", "horizon_months": 12, "exposure_rub": parameter(1000000),
            "base_scenario": "base", "shocks": [{"id": "base", "delta": parameter(.1)},
                                                 {"id": "low", "delta": parameter(.03)}],
            "actions": [action("fix", 1, 60000, 0, .5), action("alternative", .5, 10000, 1000, .75)],
            "constraints": {"budget_rub": 40000, "liquidity_limit_rub": 10000, "max_actions": 2, "min_roi": 0}}


def training_rows(n_events=20):
    rows = []
    for i in range(n_events):
        for j in range(4):
            values = {name: 0.0 for name in FEATURE_NAMES}
            values["rate_financing"] = float((i + j) % 2)
            values["region_match"] = float(i % 3 == 0)
            rows.append({"company_id": f"U_{j}", "event_id": f"E_{i:02}", "query_id": f"U_{j}",
                         "published_at": (datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(days=i)).isoformat(),
                         "feature_version": FEATURE_VERSION, "features": values,
                         "label": 3 if values["rate_financing"] else 0, "label_origin": "synthetic"})
    return rows


class GraphAndPipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = Path(self.tmp.name) / "context.sqlite"
        build_database(FIXTURES / "companies.csv", self.db, FIXTURES / "links.csv", FIXTURES / "payments.csv", "rub")
        self.store = ContextStore(self.db)
        self.addCleanup(self.store.close)

    def test_graph_uses_full_direction_totals_and_unknown_cards(self):
        news = event(event_type="commodity_price_change", okved_divisions=["24"])
        tiny_profile = self.store.get_company_profile("U_A", top_n=1)
        self.assertTrue(tiny_profile["payment_summary"]["counterparties_truncated"])
        graph = PaymentGraph(self.store, "U_A").exposure(news)
        self.assertAlmostEqual(graph["out"]["matched_share"], .3)
        self.assertAlmostEqual(graph["in"]["matched_share"], .2)
        self.assertAlmostEqual(graph["out"]["attribute_coverage_share"], .3)
        self.assertEqual(graph["out"]["evidence"][0]["payment_records"], [2, 3])
        self.assertEqual(extract_features(tiny_profile, news, AS_OF, graph)["values"]["graph_out_share"], .3)

    def test_multiattribute_match_is_not_double_counted(self):
        news = event(okved_divisions=["24"], regions=["Челябинская область"])
        graph = PaymentGraph(self.store, "U_A").exposure(news)
        self.assertEqual(graph["out"]["matched_share"], .3)
        self.assertEqual(set(graph["out"]["evidence"][0]["matched_fields"]), {"REGION", "MAINOKVED_CODE"})

    def test_missing_graph_and_unknown_products_are_distinct_from_false(self):
        profile = self.store.profile("U_E")
        features = extract_features(profile, event(), AS_OF)["values"]
        self.assertEqual(features["rate_financing"], 0)
        self.assertEqual(features["financing_unknown"], 1)
        self.assertEqual(features["graph_in_unknown"], 1)

    def test_fts_conflict_does_not_create_country_match(self):
        features = extract_features(self.store.profile("U_D"), event(countries=["Китай"]), AS_OF)
        self.assertEqual(features["values"]["country_match"], 0)

    def test_generic_fx_event_and_related_company_signals(self):
        profile = self.store.profile("U_A", top_n=1)
        fx = extract_features(profile, event(event_type="fx_change"), AS_OF)
        self.assertEqual(fx["values"]["fx_trade"], 1)
        mapped = event(event_type="company_event", company_ids=["U_B"], entity_mapping_source="test mapping")
        graph = PaymentGraph(self.store, "U_A").exposure(mapped)
        self.assertEqual(extract_features(profile, mapped, AS_OF, graph)["values"]["related_company_match"], 1)
        kinds = {x["kind"] for x in graph["related_company_matches"][0]["connections"]}
        self.assertEqual(kinds, {"same_group", "shared_person"})

    def test_partial_graph_coverage_is_flagged(self):
        news = event(okved_divisions=["24"])
        graph = PaymentGraph(self.store, "U_A").exposure(news)
        features = extract_features(self.store.profile("U_A"), news, AS_OF, graph)["values"]
        self.assertEqual(features["graph_out_unknown"], 1)
        self.assertEqual(features["graph_out_coverage"], .3)

    def test_unmapped_synthetic_ids_and_unsourced_events_rejected(self):
        with self.assertRaisesRegex(ValueError, "entity_mapping_source"):
            validate_event(event(company_ids=["U_A"]))
        with self.assertRaises(ValueError):
            validate_event(event(sources=[]))

    def test_event_clusters_and_publication_cutoff(self):
        selected, future = deduplicate([event(), event(news_id="N2", published_at="2026-10-22T10:00:00+03:00"),
                                       event(news_id="N3", event_id="E2", published_at="2026-10-23T10:00:00+03:00")], AS_OF)
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["news_id"], "N2")
        self.assertEqual(selected[0]["duplicate_news_ids"], ["N1"])
        self.assertEqual(future, ["N3"])

    def test_profiles_receive_different_rate_features(self):
        a = extract_features(self.store.profile("U_A"), event(), AS_OF)["values"]
        b = extract_features(self.store.profile("U_B"), event(), AS_OF)["values"]
        self.assertEqual((a["rate_financing"], a["rate_deposit"]), (1, 0))
        self.assertEqual((b["rate_financing"], b["rate_deposit"]), (0, 1))

    def test_graph_cannot_be_used_for_another_company(self):
        graph = PaymentGraph(self.store, "U_A").exposure(event())
        with self.assertRaises(ValueError):
            extract_features(self.store.profile("U_B"), event(), AS_OF, graph)

    def test_end_to_end_keeps_sources_and_case_separate_from_bank(self):
        before = self.db.read_bytes()
        result = analyze_news(self.store, "U_A", [event()], AS_OF, cases=[case()])
        card = result["cards"][0]
        self.assertEqual(card["bank_view"], [])
        self.assertFalse(card["self_check"]["position_of_bank_inferred"])
        self.assertEqual(card["model_assessment"]["scenario"]["status"], "conditional_scenario")
        self.assertIn("bank_position_not_provided", card["self_check"]["warnings"])
        self.assertEqual(card["facts"]["sources"], event()["sources"])
        self.assertEqual(before, self.db.read_bytes())
        json.dumps(result, allow_nan=False)

    def test_wrong_scenario_binding_fails(self):
        wrong = case()
        wrong["company_id"] = "U_B"
        with self.assertRaises(ValueError):
            analyze_news(self.store, "U_A", [event()], AS_OF, cases=[wrong])

    def test_label_export_never_invents_labels(self):
        rows = prepare_training_rows(self.store, ["U_A", "U_B"], [event()], AS_OF)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row["label"] is None and row["label_origin"] == "human" for row in rows))
        self.assertIn("profile", rows[0]["annotation_context"])

    def test_cli_analysis_and_input_overwrite_protection(self):
        path = Path(self.tmp.name) / "events.json"
        path.write_text(json.dumps([event()]), encoding="utf-8")
        args = [sys.executable, "-m", "news_analysis", "analyze", "--database", str(self.db),
                "--company-id", "U_A", "--events", str(path), "--as-of", AS_OF]
        result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["company_id"], "U_A")
        before = path.read_bytes()
        bad = subprocess.run(args + ["--output", str(path)], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(bad.returncode, 2)
        self.assertEqual(before, path.read_bytes())


class LearningTests(unittest.TestCase):
    def test_learns_from_labels_and_roundtrips_without_pickle(self):
        rows = training_rows()
        model = fit(rows, iterations=250)
        self.assertGreater(model.predict(rows[1]["features"]), model.predict(rows[0]["features"]))
        restored = LogisticRanker.from_dict(json.loads(json.dumps(model.to_dict())))
        self.assertAlmostEqual(restored.predict(rows[1]["features"]), model.predict(rows[1]["features"]))

    def test_regularization_reduces_coefficient_norm(self):
        rows = training_rows()
        weak, strong = fit(rows, .001, 200), fit(rows, 1, 200)
        self.assertLess(sum(w*w for w in strong.coefficients), sum(w*w for w in weak.coefficients))

    def test_event_split_has_no_cluster_leakage(self):
        parts = temporal_split(training_rows())
        events = [{r["event_id"] for r in part} for part in parts]
        self.assertFalse(events[0] & events[1] or events[0] & events[2] or events[1] & events[2])
        self.assertLess(max(r["published_at"] for r in parts[0]), min(r["published_at"] for r in parts[1]))

    def test_tuning_reports_separate_test_and_unseen_company(self):
        model, report = train_ranker(training_rows(), penalties=[.01, .1], iterations=100, holdout_companies=["U_3"])
        self.assertEqual(model.metadata["label_origin"], "synthetic")
        self.assertGreater(report["test"]["learned"]["ndcg_at_k"], .99)
        self.assertEqual(report["unseen_company_test"]["companies"], ["U_3"])
        self.assertEqual(report["unseen_company_test"]["metrics"]["rows"], 4)

    def test_test_labels_do_not_change_fitted_model(self):
        rows = training_rows()
        model1, _ = train_ranker(rows, penalties=[.01], iterations=80)
        for row in rows[-16:]:
            row["label"] = 3 - row["label"]
        model2, _ = train_ranker(rows, penalties=[.01], iterations=80)
        self.assertEqual(model1.coefficients, model2.coefficients)
        self.assertEqual(model1.intercept, model2.intercept)

    def test_missing_labels_one_class_and_nan_rejected(self):
        rows = training_rows()
        for row in rows:
            row["label"] = 0
        with self.assertRaises(ValueError):
            fit(rows)
        rows[0]["label"] = None
        with self.assertRaises(ValueError):
            fit(rows)
        rows = training_rows()
        rows[0]["features"]["freshness"] = float("nan")
        with self.assertRaises(ValueError):
            fit(rows)

    def test_mixed_label_origins_rejected(self):
        rows = training_rows()
        rows[0]["label_origin"] = "human"
        with self.assertRaises(ValueError):
            train_ranker(rows)

    def test_cli_training_artifacts_reload(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dataset, model_path, report_path = (root / name for name in ("labels.jsonl", "model.json", "report.json"))
            rows = training_rows()
            dataset.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
            result = subprocess.run([sys.executable, "-m", "news_analysis", "train", "--dataset", str(dataset),
                                     "--model-out", str(model_path), "--report-out", str(report_path),
                                     "--l2", ".01", "--iterations", "100"], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            model = LogisticRanker.from_dict(json.loads(model_path.read_text(encoding="utf-8")))
            self.assertEqual(model.metadata["label_origin"], "synthetic")
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(report["test"]["learned"]["rows"], 16)
            self.assertFalse(list(root.glob("*.tmp")))

    def test_metrics_match_hand_calculation(self):
        rows = training_rows(2)[:4]
        perfect = evaluate(rows, lambda x: x["rate_financing"], k=5)
        self.assertEqual(perfect["ndcg_at_k"], .5)  # two queries have no relevant items
        self.assertEqual(perfect["precision_at_k"], .5)


class ScenarioTests(unittest.TestCase):
    def test_rate_formula_and_action_costs(self):
        result = evaluate_plan(case(), {"fix": .5})
        self.assertEqual(result["base"]["baseline_impact_rub"], 100000)
        self.assertEqual(result["base"]["residual_impact_rub"], 50000)
        self.assertEqual(result["cost_rub"], 30000)
        self.assertEqual(result["base"]["net_saving_rub"], 20000)
        self.assertEqual(result["liquidity_required_rub"], 5000)

    def test_optimizer_matches_independent_enumeration(self):
        config = case()
        candidates = []
        for a, b in itertools.product([0, .25, .5], [0, .25, .5, .75]):
            cost = 60000*a + 10000*b + (1000 if b else 0)
            if a+b > 1 or cost > 40000:
                continue
            saving = 100000 * (a + .5*b) - cost
            if saving >= 0:
                candidates.append(saving)
        result = optimize_actions(config)
        self.assertAlmostEqual(result["recommendation"]["objective_net_saving_rub"], max(candidates))
        self.assertEqual(result["search"]["combinations"], 12)

    def test_zero_budget_and_unprofitable_actions_choose_no_action(self):
        config = case()
        config["constraints"]["budget_rub"] = 0
        self.assertEqual(optimize_actions(config)["recommendation"]["actions"], [])
        config = case()
        for action in config["actions"]:
            action["variable_cost_rub"] = parameter(1e7)
        self.assertEqual(optimize_actions(config)["recommendation"]["actions"], [])

    def test_robust_objective_changes_choice_and_preserves_coefficients(self):
        config = case()
        nominal = optimize_actions(config)
        config["objective"] = "robust"
        before = copy.deepcopy(config)
        robust = optimize_actions(config)
        self.assertEqual(config, before)
        self.assertNotEqual(nominal["recommendation"]["fractions"], robust["recommendation"]["fractions"])
        self.assertGreaterEqual(robust["recommendation"]["worst_net_saving_rub"], 0)

    def test_no_double_protection_and_liquidity_constraints(self):
        config = case()
        invalid = evaluate_plan(config, {"fix": .5, "alternative": .75})
        self.assertFalse(invalid["feasible"])
        self.assertIn("overlapping_exposure_fractions", invalid["constraint_violations"])
        config["constraints"]["liquidity_limit_rub"] = 0
        self.assertEqual(optimize_actions(config)["recommendation"]["actions"], [])

    def test_unavailable_actions_are_never_selected(self):
        config = case()
        for action in config["actions"]:
            action["available"] = False
            del action["effectiveness"]
        self.assertEqual(optimize_actions(config)["recommendation"]["actions"], [])

    def test_missing_data_does_not_invent_financial_effect(self):
        config = case()
        config["exposure_rub"]["value"] = None
        result = optimize_actions(config)
        self.assertEqual(result["status"], "needs_parameters")
        self.assertIsNone(result["recommendation"])
        self.assertIn("exposure_rub", result["missing_parameters"])

    def test_negative_shock_is_preserved_and_not_treated_as_loss(self):
        config = case()
        config["shocks"][0]["delta"]["value"] = -.1
        result = optimize_actions(config)
        self.assertEqual(result["baseline"]["base"]["baseline_impact_rub"], -100000)
        self.assertEqual(result["recommendation"]["actions"], [])

    def test_delay_reduces_protection_not_cost(self):
        config = case()
        config["actions"][0]["lead_time_months"] = 6
        result = evaluate_plan(config, {"fix": .5})
        self.assertEqual(result["base"]["residual_impact_rub"], 75000)
        self.assertEqual(result["cost_rub"], 30000)

    def test_fx_exposure_is_already_for_full_horizon(self):
        config = case()
        config.update(kind="fx_change", horizon_months=6)
        result = evaluate_plan(config, {})
        self.assertEqual(result["base"]["baseline_impact_rub"], 100000)

    def test_revenue_side_reverses_shock_effect(self):
        config = case()
        config.update(kind="fx_change", exposure_side="revenue")
        result = optimize_actions(config)
        self.assertEqual(result["baseline"]["base"]["baseline_impact_rub"], -100000)
        self.assertEqual(result["recommendation"]["actions"], [])

    def test_invalid_costs_sources_and_huge_grids_rejected(self):
        for change in [lambda c: c["actions"][0]["variable_cost_rub"].update(value=-1),
                       lambda c: c["actions"][0]["effectiveness"].update(source=""),
                       lambda c: c["actions"][0].update(step=0),
                       lambda c: c.update(currency="USD")]:
            config = case()
            change(config)
            with self.assertRaises(ValueError):
                optimize_actions(config)
        config = case()
        for action in config["actions"]:
            action["step"] = .00001
        with self.assertRaises(ValueError):
            optimize_actions(config)

    def test_invalid_nested_shapes_fail_cleanly(self):
        for field, value in [("actions", {}), ("shocks", [None]), ("constraints", None)]:
            config = case()
            config[field] = value
            with self.assertRaises(ValueError):
                optimize_actions(config)


if __name__ == "__main__":
    unittest.main()

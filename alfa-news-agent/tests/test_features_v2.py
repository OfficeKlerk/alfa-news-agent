"""Version compatibility and factual distinctions, independent of audit labels."""
import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from news_analysis.features import (
    BASELINE_WEIGHTS, DEFAULT_FEATURE_VERSION, FEATURE_NAMES, FEATURE_VERSION,
    V2_FEATURE_NAMES, baseline_explain, baseline_score, extract_features,
)
from news_analysis.ranking import LogisticRanker, evaluate, fit, validate_rows, vector


AS_OF = "2026-10-24T12:00:00Z"
PROFILE = {
    "schema_version": "1.0", "company_id": "company-test",
    "bank_products": {"loan": True, "leasing": False, "factoring": False, "deposit": False},
    "industry": {"okved_code": "46.21.13", "okved_division": "46"},
    "foreign_trade": {"has_fts": True, "countries": ["Китай"], "trade_direction": None},
    "geography": {"region": "Москва"},
}


def event(**details):
    # A synthetic contract test, not a real news source or a human assessment.
    quote = ("Тест: ставка повышена на 100 б.п.; прежнее значение также сохранялось. "
             "Решение объявлено 24 октября, вступает в силу 30 октября 2026 года; "
             "сценарий прогноза; коды ОКВЭД 46.21.13 и 46.75; заемщики, вкладчики, импортеры и покупатели.")
    data = {"news_id": "news-test", "event_id": "event-test", "title": "Синтетическая проверка признаков",
            "published_at": "2026-10-24T10:00:00Z", "event_type": "rate_change",
            "okved_divisions": [], "countries": [], "regions": [], "company_ids": [],
            "fact_status": "reported", "sources": [{"id": "source-test", "url": "https://example.org/test",
                                                       "excerpt": quote}]}
    if details:
        data["event_details"] = {"direction": "unknown", "magnitude": None, "magnitude_unit": "unknown",
                                 "effective_at": None, "decision_status": "unknown", "target_roles": [],
                                 "target_okved_codes": [], **details,
                                 "evidence": [{"field": key, "quote": quote, "source_ids": ["source-test"]}
                                              for key in details if key not in {"taxonomy_origin", "taxonomy_version"}]}
    return data


def features(news=None, profile=None, version=DEFAULT_FEATURE_VERSION):
    return extract_features(profile or PROFILE, news or event(), AS_OF, feature_version=version)


def rows(version):
    output = []
    names = FEATURE_NAMES if version == FEATURE_VERSION else V2_FEATURE_NAMES
    for index in range(4):
        values = dict.fromkeys(names, 0.0)
        values["rate_financing"] = float(index % 2)
        output.append({"company_id": "company-test", "event_id": f"event-{index}", "query_id": "query-test",
                       "published_at": AS_OF, "feature_version": version, "features": values,
                       "label_origin": "synthetic", "label": 3 if index % 2 else 0})
    return output


class FeatureV2Tests(unittest.TestCase):
    def test_v1_contract_coefficients_and_predictions_remain_unchanged(self):
        legacy = extract_features(PROFILE, event(), AS_OF)
        self.assertEqual(legacy["version"], FEATURE_VERSION)
        self.assertEqual(tuple(legacy["values"]), FEATURE_NAMES)
        self.assertEqual(len(FEATURE_NAMES), 20)
        score = sum(legacy["values"][name] * weight for name, weight in zip(FEATURE_NAMES, BASELINE_WEIGHTS))
        self.assertEqual(baseline_score(legacy["values"]), score)
        model = LogisticRanker(BASELINE_WEIGHTS, -.2, {"label_origin": "ai"})
        saved = model.to_dict()
        restored = LogisticRanker.from_dict(json.loads(json.dumps(saved)))
        self.assertEqual(restored.to_dict(), saved)
        self.assertEqual(restored.predict(legacy["values"]), model.predict(legacy["values"]))
        with self.assertRaises(ValueError):
            restored.predict(features()["values"])

    def test_v2_distinguishes_hold_from_change_without_financial_loss_claim(self):
        held = features(event(direction="unchanged", magnitude=0, magnitude_unit="bps"))
        raised = features(event(direction="increase", magnitude=100, magnitude_unit="bps"))
        self.assertEqual(held["values"]["rate_hold_financing"], 1)
        self.assertEqual(held["values"]["rate_magnitude_financing"], 0)
        self.assertGreater(baseline_score(raised["values"]), baseline_score(held["values"]))
        self.assertEqual(raised["values"]["rate_magnitude_financing"], .5)
        # Magnitude changes attention, not a claimed rate exposure or loss.
        self.assertNotIn("loss", raised["values"])
        one_pp = features(event(direction="increase", magnitude=1, magnitude_unit="percentage_points"))
        self.assertEqual(one_pp["values"]["rate_magnitude_financing"], .5)
        relative_percent = features(event(direction="increase", magnitude=1, magnitude_unit="percent"))
        self.assertEqual(relative_percent["values"]["rate_magnitude_financing"], 0)
        self.assertEqual(relative_percent["values"]["rate_magnitude_unknown"], 1)
        large = features(event(direction="decrease", magnitude=1000, magnitude_unit="bps"))
        self.assertEqual(large["values"]["rate_magnitude_financing"], 1)

    def test_missing_financing_is_not_a_known_absence(self):
        unknown, absent = copy.deepcopy(PROFILE), copy.deepcopy(PROFILE)
        unknown["bank_products"] = {"loan": None, "leasing": None, "factoring": None, "deposit": None}
        absent["bank_products"] = {"loan": False, "leasing": False, "factoring": False, "deposit": False}
        news = event(direction="increase", magnitude=100, magnitude_unit="bps", target_roles=["borrower"])
        a, b = features(news, unknown)["values"], features(news, absent)["values"]
        self.assertEqual(a["financing_unknown"], 1)
        self.assertEqual(b["financing_unknown"], 0)
        self.assertEqual(a["target_role_unknown"], 1)
        self.assertEqual(b["target_role_mismatch"], 1)
        self.assertEqual(a["rate_magnitude_financing"], 0)

    def test_full_okved_narrowing_and_unknown_coarser_codes(self):
        news = event(target_okved_codes=["46.75"])
        news.update(event_type="trade_restriction", okved_divisions=["46"])
        self.assertEqual(features(news, version=FEATURE_VERSION)["values"]["industry_match"], 1)
        narrow = features(news)["values"]
        self.assertEqual(narrow["industry_match"], 0)
        self.assertEqual(narrow["industry_target_mismatch"], 1)
        coarser = copy.deepcopy(PROFILE)
        coarser["industry"]["okved_code"] = None
        self.assertEqual(features(news, coarser)["values"]["industry_target_unknown"], 1)
        relevant = event(target_okved_codes=["46.21"])
        self.assertEqual(features(relevant)["values"]["industry_exact_match"], 1)

    def test_narrow_industry_mismatch_is_not_overridden_by_country_or_region(self):
        news = event(target_okved_codes=["46.75"])
        news.update(event_type="trade_restriction", countries=["Китай"], regions=["Москва"],
                    company_ids=[PROFILE["company_id"]], entity_mapping_source="explicit test mapping")
        old, new = features(news, version=FEATURE_VERSION)["values"], features(news)["values"]
        self.assertEqual(old["country_match"], 1)
        self.assertEqual(old["region_match"], 1)
        self.assertEqual(new["country_match"], 0)
        self.assertEqual(new["region_match"], 0)
        self.assertEqual(new["direct_company_match"], 1)

    def test_subject_taxonomy_is_distinct_from_explicit_eligibility(self):
        theme = {"subject_okved_codes": ["46.21"], "taxonomy_origin": "rule_inference",
                 "taxonomy_version": "business-subjects-v1"}
        news = event(**theme)
        news.update(event_type="commodity_price_change")
        extracted = features(news)
        self.assertEqual(extracted["values"]["industry_match"], 1)
        self.assertEqual(extracted["values"]["industry_subject_match"], 1)
        self.assertEqual(extracted["values"]["industry_exact_match"], 0)
        self.assertEqual(extracted["evidence"]["industry_match"]["match_basis"], "rule_subject_taxonomy")
        explicit = features(event(**theme, target_okved_codes=["46.75"]))
        self.assertEqual(explicit["values"]["industry_match"], 0)
        self.assertEqual(explicit["values"]["industry_subject_match"], 0)
        self.assertEqual(explicit["values"]["industry_target_mismatch"], 1)
        bad = copy.deepcopy(news)
        del bad["event_details"]["taxonomy_origin"]
        with self.assertRaisesRegex(ValueError, "taxonomy"):
            features(bad)

    def test_graph_narrow_mismatch_preserves_only_explicit_company_mapping(self):
        from company_context import ContextStore, build_database
        from news_analysis.graph import PaymentGraph
        fixture = Path(__file__).parent / "fixtures/company_context"
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "profile.sqlite3"
            build_database(fixture / "companies.csv", database, fixture / "links.csv", fixture / "payments.csv")
            with ContextStore(database) as store:
                graph = PaymentGraph(store, "U_A")
                news = event(target_okved_codes=["24.20"])
                news.update(event_type="trade_restriction", regions=["Челябинская область"])
                self.assertEqual(graph.exposure(news)["out"]["matched_share"], .3)
                current = graph.exposure(news, feature_version=DEFAULT_FEATURE_VERSION)
                self.assertEqual(current["out"]["matched_share"], 0)
                self.assertEqual(current["out"]["attribute_coverage_share"], .3)
                news.update(company_ids=["U_B"], entity_mapping_source="explicit test mapping")
                named = graph.exposure(news, feature_version=DEFAULT_FEATURE_VERSION)
                self.assertEqual(named["out"]["matched_share"], .3)
                self.assertEqual(named["out"]["evidence"][0]["matched_fields"], ["mapped_company_id"])

    def test_customs_and_payments_do_not_invent_importer_or_buyer_roles(self):
        for role in ("importer", "exporter", "buyer", "seller"):
            result = features(event(target_roles=[role]))["values"]
            self.assertEqual(result["target_role_match"], 0)
            self.assertEqual(result["target_role_unknown"], 1)
        known = copy.deepcopy(PROFILE)
        known["foreign_trade"]["trade_direction"] = "import"
        self.assertEqual(features(event(target_roles=["importer"]), known)["values"]["target_role_match"], 1)

    def test_upcoming_effective_date_is_not_a_future_publication(self):
        soon = features(event(effective_at="2026-10-30T00:00:00Z", decision_status="announced"))
        self.assertEqual(soon["values"]["applicable_deadline_30d"], 1)
        self.assertEqual(soon["values"]["applicable_effective"], 0)
        forecast = features(event(effective_at="2026-10-30T00:00:00Z", decision_status="forecast"))
        self.assertEqual(forecast["values"]["applicable_deadline_30d"], 0)
        self.assertEqual(forecast["values"]["applicable_forecast"], 1)
        irrelevant = event(effective_at="2026-10-30T00:00:00Z", decision_status="announced")
        irrelevant["event_type"] = "other"
        self.assertEqual(features(irrelevant)["values"]["applicable_deadline_30d"], 0)
        future = event()
        future["published_at"] = "2026-10-25T00:00:00Z"
        with self.assertRaisesRegex(ValueError, "after as_of"):
            features(future)

    def test_future_source_revision_cannot_leak_through_an_old_publication(self):
        from news_analysis.contracts import deduplicate
        from integration.ml import RankAdapter
        news = event(direction="increase", magnitude=100, magnitude_unit="bps")
        news["sources"][0]["published_at"] = "2026-10-25T00:00:00Z"
        with self.assertRaisesRegex(ValueError, "source.*after as_of"):
            features(news)
        with self.assertRaisesRegex(ValueError, "source.*after as_of"):
            deduplicate([news], AS_OF)
        with patch.dict(os.environ, {"RANK_MODE": "mock", "RANK_MODEL_PATH": ""}):
            adapter = RankAdapter()
        store = SimpleNamespace(get_company_profile=lambda _: PROFILE)
        request = {"company_id": PROFILE["company_id"], "events": [news], "as_of": AS_OF, "limit": 10}
        with self.assertRaisesRegex(ValueError, "source.*after as_of"):
            adapter.rank(store, request)
        # Legacy undated excerpts remain supported; an excluded future event
        # is filtered before its source revision is considered.
        self.assertEqual(len(deduplicate([event()], AS_OF)[0]), 1)
        news["published_at"] = "2026-10-25T00:00:00Z"
        self.assertEqual(deduplicate([news], AS_OF), ([], [news["news_id"]]))

    def test_explanations_sum_to_score_and_retain_source_evidence(self):
        extracted = features(event(direction="unchanged"))
        explanation = baseline_explain(extracted)
        self.assertAlmostEqual(sum(row["contribution"] for row in explanation), baseline_score(extracted["values"]))
        hold = next(row for row in explanation if row["feature"] == "rate_hold_financing")
        self.assertLess(hold["contribution"], 0)
        self.assertEqual(hold["scale"], "raw_score")
        self.assertEqual(hold["evidence"]["news_sources"][0]["id"], "source-test")
        self.assertTrue(hold["evidence"]["extraction_evidence"])

    def test_unsourced_details_cannot_change_scores(self):
        news = event(direction="unchanged")
        news["event_details"]["evidence"] = []
        with self.assertRaisesRegex(ValueError, "Missing event evidence"):
            features(news)
        news = event(direction="unchanged")
        news["event_details"]["evidence"][0]["quote"] = "This is not in the source."
        with self.assertRaisesRegex(ValueError, "quote"):
            features(news)

    def test_both_feature_versions_train_and_roundtrip_but_never_mix(self):
        for version in (FEATURE_VERSION, DEFAULT_FEATURE_VERSION):
            examples = rows(version)
            model = fit(examples, iterations=30)
            self.assertEqual(model.feature_version, version)
            restored = LogisticRanker.from_dict(model.to_dict())
            self.assertEqual(restored.predict(examples[0]["features"]), model.predict(examples[0]["features"]))
            self.assertGreater(model.predict(examples[1]["features"]), model.predict(examples[0]["features"]))
        mixed = rows(FEATURE_VERSION)[:1] + rows(DEFAULT_FEATURE_VERSION)[1:2]
        for call in (validate_rows, fit, lambda data: evaluate(data, baseline_score)):
            with self.assertRaisesRegex(ValueError, "Mixed"):
                call(mixed)
        with self.assertRaises(ValueError):
            vector(rows(DEFAULT_FEATURE_VERSION)[0]["features"], FEATURE_VERSION)

    def test_pairwise_training_supports_v2_and_rejects_mixed_versions(self):
        from integration.learning import pairwise_fit
        model = pairwise_fit(rows(DEFAULT_FEATURE_VERSION), .01, iterations=30)
        self.assertEqual(model.feature_version, DEFAULT_FEATURE_VERSION)
        self.assertGreater(model.predict(rows(DEFAULT_FEATURE_VERSION)[1]["features"]),
                           model.predict(rows(DEFAULT_FEATURE_VERSION)[0]["features"]))
        with self.assertRaisesRegex(ValueError, "Mixed"):
            pairwise_fit(rows(FEATURE_VERSION)[:1] + rows(DEFAULT_FEATURE_VERSION)[1:2], .01)

    def test_learning_never_silently_converts_old_feedback(self):
        from integration.learning import Learning, encoded, partition
        with tempfile.TemporaryDirectory() as directory:
            learning = Learning(Path(directory) / "registry.sqlite3")
            with learning.db() as db:
                for version in (FEATURE_VERSION, DEFAULT_FEATURE_VERSION):
                    row = rows(version)[0]
                    row.update(event_id=version, split_group_id=version, label_origin="human",
                               dataset_split=partition(version), query_id=version)
                    db.execute("INSERT INTO labels(pair,event_group,split,row_json,query_id) VALUES(?,?,?,?,?)",
                               (version, version, partition(version), encoded(row), version))
            result = learning.run()
            self.assertEqual(result["status"], "waiting")
            self.assertIn("Mixed feature versions", result["reason"])
            self.assertEqual(learning.status()["feature_versions"], {FEATURE_VERSION: 1, DEFAULT_FEATURE_VERSION: 1})
            self.assertEqual(learning.status()["consumed_gate_groups"], 0)


if __name__ == "__main__":
    unittest.main()

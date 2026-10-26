"""Payment profile enrichment must not redefine model features or business roles.

Synthetic boundary regressions, not relevance labels or financial observations.
"""
import copy
from contextlib import closing
from decimal import localcontext
from fractions import Fraction
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from company_context import ContextStore, build_database
from news_analysis import LogisticRanker, PaymentGraph, analyze_news, prepare_training_rows
from news_analysis.features import (
    DEFAULT_FEATURE_VERSION, FEATURE_VERSION, extract_features,
    feature_names, feature_weights,
)
from news_analysis.ranking import fit, validate_rows
from tests.test_features_v2 import AS_OF, event as detailed_event
from tests.test_news_analysis import FIXTURES, event


class PaymentMLCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.database = Path(self.temp.name) / "context.sqlite"
        build_database(FIXTURES / "companies.csv", self.database,
                       FIXTURES / "links.csv", FIXTURES / "payments.csv")
        self.store = ContextStore(self.database)
        self.addCleanup(self.store.close)

    def test_profile_graph_and_features_preserve_small_payments_next_to_large_ones(self):
        news = event(event_type="other", okved_divisions=["24"])
        for precision, large in ((6, 10 ** 6), (28, 10 ** 28)):
            for reverse in (False, True):
                with self.subTest(precision=precision, reverse=reverse):
                    payments = [("U_A", "U_B", "6", 1, 100),
                                ("U_A", "U_C", "6", 1, 101),
                                ("U_A", "U_B", str(large), 1, 102)]
                    if reverse:
                        payments.reverse()
                    with closing(sqlite3.connect(self.database)) as connection, connection:
                        connection.execute("DELETE FROM payments")
                        connection.executemany("INSERT INTO payments VALUES (?,?,?,?,?)", payments)
                    expected_total, expected_match = large + 12, large + 6
                    expected_share = float(Fraction(expected_match, expected_total))
                    with localcontext() as context:
                        context.prec = precision
                        profile = self.store.profile("U_A")
                        flow = profile["payment_summary"]["counterparty_context"]["out"]
                        self.assertEqual(flow["amount_total"], expected_total)
                        self.assertEqual(flow["group_distribution"]["unknown"]["amount"], 6)
                        bucket = next(item for item in flow["industry_distribution"] if item["okved_division"] == "24")
                        for version in (FEATURE_VERSION, DEFAULT_FEATURE_VERSION):
                            graph = PaymentGraph(self.store, "U_A").exposure(news, feature_version=version)
                            self.assertEqual(graph["out"]["total_amount_raw"], expected_total)
                            self.assertEqual(graph["out"]["matched_amount_raw"], expected_match)
                            self.assertEqual(graph["out"]["evidence"][0]["amount_raw"], expected_match)
                            self.assertEqual(graph["out"]["matched_share"], expected_share)
                            self.assertEqual(graph["out"]["matched_share"], bucket["share_of_direction"])
                            self.assertEqual(graph["out"]["attribute_coverage_share"], 1)
                            values = extract_features(profile, news, AS_OF, graph, feature_version=version)["values"]
                            self.assertEqual(values["graph_out_share"], expected_share)
                            self.assertEqual(values["graph_out_unknown"], 0)

    def test_full_payment_environment_and_event_graph_use_the_same_denominator(self):
        profile = self.store.profile("U_A", top_n=1)
        environment = profile["payment_summary"]["counterparty_context"]
        self.assertTrue(profile["payment_summary"]["counterparties_truncated"])
        news = event(event_type="commodity_price_change", okved_divisions=["24"])
        for version in (FEATURE_VERSION, DEFAULT_FEATURE_VERSION):
            graph = PaymentGraph(self.store, "U_A").exposure(news, feature_version=version)
            for direction, expected in (("in", .2), ("out", .3)):
                flow = environment[direction]
                industry = next(item for item in flow["industry_distribution"] if item["okved_division"] == "24")
                self.assertEqual(graph[direction]["total_amount_raw"], flow["amount_total"])
                self.assertEqual(graph[direction]["matched_share"], expected)
                self.assertEqual(graph[direction]["matched_share"], industry["share_of_direction"])
                self.assertEqual(graph[direction]["attribute_coverage_share"], flow["coverage"]["industry"]["known_share"])
            self.assertEqual(graph["out"]["evidence"][0]["payment_records"], [2, 3])
        # The 0.7 with no company card remains in the denominator; neither
        # presentation top_n nor the excluded self-payment of 100 changes it.
        self.assertEqual(environment["out"]["coverage"]["company_card"]["unknown_share"], .7)

    def test_broad_payment_bucket_cannot_override_narrow_event_applicability(self):
        profile = self.store.profile("U_A")
        self.assertTrue(any(signal["topic"].startswith("отрасль контрагентов")
                            for signal in profile["relevance_signals"]))
        news = detailed_event(target_okved_codes=["24.20"])
        news.update(event_type="other", okved_divisions=["24"])
        # All known steel counterparties in this fixture are 24.10, not 24.20.
        graph = PaymentGraph(self.store, "U_A")
        legacy = graph.exposure(news, feature_version=FEATURE_VERSION)
        current = graph.exposure(news, feature_version=DEFAULT_FEATURE_VERSION)
        self.assertEqual(legacy["out"]["matched_share"], .3)
        self.assertEqual(current["out"]["matched_share"], 0)
        self.assertEqual(current["in"]["matched_share"], 0)
        current_features = extract_features(profile, news, AS_OF, current, feature_version=DEFAULT_FEATURE_VERSION)
        self.assertEqual(current_features["values"]["industry_target_mismatch"], 1)
        self.assertEqual(current_features["values"]["graph_out_unknown"], 1)
        advice = analyze_news(self.store, "U_A", [news], AS_OF)["cards"][0]["model_assessment"]["conditional_advice"]
        self.assertEqual(advice[0]["status"], "applicability_check")

    def test_named_counterparty_without_a_card_is_not_discarded_as_unknown_industry(self):
        profile = self.store.profile("U_A")
        unknown = next(item for item in profile["payment_summary"]["counterparty_context"]["out"]["industry_distribution"]
                       if item["okved_division"] is None)
        self.assertIn("U_EXTERNAL", unknown["counterparty_ids"])
        news = event(event_type="company_event", company_ids=["U_EXTERNAL"], entity_mapping_source="synthetic same-namespace mapping")
        graph = PaymentGraph(self.store, "U_A").exposure(news, feature_version=DEFAULT_FEATURE_VERSION)
        self.assertEqual(graph["out"]["matched_share"], .7)
        self.assertEqual(graph["out"]["evidence"][0]["matched_fields"], ["mapped_company_id"])
        # Event-specific ID coverage and generic company-card coverage differ.
        self.assertEqual(graph["out"]["attribute_coverage_share"], 1)
        self.assertEqual(profile["payment_summary"]["counterparty_context"]["out"]["coverage"]["company_card"]["known_share"], .3)

    def test_unknown_group_does_not_become_a_group_connection(self):
        flow = self.store.profile("U_A")["payment_summary"]["counterparty_context"]["in"]
        self.assertEqual(flow["group_distribution"]["unknown"]["share_of_direction"], .8)
        news = event(event_type="company_event", company_ids=["U_C"], entity_mapping_source="synthetic same-namespace mapping")
        graph = PaymentGraph(self.store, "U_A").exposure(news, feature_version=DEFAULT_FEATURE_VERSION)
        self.assertEqual(graph["related_company_matches"], [])
        self.assertEqual(graph["in"]["matched_share"], .8)
        values = extract_features(self.store.profile("U_A"), news, AS_OF, graph,
                                  feature_version=DEFAULT_FEATURE_VERSION)["values"]
        self.assertEqual(values["related_company_match"], 0)
        self.assertEqual(values["graph_in_share"], .8)

    def test_new_context_and_signal_weights_do_not_change_existing_model_inputs(self):
        profile = self.store.profile("U_A")
        legacy_profile = copy.deepcopy(profile)
        legacy_profile["payment_summary"].pop("counterparty_context")
        legacy_profile["provenance"]["signal_method"] = "deterministic_rules_v1"
        legacy_profile["relevance_signals"] = [row for row in legacy_profile["relevance_signals"]
                                                if not row["topic"].startswith("отрасль контрагентов")]
        enriched_profile = copy.deepcopy(profile)
        for signal in enriched_profile["relevance_signals"]:
            signal["weight"] = 999999  # Presentation priorities are not model coefficients.
        news = event(event_type="commodity_price_change", okved_divisions=["24"])
        for version, dimension in ((FEATURE_VERSION, 20), (DEFAULT_FEATURE_VERSION, 39)):
            graph = PaymentGraph(self.store, "U_A").exposure(news, feature_version=version)
            extracted = [extract_features(p, news, AS_OF, graph, feature_version=version)
                         for p in (legacy_profile, profile, enriched_profile)]
            self.assertEqual(extracted[0], extracted[1])
            self.assertEqual(extracted[1], extracted[2])
            self.assertEqual(len(extracted[0]["values"]), dimension)
            model = LogisticRanker(feature_weights(version), -.3, feature_version=version)
            artifact = json.loads(json.dumps(model.to_dict()))
            restored = LogisticRanker.from_dict(artifact)
            self.assertEqual(restored.to_dict(), artifact)
            self.assertEqual(model.predict(extracted[0]["values"]), restored.predict(extracted[2]["values"]))
            card = analyze_news(self.store, "U_A", [news], AS_OF, model=restored)["cards"][0]
            self.assertEqual(card["company_evidence"]["features"]["version"], version)
            self.assertEqual(card["score"], model.predict(extracted[0]["values"]))

    def test_payment_context_does_not_infer_trade_roles_or_financial_exposure(self):
        profile = self.store.profile("U_A")
        news = detailed_event(target_roles=["buyer", "importer"])
        news["event_type"] = "commodity_price_change"
        graph = PaymentGraph(self.store, "U_A").exposure(news, feature_version=DEFAULT_FEATURE_VERSION)
        values = extract_features(profile, news, AS_OF, graph, feature_version=DEFAULT_FEATURE_VERSION)["values"]
        self.assertEqual(profile["foreign_trade"]["has_fts"], True)
        self.assertGreater(profile["payment_summary"]["outgoing_amount"], 0)
        self.assertEqual(values["target_role_unknown"], 1)
        self.assertEqual(values["target_role_match"], 0)
        self.assertEqual(values["target_role_mismatch"], 0)
        card = analyze_news(self.store, "U_A", [news], AS_OF)["cards"][0]
        self.assertEqual(card["model_assessment"]["scenario"], {"status": "not_requested", "recommendation": None})
        self.assertIn("financial_effect_not_estimated", card["self_check"]["warnings"])

    def test_missing_payment_source_is_distinct_from_observed_empty_flow(self):
        database = Path(self.temp.name) / "without-payments.sqlite"
        build_database(FIXTURES / "companies.csv", database)
        news = event(event_type="other", okved_divisions=["24"])
        with ContextStore(database) as missing:
            for store, available in ((missing, False), (self.store, True)):
                profile = store.profile("U_E")
                context = profile["payment_summary"]["counterparty_context"]
                self.assertEqual(context["available"], available)
                self.assertEqual(context["out"] is None, not available)
                graph = PaymentGraph(store, "U_E").exposure(news, feature_version=DEFAULT_FEATURE_VERSION)
                self.assertEqual(graph["available"], available)
                self.assertEqual(graph["out"]["total_amount_raw"], 0 if available else None)
                self.assertIsNone(graph["out"]["matched_share"])
                values = extract_features(profile, news, AS_OF, graph, feature_version=DEFAULT_FEATURE_VERSION)["values"]
                self.assertEqual(values["graph_out_share"], 0)
                self.assertEqual(values["graph_out_unknown"], 1)

    def test_training_export_retains_context_without_adding_unversioned_features_or_labels(self):
        news = [event(news_id="N_RATE", event_id="E_RATE"),
                event(news_id="N_METAL", event_id="E_METAL", event_type="commodity_price_change", okved_divisions=["24"])]
        exported = []
        for version in (FEATURE_VERSION, DEFAULT_FEATURE_VERSION):
            rows = prepare_training_rows(self.store, ["U_A", "U_B"], news, AS_OF, feature_version=version)
            self.assertEqual(len(rows), 4)
            for row in rows:
                self.assertIsNone(row["label"])
                self.assertEqual(set(row["features"]), set(feature_names(version)))
                context = row["annotation_context"]
                self.assertIn("counterparty_context", context["profile"]["payment_summary"])
                self.assertEqual(context["graph"]["company_id"], row["company_id"])
                self.assertEqual(context["graph"]["event_id"], row["event_id"])
                json.dumps(context, allow_nan=False)
            # Explicit synthetic labels exercise compatibility, not annotation quality.
            training = copy.deepcopy(rows)
            for index, row in enumerate(training):
                row.update(label=3 if index % 2 else 0, label_origin="synthetic")
            self.assertEqual(validate_rows(training), version)
            learned = fit(training, iterations=3)
            self.assertEqual(learned.feature_version, version)
            exported.extend(training)
        with self.assertRaisesRegex(ValueError, "Mixed feature versions"):
            validate_rows(exported)


if __name__ == "__main__":
    unittest.main()

"""Semantic regressions found during the 24 October audit; fixtures are synthetic."""
import copy
import tempfile
import unittest
from pathlib import Path

from company_context import ContextStore, build_database
from integration.learning import pairwise_fit
from news_analysis import LogisticRanker, analyze_news, evaluate_plan, optimize_actions
from news_analysis.contracts import validate_event
from news_analysis.features import FEATURE_NAMES, FEATURE_VERSION, DEFAULT_FEATURE_VERSION
from news_analysis.pipeline import conditional_advice
from tests.test_features_v2 import AS_OF, PROFILE, event, features, rows
from tests.test_news_analysis import FIXTURES, case, parameter


class AdviceAuditTests(unittest.TestCase):
    def test_rate_hold_does_not_recommend_protection_from_a_new_shock(self):
        news = event(direction="unchanged", magnitude=0, magnitude_unit="bps")
        advice = conditional_advice(PROFILE, news, features(news))
        self.assertEqual([row["status"] for row in advice], ["monitoring_only"])
        self.assertIn("не содержит нового изменения", advice[0]["condition"])
        self.assertNotIn("защит", advice[0]["action"])

    def test_forecast_and_disputed_claims_require_verification(self):
        forecast = event(decision_status="forecast")
        self.assertEqual(conditional_advice(PROFILE, forecast, features(forecast))[0]["status"], "scenario_only")
        disputed = event(direction="increase", magnitude=100, magnitude_unit="bps")
        disputed["fact_status"] = "disputed"
        self.assertEqual(conditional_advice(PROFILE, disputed, features(disputed))[0]["status"], "source_verification")
        unknown = event()
        self.assertEqual(conditional_advice(PROFILE, unknown, features(unknown))[0]["status"], "needs_event_details")

    def test_credit_and_deposit_sides_are_both_preserved(self):
        profile = copy.deepcopy(PROFILE)
        profile["bank_products"]["deposit"] = True
        news = event(direction="decrease", magnitude=50, magnitude_unit="bps")
        advice = conditional_advice(profile, news, features(news, profile))
        self.assertEqual(len(advice), 2)
        self.assertIn("допускает ли договор снижение", advice[0]["action"])
        self.assertIn("/bank_products/deposit", advice[1]["profile_evidence"])
        self.assertTrue(all(row["required_data"] for row in advice))

    def test_narrow_mismatch_gets_applicability_or_indirect_checks(self):
        news = event(target_okved_codes=["46.75"])
        news["event_type"] = "trade_restriction"
        extracted = features(news)
        self.assertEqual(conditional_advice(PROFILE, news, extracted)[0]["status"], "applicability_check")
        indirect = copy.deepcopy(extracted)
        indirect["values"]["graph_out_share"] = .1
        self.assertEqual(conditional_advice(PROFILE, news, indirect)[0]["status"], "indirect_exposure_check")
        named = copy.deepcopy(extracted)
        named["values"]["direct_company_match"] = 1
        self.assertEqual(conditional_advice(PROFILE, news, named)[0]["status"], "conditional_direction")

    def test_held_rate_respects_false_unknown_and_each_known_product(self):
        news = event(direction="unchanged", magnitude=0, magnitude_unit="bps")
        profile = copy.deepcopy(PROFILE)
        profile["bank_products"] = dict.fromkeys(("loan", "leasing", "factoring", "deposit"), False)
        absent = conditional_advice(profile, news, features(news, profile))[0]
        self.assertEqual(absent["required_data"], [])
        self.assertNotIn("даты пересмотра", absent["action"])
        self.assertIn("как отсутствующие", absent["condition"])
        profile["bank_products"]["deposit"] = None
        unknown = conditional_advice(profile, news, features(news, profile))[0]
        self.assertIn("неполны", unknown["condition"])
        self.assertNotEqual(unknown["action"], absent["action"])
        profile["bank_products"]["deposit"] = True
        deposit = conditional_advice(profile, news, features(news, profile))[0]
        self.assertIn("депозит", deposit["action"])
        self.assertNotIn("кредит", deposit["action"])

    def test_freshness_and_graph_coverage_alone_do_not_prompt_operational_action(self):
        news = event()
        news["event_type"] = "other"
        extracted = features(news)
        extracted["values"]["graph_in_coverage"] = 1
        extracted["values"]["graph_out_coverage"] = 1
        self.assertGreater(extracted["values"]["freshness"], 0)
        advice = conditional_advice(PROFILE, news, extracted)[0]
        self.assertEqual(advice["status"], "no_confirmed_link")
        self.assertEqual(advice["required_data"], [])
        self.assertIn("не доказательство отсутствия", advice["condition"])
        extracted["values"]["graph_out_share"] = .01
        self.assertEqual(conditional_advice(PROFILE, news, extracted)[0]["status"], "conditional_direction")

    def test_effective_date_needs_a_channel_and_does_not_create_a_legal_obligation(self):
        news = event(effective_at="2026-10-26T00:00:00Z", target_okved_codes=["46.21"])
        news["event_type"] = "other"
        advice = conditional_advice(PROFILE, news, features(news))
        self.assertEqual(advice[0]["status"], "conditional_timing_check")
        self.assertIn("2026-10-26", advice[0]["action"])
        self.assertIn("не доказывает юридическую обязанность", advice[0]["condition"])
        unrelated = event(effective_at="2026-10-26T00:00:00Z")
        unrelated["event_type"] = "other"
        self.assertEqual(conditional_advice(PROFILE, unrelated, features(unrelated))[0]["status"], "no_confirmed_link")
        forecast = event(effective_at="2026-10-26T00:00:00Z", target_okved_codes=["46.21"], decision_status="forecast")
        forecast["event_type"] = "other"
        self.assertEqual(conditional_advice(PROFILE, forecast, features(forecast))[0]["status"], "scenario_only")


class ScenarioAuditTests(unittest.TestCase):
    def test_zero_shock_or_exposure_chooses_no_action_even_when_action_is_free(self):
        for zero_field in ("shock", "exposure"):
            config = case()
            for action in config["actions"]:
                action["fixed_cost_rub"] = parameter(0)
                action["variable_cost_rub"] = parameter(0)
            if zero_field == "shock":
                for shock in config["shocks"]:
                    shock["delta"] = parameter(0)
            else:
                config["exposure_rub"] = parameter(0)
            result = optimize_actions(config)
            self.assertEqual(result["recommendation"]["actions"], [])
            self.assertEqual(result["recommendation"]["objective_net_saving_rub"], 0)
            self.assertEqual(result["decision_reason"], "no_action_justified_under_supplied_assumptions")

    def test_overflow_in_non_base_scenario_is_rejected(self):
        config = case()
        config["exposure_rub"] = parameter(1e308)
        config["shocks"][0]["delta"] = parameter(0)
        config["shocks"][1]["delta"] = parameter(10)
        with self.assertRaisesRegex(ValueError, "overflow in shock scenario"):
            evaluate_plan(config, {})

    def test_wrong_fraction_shape_is_a_validation_error(self):
        for value in (None, [], "fix"):
            with self.assertRaisesRegex(ValueError, "fractions must be an object"):
                evaluate_plan(case(), value)


class BoundaryAuditTests(unittest.TestCase):
    def test_contradictory_direction_and_duplicate_sources_are_rejected(self):
        for news in (event(direction="unchanged", magnitude=100, magnitude_unit="bps"),
                     event(direction="increase", magnitude=0, magnitude_unit="bps")):
            with self.assertRaisesRegex(ValueError, "contradicts"):
                validate_event(news)
        news = event(direction="unchanged")
        news["sources"].append(copy.deepcopy(news["sources"][0]))
        with self.assertRaisesRegex(ValueError, "Duplicate news source"):
            validate_event(news)

    def test_graph_version_and_share_bounds_cannot_be_silently_coerced(self):
        from news_analysis.features import extract_features
        news = event()
        graph = {"company_id": PROFILE["company_id"], "event_id": news["event_id"],
                 "method": "one_hop_payment_share_v1", "in": {"matched_share": .2, "attribute_coverage_share": .4},
                 "out": {"matched_share": None, "attribute_coverage_share": None}}
        with self.assertRaisesRegex(ValueError, "another feature version"):
            extract_features(PROFILE, news, AS_OF, graph, feature_version=DEFAULT_FEATURE_VERSION)
        graph["method"] = "one_hop_payment_share_v2"
        with self.assertRaisesRegex(ValueError, "another feature version"):
            extract_features(PROFILE, news, AS_OF, graph, feature_version=FEATURE_VERSION)
        graph["in"]["matched_share"] = 1.1
        with self.assertRaisesRegex(ValueError, "outside allowed"):
            extract_features(PROFILE, news, AS_OF, graph, feature_version=DEFAULT_FEATURE_VERSION)

    def test_v1_scores_keep_their_version_but_advice_uses_current_applicability(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "context.sqlite3"
            build_database(FIXTURES / "companies.csv", database, FIXTURES / "links.csv", FIXTURES / "payments.csv")
            with ContextStore(database) as store:
                news = event(target_okved_codes=["46.75"])
                news["event_type"] = "trade_restriction"
                model = LogisticRanker([0.0] * len(FEATURE_NAMES), 0.0)
                card = analyze_news(store, "U_A", [news], AS_OF, model=model)["cards"][0]
                self.assertEqual(card["score"], .5)
                self.assertEqual(card["company_evidence"]["features"]["version"], FEATURE_VERSION)
                self.assertEqual(card["model_assessment"]["conditional_advice"][0]["status"], "applicability_check")

    def test_future_bank_excerpt_is_rejected_and_held_rate_scenario_is_conditional(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "context.sqlite3"
            build_database(FIXTURES / "companies.csv", database, FIXTURES / "links.csv", FIXTURES / "payments.csv")
            with ContextStore(database) as store:
                news = event(direction="unchanged", magnitude=0, magnitude_unit="bps")
                bank = {"event_id": news["event_id"], "source": "test", "excerpt": "test bank quote",
                        "published_at": "2026-10-25T00:00:00Z"}
                with self.assertRaisesRegex(ValueError, "Bank excerpt.*after as_of"):
                    analyze_news(store, "U_A", [news], AS_OF, bank_analytics=[bank])
                config = case()
                config["event_id"] = news["event_id"]
                card = analyze_news(store, "U_A", [news], AS_OF, cases=[config])["cards"][0]
                self.assertIn("scenario_is_conditional_not_observed_event_loss", card["self_check"]["warnings"])
                self.assertIn("unchanged_rate_does_not_supply_a_new_rate_shock", card["self_check"]["warnings"])
                self.assertEqual(card["model_assessment"]["conditional_advice"][0]["status"], "monitoring_only")

    def test_pair_budget_does_not_drop_later_company_queries(self):
        # More than 5000 preferences in the first query previously exhausted
        # the entire budget before the second company was encountered.
        prototype = rows(FEATURE_VERSION)[0]
        examples = []
        for i in range(144):
            row = copy.deepcopy(prototype)
            row.update(query_id="a-large", event_id=f"a-{i:03}", label=3 if i % 2 else 0)
            row["features"]["rate_financing"] = float(i % 2)
            examples.append(row)
        for i in range(2):
            row = copy.deepcopy(prototype)
            row.update(company_id="second-company", query_id="z-small", event_id=f"z-{i}", label=3 if i else 0)
            row["features"]["country_match"] = float(i)
            examples.append(row)
        model = pairwise_fit(examples, l2=.01, iterations=1)
        self.assertEqual(model.metadata["pairs"], 5000)
        self.assertEqual(model.metadata["queries"], 2)
        self.assertGreater(model.coefficients[FEATURE_NAMES.index("country_match")], 0)


if __name__ == "__main__":
    unittest.main()

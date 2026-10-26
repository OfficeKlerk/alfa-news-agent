"""Synthetic TEAM_TASKS5 cases, sharing the exact Node-extracted public events."""
import copy
import json
import unittest
from pathlib import Path

from news_analysis.features import extract_features, baseline_explain, DEFAULT_FEATURE_VERSION
from news_analysis.pipeline import conditional_advice

FIXTURES = json.loads((Path(__file__).parent / "fixtures/event_interpretation_cases.json").read_text(encoding="utf-8"))


def profile(code):
    return {"schema_version": "1.0", "company_id": "synthetic-company",
            "industry": {"okved_code": code, "okved_division": code[:2] if code else None},
            "bank_products": {"loan": True, "leasing": True, "factoring": False, "deposit": False},
            "foreign_trade": {"has_fts": False, "countries": []}, "geography": {"region": None}}


def event(name):
    return copy.deepcopy(next(c["event"] for c in FIXTURES["cases"] if c["id"] == name))


def features(company, news):
    return extract_features(company, news, FIXTURES["as_of"], feature_version=DEFAULT_FEATURE_VERSION)


class EventInterpretationTests(unittest.TestCase):
    def test_transport_sector_adds_a_real_nonfreshness_contribution_without_contracts(self):
        news = event("transport_budget")
        carrier, dentist = profile("49.41"), profile("86.23")
        cf, df = features(carrier, news), features(dentist, news)
        self.assertEqual(cf["values"]["industry_match"], 1)
        self.assertEqual(cf["values"]["industry_subject_match"], 1)
        self.assertEqual(df["values"]["industry_match"], 0)
        self.assertEqual(df["values"]["industry_subject_mismatch"], 1)
        self.assertEqual(cf["evidence"]["industry_match"]["match_basis"], "rule_subject_taxonomy")
        contributions = baseline_explain(cf)
        self.assertTrue(any(row["feature"] == "industry_match" and row["contribution"] > 0 for row in contributions))
        carrier_advice = conditional_advice(carrier, news, cf)[0]
        dentist_advice = conditional_advice(dentist, news, df)[0]
        self.assertIn("Отрасль связана", carrier_advice["condition"])
        self.assertIn("не подтверждает контракты", carrier_advice["condition"])
        self.assertEqual(dentist_advice["status"], "applicability_check")
        self.assertNotEqual(carrier_advice["condition"], dentist_advice["condition"])
        self.assertEqual(news["event_details"]["target_okved_codes"], [])

    def test_power_sector_has_subject_match_but_not_proven_legal_obligation(self):
        company, news = profile("35.14"), event("standards_development")
        f = features(company, news)
        self.assertEqual(f["values"]["industry_match"], 1)
        self.assertEqual(f["values"]["industry_exact_match"], 0)
        self.assertIsNone(news["event_details"]["effective_at"])
        self.assertEqual(news["event_details"]["decision_status"], "unknown")
        advice = conditional_advice(company, news, f)[0]
        self.assertIn("стадия решения", " ".join(advice["required_data"]))
        self.assertIn("не подтверждает", advice["condition"])

    def test_hold_is_monitoring_only_and_does_not_freeze_contract_terms(self):
        company, news = profile("49.41"), event("rate_hold")
        f = features(company, news)
        advice = conditional_advice(company, news, f)[0]
        self.assertEqual(advice["status"], "monitoring_only")
        self.assertIn("не подтверждает неизменность", advice["condition"])
        self.assertIn("тип ставки", " ".join(advice["required_data"]))
        self.assertIn("банковские предложения", " ".join(advice["required_data"]))
        self.assertEqual(f["values"]["rate_magnitude_financing"], 0)

    def test_unknown_industry_and_explicit_scope_are_not_overridden_by_a_broad_topic(self):
        news = event("transport_budget")
        self.assertEqual(features(profile(None), news)["values"]["industry_match"], 0)
        quote = "Льгота применяется для ОКВЭД 86.23."
        news["sources"][0]["excerpt"] += " " + quote
        news["event_details"]["target_okved_codes"] = ["86.23"]
        news["event_details"]["evidence"].append({"field":"target_okved_codes","quote":quote,"source_ids":[news["sources"][0]["id"]]})
        f = features(profile("49.41"), news)
        self.assertEqual(f["values"]["industry_match"], 0)
        self.assertEqual(f["values"]["industry_target_mismatch"], 1)


if __name__ == "__main__":
    unittest.main()

"""Offline tests use only synthetic fixtures and temporary databases."""

import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from company_context import ContextStore, build_database
from company_context.io import flag, number, sector

FIXTURES = Path(__file__).parent / "fixtures" / "company_context"
ROOT = Path(__file__).resolve().parents[1]


class ContextTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.db = Path(self.temporary.name) / "context.sqlite"
        self.metadata = build_database(FIXTURES / "companies.csv", self.db,
                                       FIXTURES / "links.csv", FIXTURES / "payments.csv", "rub")
        self.store = ContextStore(self.db)
        self.addCleanup(self.store.close)

    def test_profile_fields_and_units(self):
        profile = self.store.get_company_profile("U_A")
        self.assertEqual(profile["industry"]["sector"], "Обрабатывающие производства")
        self.assertEqual(profile["scale"]["revenue_rub"], 20_000_000_000)
        self.assertTrue(profile["scale"]["is_large_business"])
        self.assertTrue(profile["bank_products"]["loan"])
        self.assertIsNone(profile["bank_products"]["leasing"])
        self.assertEqual(profile["foreign_trade"]["countries"], ["КИТАЙ", "ТУРЦИЯ"])
        self.assertEqual(profile["provenance"]["company"]["records"], [2])

    def test_decimal_payment_aggregation_and_direction(self):
        profile = self.store.profile("U_A")
        summary = profile["payment_summary"]
        self.assertEqual(summary["outgoing_amount"], 1)
        self.assertEqual(summary["incoming_amount"], 5)
        self.assertEqual(summary["outgoing_count"], 10)
        edge = next(cp for cp in profile["counterparties"] if cp["company_id"] == "U_B" and cp["direction"] == "out")
        self.assertEqual(edge["pay_amount"], 0.3)
        self.assertEqual(edge["pay_count"], 3)
        self.assertEqual(edge["source"]["records"], [2, 3])
        self.assertAlmostEqual(summary["concentration"]["out"]["hhi"], 0.58)
        self.assertEqual(edge["role"], "получатель платежей")

    def test_missing_counterparty_card_preserved(self):
        profile = self.store.profile("U_A")
        external = next(cp for cp in profile["counterparties"] if cp["company_id"] == "U_EXTERNAL")
        self.assertFalse(external["company_card_available"])
        self.assertEqual(external["share_of_direction"], 0.7)

    def test_top_n_does_not_change_denominator(self):
        profile = self.store.profile("U_A", top_n=1)
        self.assertEqual(len(profile["counterparties"]), 1)
        self.assertTrue(profile["payment_summary"]["counterparties_truncated"])
        self.assertEqual(profile["counterparties"][0]["share_of_direction"], 0.8)
        self.assertEqual(profile["payment_summary"]["outgoing_amount"], 1)

    def test_relationships_deduplication_and_group(self):
        profile = self.store.profile("U_A")
        self.assertEqual(profile["group"]["members"], ["U_A", "U_B"])
        self.assertEqual(profile["group"]["observed_revenue_raw_sum"], 30_000_000_000)
        related = {cp["company_id"]: cp for cp in profile["related_companies"]}
        self.assertEqual(related["U_B"]["shared_people_count"], 2)
        self.assertEqual(related["U_B"]["source"]["records"], [2, 3, 5, 6])
        self.assertNotIn("U_A", related)
        self.assertEqual(related["U_EXTERNAL"]["shared_people_count"], 1)

    def test_dataset_position_ties_and_not_market_share(self):
        position = self.store.profile("U_A")["dataset_position"]
        self.assertEqual(position["companies_with_known_revenue"], 3)
        self.assertEqual(position["revenue_rank"], 1)
        self.assertEqual(position["median_revenue_raw"], 20_000_000_000)
        self.assertEqual(position["share_of_observed_revenue"], 0.4)
        self.assertIsNone(position["market_share"])
        self.assertEqual(self.store.profile("U_B")["dataset_position"]["revenue_rank"], 3)

    def test_signal_evidence_resolves_and_no_credit_signal_without_loan(self):
        profile = self.store.profile("U_A")
        self.assertTrue(any("финансирование" in signal["topic"] for signal in profile["relevance_signals"]))
        for signal in profile["relevance_signals"]:
            self.assertGreaterEqual(signal["weight"], 0)
            self.assertLessEqual(signal["weight"], 1)
            for pointer in signal["evidence"]:
                target = profile
                for part in pointer.strip("/").split("/"):
                    target = target[int(part)] if isinstance(target, list) else target[part]
        self.assertFalse(any("финансирование" in signal["topic"] for signal in self.store.profile("U_B")["relevance_signals"]))
        json.dumps(profile, allow_nan=False)

    def test_missing_and_conflicting_values(self):
        sparse = self.store.profile("U_E")
        self.assertIsNone(sparse["bank_products"]["loan"])
        self.assertIsNone(sparse["scale"]["revenue_rub"])
        self.assertFalse(sparse["dataset_position"]["available"])
        self.assertIn("unrecognized_boolean:CL_PRODUCT_LOA_MARK", sparse["data_quality"]["warnings"])
        conflict = self.store.profile("U_D")
        self.assertIn("fts_flag_conflicts_with_countries", conflict["data_quality"]["warnings"])
        self.assertFalse(any("торгов" in item["topic"] for item in conflict["relevance_signals"]))

    def test_audit_skips_bad_records(self):
        self.assertEqual(self.metadata["audit"]["rows"]["companies_loaded"], 5)
        issues = self.metadata["audit"]["issues"]
        self.assertEqual(issues["invalid_payment"], 4)
        self.assertEqual(issues["self_payment_excluded"], 1)
        self.assertEqual(issues["duplicate_person_company_link"], 1)
        self.assertEqual(self.metadata["audit"]["rows"]["payment_participants_without_company"], 1)
        self.assertEqual(len(self.metadata["sources"]["companies"]["sha256"]), 64)

    def test_large_filter_strict_threshold_and_list_bounds(self):
        self.assertEqual(self.store.list_companies(large_only=True), ["U_A", "U_D"])
        self.assertFalse(self.store.profile("U_C")["scale"]["is_large_business"])
        self.assertEqual(self.store.list_companies(limit=2, offset=1), ["U_B", "U_C"])
        with self.assertRaises(ValueError):
            self.store.list_companies(limit=0)
        with self.assertRaises(ValueError):
            self.store.profile("U_A", top_n=0)
        with self.assertRaises(KeyError):
            self.store.profile("unknown")

    def test_missing_optional_csv_and_unknown_units(self):
        db = Path(self.temporary.name) / "minimal.sqlite"
        build_database(FIXTURES / "companies.csv", db)
        with ContextStore(db) as store:
            profile = store.profile("U_A")
            self.assertIsNone(profile["scale"]["revenue_rub"])
            self.assertIsNone(profile["scale"]["is_large_business"])
            self.assertIsNone(profile["payment_summary"]["incoming_amount"])
            self.assertFalse(profile["payment_summary"]["available"])
            self.assertEqual(profile["counterparties"], [])
            self.assertIn("links_not_provided", profile["data_quality"]["warnings"])
            with self.assertRaises(ValueError):
                store.list_companies(large_only=True)

    def test_thousand_rub_conversion(self):
        db = Path(self.temporary.name) / "thousands.sqlite"
        build_database(FIXTURES / "companies.csv", db, revenue_unit="thousand_rub")
        with ContextStore(db) as store:
            self.assertEqual(store.profile("U_A")["scale"]["revenue_rub"], 20_000_000_000_000)

    def test_conflicting_company_cards_keep_all_sources_and_unknown_facts(self):
        source = Path(self.temporary.name) / "duplicate.csv"
        source.write_text("SYNTHETIC_U;REVENUE_COMPANY;MAINOKVED_CODE;REGION\nU_A;10;24.10;R1\nU_A;20;46.90;R1\nU_A;30;24.10;R2\n", encoding="utf-8")
        db = Path(self.temporary.name) / "duplicates.sqlite"
        metadata = build_database(source, db, revenue_unit="rub")
        with ContextStore(db) as store:
            profile = store.profile("U_A")
            self.assertIsNone(profile["scale"]["revenue_raw"])
            self.assertIsNone(profile["industry"]["okved_code"])
            self.assertIsNone(profile["geography"]["region"])
            self.assertEqual(profile["data_quality"]["company_records_total"], 3)
            self.assertEqual(profile["provenance"]["company"]["records"], [2, 3, 4])
            self.assertEqual(len(profile["provenance"]["company_record_variants"]), 3)
            self.assertEqual(metadata["audit"]["rows"]["companies_loaded"], 1)
            self.assertEqual(metadata["audit"]["issues"]["duplicate_company_id"], 2)

    def test_failed_build_does_not_replace_database(self):
        source = Path(self.temporary.name) / "invalid.csv"
        source.write_text("wrong\nU_A\n", encoding="utf-8")
        before = self.db.read_bytes()
        with self.assertRaises(ValueError):
            build_database(source, self.db)
        self.assertEqual(before, self.db.read_bytes())

    def test_missing_required_header_fails(self):
        source = Path(self.temporary.name) / "bad.csv"
        source.write_text("wrong\nU_A\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "missing columns"):
            build_database(source, Path(self.temporary.name) / "bad.sqlite")

    def test_database_opened_read_only(self):
        with self.assertRaises(sqlite3.OperationalError):
            self.store.connection.execute("DELETE FROM companies")

    def test_cli_export_and_error(self):
        output = Path(self.temporary.name) / "profile.json"
        run = subprocess.run([sys.executable, "-m", "company_context", "profile", "--database", str(self.db),
                              "--company-id", "U_A", "--output", str(output)], cwd=ROOT, capture_output=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["company_id"], "U_A")
        bad = subprocess.run([sys.executable, "-m", "company_context", "profile", "--database", str(self.db),
                              "--company-id", "absent"], cwd=ROOT, capture_output=True)
        self.assertEqual(bad.returncode, 2)
        self.assertNotIn(b"Traceback", bad.stderr)


class NormalizationTests(unittest.TestCase):
    def test_numbers_flags_and_okved(self):
        self.assertEqual(number("1\u00a0234,56"), Decimal("1234.56"))
        for raw in ["NaN", "Infinity", "-1", "text", None]:
            self.assertIsNone(number(raw))
        self.assertIsNone(flag("unknown"))
        self.assertFalse(flag("0.0"))
        self.assertTrue(flag("1.0"))
        self.assertEqual(sector("46.72"), "Торговля")
        self.assertIsNone(sector("bad"))

    def test_cp1251_bom_and_quoted_delimiters(self):
        with tempfile.TemporaryDirectory() as temp:
            for encoding in ["cp1251", "utf-8-sig"]:
                source = Path(temp) / "source.csv"
                source.write_text('SYNTHETIC_U;MAINOKVED_NAME\nU_X;"Название; с разделителем"\n', encoding=encoding)
                db = Path(temp) / (encoding + ".sqlite")
                build_database(source, db)
                with ContextStore(db) as store:
                    self.assertEqual(store.profile("U_X")["industry"]["name"], "Название; с разделителем")


if __name__ == "__main__":
    unittest.main()

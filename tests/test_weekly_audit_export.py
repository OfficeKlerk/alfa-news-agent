"""Independent export/runner checks; no original articles or organizer DB needed."""
import copy
from datetime import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("weekly_audit_export_runner", ROOT / "scripts/analyze_weekly_news.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class FakeStore:
    metadata = {"sources": {"test_source": "test-fixture-only"}}

    def __init__(self, _path):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        pass

    def get_company_profile(self, uid):
        return {"company_id": uid, "industry": {"okved_code": "46.21"}, "bank_products": {}, "foreign_trade": {}, "geography": {}}


def analysis_fixture(_store, _uid, events, *_args, **_kwargs):
    return {"cards": [{"news_id": event["news_id"], "score": 0.0, "score_kind": "manual_feature_baseline",
                        "model_assessment": {"scenario": {"status": "not_requested"}, "feature_contributions": [],
                                             "conditional_advice": [{"action": "Проверить условия.", "condition": "Проверка применимости.", "required_data": [], "status": "test_fixture"}]},
                        "facts": {"event_type": "other"}, "company_evidence": {"features": {"values": {}}, "graph": {}}, "self_check": {}}
                       for event in events], "excluded_future_news_ids": [], "limitations": []}


class WeeklyAuditExportTests(unittest.TestCase):
    def run_fixture(self, folder, analysis=analysis_fixture, previous=None):
        articles, events = [], []
        for index, article_id in enumerate(runner.TITLES):
            news_id = "fixture-" + str(index)
            articles.append({"news_id": news_id, "article_id": article_id, "url": "https://example.org/" + news_id, "content_sha256": "a" * 64})
            events.append({"news_id": news_id, "published_at": "2026-10-23T23:59:59.999Z", "is_mock": False, "text": "PRIVATE_ARTICLE_SENTINEL", "sources": []})
        bundle = {"input_kind": "original_primary_article_text", "articles": articles, "events": events,
                  "as_of": "2026-10-24T12:00:00Z", "checks": {}, "input_sha256": "b" * 64, "code_hashes": {}}
        source = folder / "private-events.json"
        source.write_text(json.dumps(bundle))
        argv = ["analyze_weekly_news.py", "--events", str(source), "--database", str(folder / "unused.sqlite"),
                "--module-root", str(ROOT), "--out", str(folder / "results.json"), "--report", str(folder / "report.md")]
        if previous:
            argv += ["--previous", str(previous)]
        store_module = types.ModuleType("company_context.store")
        store_module.ContextStore = FakeStore
        pipeline_module = types.ModuleType("news_analysis.pipeline")
        pipeline_module.analyze_news = analysis
        with patch.dict(sys.modules, {"company_context.store": store_module, "news_analysis.pipeline": pipeline_module}), patch.object(sys, "argv", argv), patch.object(sys, "path", list(sys.path)), redirect_stdout(io.StringIO()):
            runner.main()

    def test_public_artifact_has_all_30_distinct_cards_available_sources_and_explained_scores(self):
        result = json.loads((ROOT / "data/weekly_audit_20261024/results.json").read_text())
        before = json.loads((ROOT / "data/weekly_audit_20261024/results_before.json").read_text())
        self.assertEqual(result["article_count"], 10)
        self.assertEqual(result["content_sha256"], runner.digest({key: value for key, value in result.items() if key != "content_sha256"}))
        self.assertEqual({row["company_id"] for row in result["companies"]}, set(runner.COMPANIES))
        expected = set(runner.TITLES)
        cutoff = datetime.fromisoformat(result["as_of"].replace("Z", "+00:00"))
        for row in result["sources"]:
            event = row["extracted_event"]
            self.assertNotIn("text", event)
            self.assertNotIn("title", event)
            self.assertLessEqual(datetime.fromisoformat(event["published_at"].replace("Z", "+00:00")), cutoff)
            for source in event["sources"]:
                self.assertLessEqual(datetime.fromisoformat(source["published_at"].replace("Z", "+00:00")), cutoff)
                self.assertNotIn("excerpt", source)
                self.assertFalse(source["is_mock"])
            for evidence in event.get("event_details", {}).get("evidence", []):
                self.assertNotIn("quote", evidence)
                self.assertEqual(len(evidence["quote_sha256"]), 64)
        for company in result["companies"]:
            self.assertEqual(len(company["cards"]), 10)
            self.assertEqual({row["article_id"] for row in company["cards"]}, expected)
            for card in company["cards"]:
                self.assertAlmostEqual(card["score"], sum(row["contribution"] for row in card["feature_contributions"]), places=10)
        for key in ["as_of", "source_input_sha256", "company_source_provenance"]:
            self.assertEqual(result[key], before[key])
        self.assertEqual({row["company_id"]: row["profile_sha256"] for row in result["companies"]},
                         {row["company_id"]: row["profile_sha256"] for row in before["companies"]})
        self.assertEqual({row["article_id"]: row["content_sha256"] for row in result["sources"]},
                         {row["article_id"]: row["content_sha256"] for row in before["sources"]})

    def test_public_evidence_hashes_nested_primary_text_without_modifying_input(self):
        original = {"text": "PRIVATE_BODY_SENTINEL", "title": "PRIVATE_TITLE_SENTINEL", "sources": [{"id": "source:1", "excerpt": "PRIVATE_EXCERPT_SENTINEL"}], "details": {"evidence": [{"field": "direction", "quote": "PRIVATE_QUOTE_SENTINEL", "source_ids": ["source:1"]}]}}
        snapshot = copy.deepcopy(original)
        output = runner.public_evidence(original)
        self.assertNotIn("PRIVATE_", json.dumps(output))
        self.assertEqual(original, snapshot)
        self.assertEqual(output["details"]["evidence"][0]["source_ids"], ["source:1"])
        self.assertEqual(len(output["sources"][0]["excerpt_sha256"]), 64)

    def test_runner_rejects_duplicate_cards_even_when_total_count_is_correct(self):
        def duplicated(*args, **kwargs):
            result = analysis_fixture(*args, **kwargs)
            result["cards"][-1] = copy.deepcopy(result["cards"][0])
            return result
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                self.run_fixture(Path(folder), analysis=duplicated)
            self.assertFalse((Path(folder) / "results.json").exists())

    def test_failed_before_after_validation_does_not_replace_existing_outputs(self):
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            self.run_fixture(folder)
            previous = json.loads((folder / "results.json").read_text())
            previous["as_of"] = "2026-10-24T11:00:00Z"
            previous["content_sha256"] = runner.digest({key: value for key, value in previous.items() if key != "content_sha256"})
            path = folder / "previous.json"
            path.write_text(json.dumps(previous))
            original_result = b"existing reviewed public result\n"
            original_report = b"existing reviewed report\n"
            (folder / "results.json").write_bytes(original_result)
            (folder / "report.md").write_bytes(original_report)
            with self.assertRaises(ValueError):
                self.run_fixture(folder, previous=path)
            self.assertEqual((folder / "results.json").read_bytes(), original_result)
            self.assertEqual((folder / "report.md").read_bytes(), original_report)

    def test_ingestion_runner_rejects_public_output_and_symlink_escape(self):
        node = os.environ.get("NODE_BINARY") or shutil.which("node")
        if not node or not (ROOT / "node_modules/tsx").exists():
            self.skipTest("Node and installed TS runtime are needed for CLI guard regression")
        private = ROOT / "var"
        private.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="audit-export-guard-", dir=private) as inside, tempfile.TemporaryDirectory() as outside:
            link = Path(inside) / "escape"
            os.symlink(outside, link, target_is_directory=True)
            public = ROOT / "data" / (Path(inside).name + ".json")
            for output in [public, link / "events.json"]:
                with self.subTest(output=str(output)):
                    result = subprocess.run([node, "--import", "tsx", "scripts/ingest_weekly_news.ts", "--input", str(Path(inside) / "absent-input.json"), "--out", str(output)], cwd=ROOT, capture_output=True, text=True, timeout=15)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Full source text output must stay under ignored repository var/", result.stderr)
                    self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()

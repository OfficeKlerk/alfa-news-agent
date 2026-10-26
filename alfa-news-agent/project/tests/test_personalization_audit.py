"""Meaningful safeguards for the frozen, offline personalization comparison."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("personalization_evaluator", ROOT / "scripts/evaluate_personalization.py")
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def event():
    return {"news_id": "n1", "event_id": "e1", "title": "A factual announcement", "text": "A factual source excerpt",
            "event_type": "other", "published_at": "2026-01-01T00:00:00Z", "event_at": None,
            "fact_status": "reported", "okved_divisions": [], "countries": [], "regions": [], "company_ids": [],
            "entity_mapping_source": None, "is_mock": False,
            "sources": [{"id": "source:n1", "kind": "news", "title": "A factual announcement", "url": "https://example.com/news/1",
                         "excerpt": "A factual source excerpt", "document_id": None, "page": None,
                         "published_at": "2026-01-01T00:00:00Z", "is_mock": False}]}


class PredictionCoverageTests(unittest.TestCase):
    def setUp(self):
        self.labels = {"companies": {"c1": {"n1": 2, "n2": 0}}}

    def test_valid_complete_ranking(self):
        audit.validate_predictions(self.labels, {"companies": {"c1": ["n2", "n1"]}})

    def test_missing_duplicate_unknown_and_company_rejected(self):
        for predictions in ({"companies": {"c1": ["n1"]}}, {"companies": {"c1": ["n1", "n1"]}},
                            {"companies": {"c1": ["n1", "unknown"]}}, {"companies": {}}):
            with self.subTest(predictions=predictions), self.assertRaises(ValueError):
                audit.validate_predictions(self.labels, predictions)

    def test_equal_score_expectation_does_not_reward_alphabetic_order(self):
        scored = [{"news_id": "n1", "score": .1}, {"news_id": "n2", "score": .1}]
        self.assertEqual(audit.tie_expected_metrics(scored, self.labels["companies"]["c1"], 1),
                         {"ndcg@k": .5, "precision@k": .5, "recall@k": .5})

    def test_recall_without_significant_news_is_unknown(self):
        self.assertIsNone(audit.tie_expected_metrics([{"news_id": "n1", "score": 0}], {"n1": 0}, 1)["recall@k"])


class ExtractionInputTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.labels = {"companies": {"c1": {"n1": 2}}}
        audit.write(self.root / "manifest.json", {"files": {"events.json": {"sha256": "events-hash"}, "articles.json": {"sha256": "articles-hash"}}})
        self.paths = {mode: self.root / (mode + ".json") for mode in ("curated", "articles")}
        for mode, path in self.paths.items():
            audit.write(path, {"schema_version": "personalization_extraction_v1", "mode": mode,
                               "input_sha256": "events-hash" if mode == "curated" else "articles-hash",
                               "extractor_sha256": audit.sha(ROOT / "server/news-events.ts"),
                               "taxonomy_sha256": audit.sha(ROOT / "server/news-subjects.ts"),
                               "exporter_sha256": audit.sha(ROOT / "scripts/extract_personalization_events.ts"),
                               "records": [{"news_id": "n1", "before": event(), "after": event()}]})

    def load(self):
        return audit.load_exports(self.root, self.paths["curated"], self.paths["articles"], self.labels)

    def alter(self, mode, mutate):
        data = audit.read(self.paths[mode])
        mutate(data)
        audit.write(self.paths[mode], data)

    def test_valid_inputs(self):
        self.assertEqual(set(self.load()), {"curated", "articles"})

    def test_input_hash_mismatch_rejected(self):
        self.alter("curated", lambda data: data.update(input_sha256="changed"))
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            self.load()

    def test_missing_or_duplicate_news_rejected(self):
        original = audit.read(self.paths["curated"])
        for records in ([], original["records"] * 2):
            self.alter("curated", lambda data: data.update(records=records))
            with self.subTest(records=len(records)), self.assertRaisesRegex(ValueError, "matrix incomplete"):
                self.load()

    def test_no_tag_leakage_into_raw_baseline(self):
        self.alter("articles", lambda data: data["records"][0]["before"].update(okved_divisions=["46"]))
        with self.assertRaisesRegex(ValueError, "leaked extracted metadata"):
            self.load()

    def test_no_label_fields_on_public_event(self):
        self.alter("curated", lambda data: data["records"][0]["after"].update(label=3))
        with self.assertRaisesRegex(ValueError, "whitelisted"):
            self.load()

    def test_source_not_yet_available_rejected(self):
        self.alter("curated", lambda data: data["records"][0]["after"]["sources"][0].update(published_at="2026-02-01T00:00:00Z"))
        with self.assertRaisesRegex(ValueError, "source unavailable"):
            self.load()


class FrozenDatasetTests(unittest.TestCase):
    def test_committed_labels_and_exact_evidence_validate(self):
        audit.validate_bundle(ROOT / "data/personalization")

    def test_changed_frozen_label_is_rejected(self):
        original = ROOT / "data/personalization"
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "audit"
            shutil.copytree(original, target, ignore=shutil.ignore_patterns("evaluation", "__pycache__"))
            labels = audit.rows(target / "labels.jsonl")
            labels[0]["label"] = (labels[0]["label"] + 1) % 4
            (target / "labels.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in labels), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                audit.validate_bundle(target)

    def test_graph_tampering_and_raw_industry_leakage_rejected(self):
        exports = {mode: {"records": [{"news_id": "n1", "before": event(), "after": event()}]} for mode in ("curated", "articles")}
        exposure = {"company_id": "c1", "event_id": "e1", "related_company_matches": [],
                    "in": {"matched_share": 0, "attribute_coverage_share": 0},
                    "out": {"matched_share": 0, "attribute_coverage_share": 0}}
        binding = {"profiles_sha256": "profiles-hash", "graph_dependencies_sha256": {"company_context/io.py": "reviewed-numeric-helper"}}
        snapshot = {"schema_version": "personalization_graphs_v1", **binding,
                    "variants": {name: [{"news_id": "n1", "exposure": json.loads(json.dumps(exposure))}] for name in audit.VARIANTS}}
        snapshot["content_sha256"] = audit.value_sha(snapshot["variants"])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "graphs.json"
            audit.write(path, snapshot)
            audit.load_or_build_graphs(Path(tmp), exports, {"c1": {}}, binding, snapshots=path)
            # A cached graph must not outlive a change to imported arithmetic,
            # even when graph.py and the original inputs remain unchanged.
            changed_binding = {**binding, "graph_dependencies_sha256": {"company_context/io.py": "changed-numeric-helper"}}
            with self.assertRaisesRegex(ValueError, "hash/input binding mismatch"):
                audit.load_or_build_graphs(Path(tmp), exports, {"c1": {}}, changed_binding, snapshots=path)
            snapshot["variants"]["articles_v1"][0]["exposure"]["out"]["matched_share"] = .8
            audit.write(path, snapshot)
            with self.assertRaisesRegex(ValueError, "content hash mismatch"):
                audit.load_or_build_graphs(Path(tmp), exports, {"c1": {}}, binding, snapshots=path)
            snapshot["content_sha256"] = audit.value_sha(snapshot["variants"])
            audit.write(path, snapshot)
            with self.assertRaisesRegex(ValueError, "raw baseline graph leaked"):
                audit.load_or_build_graphs(Path(tmp), exports, {"c1": {}}, binding, snapshots=path)


if __name__ == "__main__":
    unittest.main()

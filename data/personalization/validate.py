"""Validate the frozen personalization audit offline; does not run a ranker."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
from pathlib import Path


def read_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def resolve(value, pointer):
    if not pointer.startswith("/"):
        raise ValueError(f"invalid JSON Pointer: {pointer}")
    for part in pointer[1:].split("/"):
        key = part.replace("~1", "/").replace("~0", "~")
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


def check(condition, message):
    if not condition:
        raise ValueError(message)


def validate(root: Path) -> dict:
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    for name, expected in manifest["files"].items():
        check(Path(name).name == name, "manifest must list only local file names")
        check(hashlib.sha256((root / name).read_bytes()).hexdigest() == expected["sha256"], f"hash mismatch: {name}")
    labels = read_rows(root / "labels.jsonl")
    check(hashlib.sha256((root / "labels.jsonl").read_bytes()).hexdigest() == manifest["label_freeze"]["sha256"], "frozen labels changed")
    profile_rows = read_rows(root / "profiles.jsonl")
    profiles = {p["company_id"]: p for p in profile_rows}
    event_rows = json.loads((root / "events.json").read_text(encoding="utf-8"))
    events = {e["event_id"]: e for e in event_rows}
    graph_rows = read_rows(root / "graph_evidence.jsonl")
    graphs = {(g["company_id"], g["event_id"]): g for g in graph_rows}
    sources = json.loads((root / "source_verification.json").read_text(encoding="utf-8"))
    articles = json.loads((root / "articles.json").read_text(encoding="utf-8"))
    template = read_rows(root / "review_template.jsonl")
    expected_pairs = {(cid, eid) for cid in profiles for eid in events}
    check(len(profiles) == len(profile_rows) == len(manifest["companies"]) == 3, "duplicate/missing profiles")
    check(set(profiles) == set(manifest["companies"]), "company selection mismatch")
    check(len(events) == len(event_rows) == manifest["events"], "duplicate/missing events")
    check(len({e["news_id"] for e in event_rows}) == len(events), "duplicate news_id")
    check(len(graph_rows) == len(graphs) == len(expected_pairs), "duplicate/missing graph records")
    check(set(graphs) == expected_pairs, "graph matrix incomplete")
    check(len(labels) == manifest["pairs"] == len(expected_pairs), "wrong annotation count")
    check({(r["company_id"], r["event_id"]) for r in labels} == expected_pairs, "annotation matrix incomplete")
    check(len(template) == len(expected_pairs) and {(r["company_id"], r["event_id"]) for r in template} == expected_pairs, "review matrix incomplete")
    check(len(sources) == len(events) and {s["event_id"] for s in sources} == set(events), "source coverage incomplete")
    check(len(articles) == len(events) and {a["article_id"] for a in articles} == {e["news_id"] for e in event_rows}, "article coverage incomplete")
    for profile in profile_rows:
        check(profile["scale"]["revenue_unit"] == "unknown" and profile["scale"]["revenue_rub"] is None, "unverified revenue units")
        check(profile["foreign_trade"]["trade_direction"] is None, "unverified trade direction")
        check(profile["provenance"]["sources"] == manifest["sources"], "source snapshot mismatch")
        check(not profile["payment_summary"]["counterparties_truncated"], "profile must preserve all observed counterparties for this small audit")
    for row in labels:
        profile = profiles[row["company_id"]]
        event = events[row["event_id"]]
        check(type(row["label"]) is int and 0 <= row["label"] <= 3, "invalid label")
        check(row["label_origin"] == "ai" and row["review_status"] == "ai_unreviewed", "initial AI labels must not masquerade as human review")
        check(row["rubric_version"] == manifest["rubric_version"], "rubric mismatch")
        check(row["as_of"] == event["published_at"], "temporal scope mismatch")
        check(datetime.fromisoformat(row["as_of"].replace("Z", "+00:00")).tzinfo is not None, "missing timezone")
        check(row["news_id"] == event["news_id"], "news/event identity mismatch")
        check(row["profile_snapshot_built_at"] == profile["provenance"]["snapshot_built_at"], "profile timestamp mismatch")
        check(row["reason"] and row["evidence"] and row["missing_data"] and row["annotator"], "missing annotation provenance")
        check(row["event_source_urls"] == [s["url"] for s in event["sources"]], "source URL mismatch")
        check(row["financial_effect"] == {"direction": "unknown", "magnitude": None}, "unsubstantiated financial outcome")
        for evidence in row["evidence"]:
            check(evidence["scope"] in {"profile", "graph"}, "unknown evidence scope")
            obj = profile if evidence["scope"] == "profile" else graphs[(row["company_id"], row["event_id"])]
            check(resolve(obj, evidence["pointer"]) == evidence["value"], f"evidence mismatch: {row['company_id']}/{row['event_id']}/{evidence['pointer']}")
    for source in sources:
        check(source["url"] in [s["url"] for s in events[source["event_id"]]["sources"]], "verification source mismatch")
        check(0 < len(source["quote"].split()) <= 25, "quote length exceeds policy")
        check(source["access_level"] in {"primary_page_read", "primary_search_extract_read"}, "missing access level")
        check(not source["independent_human_verification"], "incorrect human verification status")
    for row in template:
        check(all(row[k] is None for k in ("label", "reason", "annotator", "label_origin", "reviewed_on", "source_reviewed")), "blind template leaked answers")
        check(row["evidence"] == [] and row["missing_data"] == [], "blind template leaked rationale")
    for article in articles:
        check(not ({"label", "event_type", "semantic_context", "research_context", "score", "features"} & article.keys()), "raw extractor view leaked tags or targets")
        check(article["text_kind"] == "ai_factual_paraphrase_of_real_primary_source", "summary incorrectly labelled as original article")
    return {"companies": len(profiles), "events": len(events), "pairs": len(labels),
            "labels": dict(sorted(Counter(row["label"] for row in labels).items())),
            "human_reviewed_pairs": 0, "frozen_labels_sha256": manifest["label_freeze"]["sha256"],
            "checks": "hashes, complete matrix, exact evidence pointers, provenance, blind template, dates, source coverage"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    try:
        result = validate(args.directory)
    except (ValueError, KeyError, IndexError, TypeError, OSError) as error:
        parser.exit(1, f"Validation failed: {error}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

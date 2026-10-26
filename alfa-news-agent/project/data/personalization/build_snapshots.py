"""Export the three selected canonical profiles and graph evidence; no ranking.

Run from the repository root. This optional reconstruction requires the original
organizer snapshot. Offline evaluation uses the committed, bounded JSON exports.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from company_context import ContextStore
from news_analysis.graph import PaymentGraph


COMPANY_IDS = ("U_34911", "U_99262", "U_4909")


def write_rows(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(row, ensure_ascii=False, sort_keys=True,
                                      allow_nan=False) + "\n" for row in rows), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True)
    parser.add_argument("--events", default="data/personalization/events.json")
    parser.add_argument("--output-dir", required=True, help="A new empty directory; frozen exports are never overwritten")
    args = parser.parse_args()
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        parser.error("output-dir must be empty")
    events = json.loads(Path(args.events).read_text(encoding="utf-8"))
    with ContextStore(args.database) as store:
        profiles, graphs = [], []
        for company_id in COMPANY_IDS:
            profile = store.get_company_profile(company_id, top_n=1000)
            if profile["scale"]["revenue_unit"] != "unknown":
                parser.error("expected organizer snapshot with revenue_unit=unknown")
            profiles.append(profile)
            graph = PaymentGraph(store, company_id)
            graphs.extend(graph.exposure(event, evidence_limit=1000) for event in events)
        write_rows(output / "profiles.jsonl", profiles)
        write_rows(output / "graph_evidence.jsonl", graphs)
    print(f"Exported {len(profiles)} profiles and {len(graphs)} graph records to {output}")


if __name__ == "__main__":
    main()

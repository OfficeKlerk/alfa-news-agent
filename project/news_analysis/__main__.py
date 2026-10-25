"""CLI for backend engineers: JSON inputs, JSON artifacts, no network requests."""

import argparse
import json
import os
from pathlib import Path
import sqlite3
import tempfile

from company_context import ContextStore
from .pipeline import analyze_news, prepare_training_rows
from .ranking import LogisticRanker, train_ranker
from .scenarios import optimize_actions
from .features import FEATURE_VERSION, DEFAULT_FEATURE_VERSION


def read(path):
    def invalid_constant(value):
        raise ValueError("Nonfinite JSON: " + value)
    return json.loads(Path(path).read_text(encoding="utf-8"), parse_constant=invalid_constant)


def write(value, path=None, lines=False):
    content = ("\n".join(json.dumps(row, ensure_ascii=False, allow_nan=False) for row in value) if lines
               else json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)) + "\n"
    if path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=target.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(content)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    else:
        print(content, end="")


def protect(inputs, outputs):
    ins = {Path(p).resolve() for p in inputs if p}
    outs = [Path(p).resolve() for p in outputs if p]
    if ins.intersection(outs) or len(outs) != len(set(outs)):
        raise ValueError("Outputs must be distinct and must not overwrite input files")


def main():
    parser = argparse.ArgumentParser(description="News analysis: rank, trace and compare conditional actions")
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare-labels", help="Export JSONL pairs with label=null for human review")
    prepare.add_argument("--database", required=True)
    prepare.add_argument("--company-ids", nargs="+", required=True)
    prepare.add_argument("--events", required=True, help="JSON array of extracted events")
    prepare.add_argument("--as-of", required=True, help="ISO timestamp with timezone")
    prepare.add_argument("--output", required=True)
    prepare.add_argument("--feature-version", choices=[FEATURE_VERSION, DEFAULT_FEATURE_VERSION], default=FEATURE_VERSION)
    train = commands.add_parser("train", help="Train L2 logistic ranker on labelled JSONL")
    train.add_argument("--dataset", required=True)
    train.add_argument("--model-out", required=True)
    train.add_argument("--report-out", required=True)
    train.add_argument("--l2", nargs="+", type=float, default=[.001, .01, .1])
    train.add_argument("--iterations", type=int, default=600)
    train.add_argument("--holdout-companies", nargs="*", default=[])
    analyze = commands.add_parser("analyze", help="Build structured analysis cards")
    analyze.add_argument("--database", required=True)
    analyze.add_argument("--company-id", required=True)
    analyze.add_argument("--events", required=True)
    analyze.add_argument("--as-of", required=True)
    analyze.add_argument("--model")
    analyze.add_argument("--cases", help="JSON array of scenario inputs")
    analyze.add_argument("--bank-analytics", help="JSON array of sourced bank excerpts")
    analyze.add_argument("--limit", type=int, default=10)
    analyze.add_argument("--output")
    analyze.add_argument("--feature-version", choices=[FEATURE_VERSION, DEFAULT_FEATURE_VERSION])
    optimize = commands.add_parser("optimize", help="Compare action fractions for one scenario")
    optimize.add_argument("--case", required=True)
    optimize.add_argument("--output")
    args = parser.parse_args()
    try:
        if args.command == "prepare-labels":
            protect([args.database, args.events], [args.output])
            with ContextStore(args.database) as store:
                rows = prepare_training_rows(store, args.company_ids, read(args.events), args.as_of, args.feature_version)
            write(rows, args.output, lines=True)
        elif args.command == "train":
            protect([args.dataset], [args.model_out, args.report_out])
            rows = [json.loads(line) for line in Path(args.dataset).read_text(encoding="utf-8").splitlines() if line.strip()]
            model, report = train_ranker(rows, args.l2, args.iterations, args.holdout_companies)
            write(model.to_dict(), args.model_out)
            write(report, args.report_out)
        elif args.command == "analyze":
            protect([args.database, args.events, args.model, args.cases, args.bank_analytics], [args.output])
            model = LogisticRanker.from_dict(read(args.model)) if args.model else None
            with ContextStore(args.database) as store:
                result = analyze_news(store, args.company_id, read(args.events), args.as_of, model,
                                      read(args.cases) if args.cases else [],
                                      read(args.bank_analytics) if args.bank_analytics else [], args.limit,
                                      feature_version=args.feature_version)
            write(result, args.output)
        else:
            protect([args.case], [args.output])
            write(optimize_actions(read(args.case)), args.output)
    except (ValueError, KeyError, TypeError, OSError, sqlite3.Error) as error:
        parser.exit(2, f"Error: {error}\n")


if __name__ == "__main__":
    main()

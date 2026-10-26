"""Offline CLI; all paths are explicit and independent of the working directory."""

import argparse
import json
import sqlite3
from pathlib import Path

from .build import build_database
from .store import ContextStore


def write_json(value, destination=None):
    text = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if destination:
        path = Path(destination)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    else:
        print(text, end="")


def main():
    parser = argparse.ArgumentParser(description="Task 1: company business context")
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build", help="Build an indexed snapshot from CSV")
    build.add_argument("--companies", required=True)
    build.add_argument("--links")
    build.add_argument("--payments")
    build.add_argument("--database", required=True)
    build.add_argument("--revenue-unit", choices=["unknown", "rub", "thousand_rub"], default="unknown")
    build.add_argument("--report", help="Save source hashes and data-quality report")
    profile = sub.add_parser("profile", help="Export one company profile")
    profile.add_argument("--database", required=True)
    profile.add_argument("--company-id", required=True)
    profile.add_argument("--top-n", type=int, default=20)
    profile.add_argument("--output", help="Default: stdout")
    listing = sub.add_parser("list", help="List company IDs")
    listing.add_argument("--database", required=True)
    listing.add_argument("--limit", type=int, default=20)
    listing.add_argument("--offset", type=int, default=0)
    listing.add_argument("--large-only", action="store_true")
    audit = sub.add_parser("audit", help="Read the snapshot data-quality report")
    audit.add_argument("--database", required=True)
    args = parser.parse_args()
    try:
        if args.command == "build":
            if args.report:
                protected = [args.database, args.companies, args.links, args.payments]
                if any(value and Path(args.report).resolve() == Path(value).resolve() for value in protected):
                    raise ValueError("Report must not overwrite the database or a source CSV")
            metadata = build_database(args.companies, args.database, args.links, args.payments, args.revenue_unit)
            write_json(metadata, args.report)
        else:
            with ContextStore(args.database) as store:
                if args.command == "profile":
                    if args.output and Path(args.output).resolve() == Path(args.database).resolve():
                        raise ValueError("Output must not overwrite the database")
                    write_json(store.get_company_profile(args.company_id, args.top_n), args.output)
                elif args.command == "list":
                    write_json(store.list_companies(args.limit, args.offset, args.large_only))
                else:
                    write_json(store.metadata)
    except (OSError, ValueError, KeyError, sqlite3.Error) as error:
        parser.exit(2, f"Error: {error}\n")


if __name__ == "__main__":
    main()

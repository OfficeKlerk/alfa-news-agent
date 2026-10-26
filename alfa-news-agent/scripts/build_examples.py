"""Refresh shared request/response examples from synthetic fixtures."""
import json
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from company_context import build_database, ContextStore
from integration.contracts import envelope, validate


def main():
    fixtures = ROOT / "tests/fixtures/company_context"
    with tempfile.TemporaryDirectory(dir=ROOT) as directory:
        db = Path(directory) / "example.sqlite3"
        build_database(fixtures / "companies.csv", db, links=fixtures / "links.csv", payments=fixtures / "payments.csv", revenue_unit="unknown")
        with ContextStore(db) as store:
            profile = store.get_company_profile("U_A")
    profile["provenance"]["snapshot_built_at"] = "2026-10-23T00:00:00Z"
    # The example is a documented fixture, not a database snapshot used for live inference.
    examples = ROOT / "contracts/v1/examples"
    examples.mkdir(parents=True, exist_ok=True)
    events = json.loads((ROOT / "integration/fixtures/events.json").read_text())
    values = {"profile-response.json": ("ProfileResponse", envelope(profile, "example-001", "mock", ["synthetic_integration_data"])),
              "rank-request.json": ("RankRequest", {"company_id": "U_A", "events": events, "as_of": "2026-10-23T00:00:00Z", "limit": 10}),
              "analyze-request.json": ("AnalyzeRequest", {"company_id": "U_A", "news_id": "demo-rate", "as_of": "2026-10-23T00:00:00Z", "audience_role": "cfo"}),
              "error.json": ("Error", {"schema_version": "1.0.0", "request_id": "example-001", "error": {"code": "NOT_FOUND", "message": "Company not found", "retryable": False}})}
    for name, (schema, value) in values.items():
        validate(schema, value)
        (examples / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()

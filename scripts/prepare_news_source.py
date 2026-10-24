"""Validate the bundled news module offline against current integration contracts.

The historical sources.lock.json is provenance, not a runtime dependency.
No Git checkout or legacy source overlay is required.
"""
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from company_context import ContextStore, build_database
from integration.contracts import envelope, validate
from integration.ml import RankAdapter


def main():
    os.environ["RANK_MODE"] = "news-analysis"
    os.environ["NEWS_MODULE_PATH"] = str(ROOT)
    os.environ.pop("RANK_MODEL_PATH", None)
    adapter = RankAdapter()
    request = validate("RankRequest", json.loads(
        (ROOT / "contracts/v1/examples/rank-request.json").read_text(encoding="utf-8")))
    fixtures = ROOT / "tests/fixtures/company_context"
    scratch = ROOT / "var/source-audit"
    scratch.mkdir(parents=True, exist_ok=True)
    items_checked = 0
    with tempfile.TemporaryDirectory(prefix="bundled-", dir=scratch) as directory:
        database = Path(directory) / "context.sqlite3"
        build_database(fixtures / "companies.csv", database,
                       links=fixtures / "links.csv", payments=fixtures / "payments.csv")
        with ContextStore(database) as store:
            for company_id in ("U_A", "U_C"):
                profile = store.get_company_profile(company_id)
                validate("ProfileResponse", envelope(profile, "bundled-audit"))
                result = adapter.rank(store, {**request, "company_id": company_id})
                validate("RankDataResponse", envelope(result, "bundled-audit"))
                if not result["items"] or any(
                    item["feature_version"] != "company_event_v2"
                    or not item["feature_contributions"] for item in result["items"]
                ):
                    raise ValueError("Bundled ranker must return v2 features and explanations")
                items_checked += len(result["items"])
    print(json.dumps({"module": "bundled news_analysis", "feature_version": "company_event_v2",
                      "profiles_checked": 2, "items_checked": items_checked, "contracts": "passed"}))


if __name__ == "__main__":
    main()

"""Exercise the public HTTP surface; stdlib only so this also runs in Compose CI."""
import json
import sys
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import HTTPError


def smoke(base):
    as_of = datetime.now(timezone.utc).isoformat()
    def call(path, data=None, expected=200):
        request = Request(base.rstrip("/") + path, headers={"Content-Type": "application/json", "X-Request-ID": "smoke-001"},
                          data=None if data is None else json.dumps(data).encode())
        try:
            response = urlopen(request, timeout=30)
        except HTTPError as error:
            response = error
        with response:
            value = json.load(response)
            assert response.status == expected, (path, response.status, value)
            if expected == 200:
                assert value["meta"]["request_id"] == "smoke-001"
            return value
    call("/v1/health")
    companies = call("/v1/companies")["data"]["items"]
    assert "U_A" in companies and "U_C" in companies
    profile = call("/v1/companies/U_A")
    assert profile["data"]["scale"]["revenue_rub"] is None, "Unknown revenue units must stay unknown"
    payment_context = profile["data"]["payment_summary"]["counterparty_context"]
    assert payment_context["available"] and payment_context["method"] == "observed_payment_environment_v1"
    assert payment_context["out"]["coverage"]["industry"]["known_share"] == 0.3, "Unknown counterparties must stay in the denominator"
    events = call("/v1/tools/search_news", {"query": "", "as_of": as_of, "limit": 100, "news_id": None})["data"]["items"]
    ranked = call("/v1/rank", {"company_id": "U_A", "events": events, "as_of": as_of, "limit": 100})
    assert ranked["data"]["items"]
    for item in ranked["data"]["items"]:
        if item["score_kind"] == "manual_feature_baseline":
            assert item["feature_version"] == "company_event_v2" and item["feature_contributions"], "Current Data/ML baseline must reach the gateway"
    nid = ranked["data"]["items"][0]["news_id"]
    analysis = call("/v1/analyze", {"company_id": "U_A", "news_id": nid, "as_of": as_of, "audience_role": "cfo"})
    aid = analysis["data"]["id"]
    assert analysis["meta"]["mode"] == "mock"
    source_ids = {s["id"] for s in analysis["data"]["sources"]}
    assert all(set(c["source_ids"]) <= source_ids for c in analysis["data"]["claims"])
    company_source = next(s for s in analysis["data"]["sources"] if s["id"] == "company:U_A")
    assert json.loads(company_source["excerpt"])["payment_summary"]["counterparty_context"] == payment_context, "Analysis must keep the exact Python payment context"
    call("/v1/analyses/" + aid + "?company_id=U_A")
    call("/v1/analyses/" + aid + "?company_id=U_C", expected=404)
    for _ in range(2):
        answer = call("/v1/analyses/" + aid + "/questions", {"company_id": "U_A", "question": "Что уточнить в договорах?"})
        assert set(answer["data"]["source_ids"]) <= source_ids
    call("/v1/rank", {"company_id": "U_A", "events": events, "as_of": "2026-10-23", "limit": True}, expected=422)
    call("/v1/companies/unknown-company", expected=404)
    with urlopen(base + "/integration", timeout=5) as response:
        assert response.status == 200 and "Python" in response.read().decode()
    with urlopen(base + "/api/health", timeout=5) as response:
        assert json.load(response)["ok"]
    print("HTTP smoke passed: Python payment context/rank → Node retrieval/agent → analysis/history; exact payment block retained, legacy API and company isolation")


if __name__ == "__main__":
    smoke(sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000")

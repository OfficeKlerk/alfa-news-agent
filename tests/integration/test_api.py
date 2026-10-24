import copy
import json
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from jsonschema import ValidationError, Draft202012Validator
from integration.app import create_app
from integration.contracts import ROOT, SCHEMA, validate

EXAMPLES = ROOT / "contracts/v1/examples"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTEXT_DB", str(tmp_path / "context.sqlite3"))
    monkeypatch.setenv("CONTEXT_MODE", "fixture")
    monkeypatch.setenv("RANK_MODE", "mock")
    with TestClient(create_app()) as value:
        yield value


def rank_request():
    return json.loads((EXAMPLES / "rank-request.json").read_text())


def test_shared_schema_and_examples():
    Draft202012Validator.check_schema(SCHEMA)
    for file, schema in [("profile-response.json", "ProfileResponse"), ("rank-request.json", "RankRequest"),
                         ("analyze-request.json", "AnalyzeRequest"), ("error.json", "Error")]:
        validate(schema, json.loads((EXAMPLES / file).read_text()))


def test_profile_does_not_invent_units_or_false_values(client):
    response = client.get("/v1/companies/U_A", headers={"X-Request-ID": "python-test-01"})
    assert response.status_code == 200
    value = validate("ProfileResponse", response.json())
    assert response.headers["X-Request-ID"] == value["meta"]["request_id"] == "python-test-01"
    assert value["meta"]["mode"] == "mock"
    assert value["data"]["scale"]["revenue_rub"] is None
    unknown = client.get("/v1/companies/U_E").json()["data"]
    assert unknown["bank_products"]["loan"] is None
    assert unknown["foreign_trade"]["has_fts"] is None


def test_profile_payment_environment_matches_shared_contract(client):
    response = client.get("/v1/companies/U_A")
    assert response.status_code == 200
    profile = validate("ProfileResponse", response.json())["data"]
    context = profile["payment_summary"]["counterparty_context"]
    assert context["available"] is True
    assert context["out"]["coverage"]["company_card"]["known_share"] == 0.3
    assert context["out"]["group_distribution"]["same_group"]["amount"] == 0.3
    assert profile["provenance"]["signal_method"] == "deterministic_rules_v2"
    # Missing source metadata must not be hidden by renormalizing to known cards.
    unknown = next(row for row in context["out"]["industry_distribution"] if row["okved_division"] is None)
    assert unknown["share_of_direction"] == 0.7


def test_rank_is_personalized_and_preserves_score_kind(client):
    body = rank_request()
    a = client.post("/v1/rank", json=body)
    assert a.status_code == 200
    validate("RankDataResponse", a.json())
    assert a.json()["data"]["items"][0]["news_id"] == "demo-rate"
    body["company_id"] = "U_C"
    assert client.post("/v1/rank", json=body).json()["data"]["items"][0]["news_id"] == "demo-trade"


@pytest.mark.parametrize("field,value", [("as_of", "2026-10-23"), ("limit", True), ("limit", 0), ("limit", 101), ("extra", "unexpected")])
def test_bad_requests_use_the_common_error_contract(client, field, value):
    body = rank_request(); body[field] = value
    response = client.post("/v1/rank", json=body)
    assert response.status_code == 422
    validate("Error", response.json())


def test_news_requires_source_mapping_and_valid_dates(client):
    for mutate in [lambda e: e.update(sources=[]), lambda e: e.update(company_ids=["U_A"]),
                   lambda e: e.update(published_at="2026-10-23T00:00:00"),
                   lambda e: e["sources"][0].update(url="javascript:bad")]:
        body = rank_request(); mutate(body["events"][0])
        assert client.post("/v1/rank", json=body).status_code == 422


def test_deduplication_and_future_exclusion(client):
    body = rank_request()
    duplicate = copy.deepcopy(body["events"][0]); duplicate["news_id"] = "updated"
    duplicate["published_at"] = "2026-10-22T12:00:00Z"
    future = copy.deepcopy(body["events"][0]); future["news_id"] = "future"; future["published_at"] = "2099-01-01T00:00:00Z"
    body["events"] += [duplicate, future]
    value = client.post("/v1/rank", json=body).json()["data"]
    assert len(value["items"]) == 2
    assert value["items"][0]["news_id"] == "updated"
    assert value["excluded_future_news_ids"] == ["future"]
    body["events"].append(copy.deepcopy(body["events"][0]))
    assert client.post("/v1/rank", json=body).status_code == 422


def test_missing_entities_json_limits_and_pagination(client):
    for path in ["/v1/companies/absent", "/v1/unknown"]:
        response = client.get(path)
        assert response.status_code == 404
        validate("Error", response.json())
    assert client.get("/v1/companies?limit=0").status_code == 422
    assert client.get("/v1/companies?offset=-1").status_code == 422
    assert client.post("/v1/rank", content="{}", headers={"Content-Type": "text/plain"}).status_code == 415
    assert client.post("/v1/rank", content="{", headers={"Content-Type": "application/json"}).status_code == 400
    assert client.post("/v1/rank", content="x" * 1_000_001).status_code == 413


def test_manual_baseline_is_not_forced_into_probability_range():
    item = {"news_id": "n", "event_id": "e", "score": 3.2, "score_kind": "manual_feature_baseline",
            "reasons": [{"code": "industry_match", "text": "Industry evidence", "profile_paths": ["/industry"]}], "warnings": []}
    validate("RankedItem", item)
    item["score_kind"] = "logistic_relevance_uncalibrated"
    with pytest.raises(ValidationError):
        validate("RankedItem", item)


def test_bundled_news_module_adapter(tmp_path, monkeypatch):
    path = ROOT
    monkeypatch.setenv("CONTEXT_DB", str(tmp_path / "context.sqlite3"))
    monkeypatch.setenv("CONTEXT_MODE", "fixture")
    monkeypatch.setenv("RANK_MODE", "news-analysis")
    monkeypatch.setenv("NEWS_MODULE_PATH", str(path))
    with TestClient(create_app()) as client:
        response = client.post("/v1/rank", json=rank_request())
        assert response.status_code == 200, response.text
        data = validate("RankDataResponse", response.json())["data"]
        assert data["items"]
        assert all(x["feature_version"] == "company_event_v2" for x in data["items"])
        assert all(x["score_kind"] == "manual_feature_baseline" for x in data["items"])
        assert any(x["profile_paths"] for x in data["items"][0]["reasons"])

import json
import math
import pytest
from fastapi.testclient import TestClient
from integration.app import create_app
from integration.contracts import ROOT, validate
from integration.ml import RankAdapter
from news_analysis import LogisticRanker
from news_analysis.features import FEATURE_NAMES


@pytest.fixture
def model_file(tmp_path):
    # Constant learned score makes transport fallback to the manual baseline detectable.
    model = LogisticRanker([0.0] * len(FEATURE_NAMES), math.log(3), {"label_origin": "ai"})
    path = tmp_path / "ranker.json"
    path.write_text(json.dumps(model.to_dict()))
    return path


def configure(monkeypatch, tmp_path, model_file=None):
    monkeypatch.setenv("CONTEXT_DB", str(tmp_path / "context.sqlite3"))
    monkeypatch.setenv("CONTEXT_MODE", "fixture")
    monkeypatch.setenv("RANK_MODE", "news-analysis")
    monkeypatch.setenv("NEWS_MODULE_PATH", str(ROOT))
    monkeypatch.delenv("RANK_MODEL_PATH", raising=False)
    if model_file:
        monkeypatch.setenv("RANK_MODEL_PATH", str(model_file))


def test_api_uses_loaded_weights_and_keeps_ai_quality_warning(tmp_path, monkeypatch, model_file):
    configure(monkeypatch, tmp_path, model_file)
    body = json.loads((ROOT / "contracts/v1/examples/rank-request.json").read_text(encoding="utf-8"))
    with TestClient(create_app()) as client:
        response = client.post("/v1/rank", json=body)
        assert response.status_code == 200, response.text
        items = validate("RankDataResponse", response.json())["data"]["items"]
        assert items
        for item in items:
            assert item["score_kind"] == "logistic_relevance_uncalibrated"
            assert item["score"] == pytest.approx(0.75)
            assert "ranker_not_validated_on_human_labels" in item["warnings"]
            assert "ranking_uses_manual_baseline_no_trained_model" not in item["warnings"]


def test_no_artifact_keeps_existing_baseline(tmp_path, monkeypatch):
    configure(monkeypatch, tmp_path)
    body = json.loads((ROOT / "contracts/v1/examples/rank-request.json").read_text(encoding="utf-8"))
    with TestClient(create_app()) as client:
        items = client.post("/v1/rank", json=body).json()["data"]["items"]
        assert items and all(item["score_kind"] == "manual_feature_baseline" for item in items)


def test_bundled_module_is_default_and_exports_v2_without_an_overlay(tmp_path, monkeypatch):
    configure(monkeypatch, tmp_path)
    monkeypatch.delenv("NEWS_MODULE_PATH", raising=False)
    body = json.loads((ROOT / "contracts/v1/examples/rank-request.json").read_text(encoding="utf-8"))
    with TestClient(create_app()) as client:
        response = client.post("/v1/rank", json=body)
        assert response.status_code == 200, response.text
        items = response.json()["data"]["items"]
        assert items and all(item["feature_version"] == "company_event_v2" for item in items)
        assert all(item["feature_contributions"] for item in items)


def test_explicit_checkout_cannot_silently_reuse_another_cached_module(tmp_path, monkeypatch):
    configure(monkeypatch, tmp_path)
    package = tmp_path / "foreign/news_analysis"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("# Different checkout, intentionally not loaded\n")
    monkeypatch.setenv("NEWS_MODULE_PATH", str(package.parent))
    with pytest.raises(ValueError, match="already loaded"):
        RankAdapter()


@pytest.mark.parametrize("problem", ["missing", "invalid_json", "wrong_features", "wrong_metadata"])
def test_bad_artifact_stops_startup_instead_of_silent_fallback(tmp_path, monkeypatch, model_file, problem):
    if problem == "missing":
        model_file.unlink()
    elif problem == "invalid_json":
        model_file.write_text("{")
    else:
        artifact = json.loads(model_file.read_text(encoding="utf-8"))
        artifact["feature_version" if problem == "wrong_features" else "metadata"] = "incompatible"
        model_file.write_text(json.dumps(artifact))
    configure(monkeypatch, tmp_path, model_file)
    with pytest.raises(ValueError, match="Cannot load RANK_MODEL_PATH"):
        RankAdapter()


def test_model_path_cannot_be_ignored_in_mock_mode(monkeypatch, model_file):
    monkeypatch.setenv("RANK_MODE", "mock")
    monkeypatch.setenv("RANK_MODEL_PATH", str(model_file))
    with pytest.raises(ValueError, match="requires RANK_MODE=news-analysis"):
        RankAdapter()


def test_zero_weight_features_are_not_presented_as_personal_reasons(tmp_path, monkeypatch, model_file):
    configure(monkeypatch, tmp_path, model_file)
    body = json.loads((ROOT / "contracts/v1/examples/rank-request.json").read_text())
    with TestClient(create_app()) as client:
        response = client.post("/v1/rank", json=body)
        assert response.status_code == 200, response.text
        items = response.json()["data"]["items"]
        assert items
        for item in items:
            assert all(c["contribution"] == 0 for c in item["feature_contributions"])
            assert [reason["code"] for reason in item["reasons"]] == ["baseline"]


def test_explanations_always_correspond_to_actual_score_contributions(tmp_path, monkeypatch):
    configure(monkeypatch, tmp_path)
    body = json.loads((ROOT / "contracts/v1/examples/rank-request.json").read_text())
    with TestClient(create_app()) as client:
        response = client.post("/v1/rank", json=body)
        assert response.status_code == 200, response.text
        for item in response.json()["data"]["items"]:
            active = {c["feature"] for c in item["feature_contributions"] if c["contribution"] != 0}
            assert {r["code"] for r in item["reasons"]} == (active or {"baseline"})
            assert ("freshness_only_no_company_signal" in item["warnings"]) == (active == {"freshness"})

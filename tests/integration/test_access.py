from fastapi.testclient import TestClient
from integration.app import create_app
from integration.contracts import validate
from integration.ml import prepare_context
import pytest


def test_private_python_api_rejects_missing_wrong_and_browser_tenant_headers(monkeypatch, tmp_path):
    monkeypatch.setenv('AUTH_MODE', 'development')
    monkeypatch.setenv('INTERNAL_API_TOKEN', 'x' * 40)
    monkeypatch.setenv('CONTEXT_MODE', 'fixture')
    monkeypatch.setenv('CONTEXT_DB', str(tmp_path / 'context.sqlite3'))
    monkeypatch.setenv('RANK_MODE', 'news-analysis')
    prepare_context()
    monkeypatch.setenv('AUTH_MODE', 'oidc')
    monkeypatch.setenv('CONTEXT_MODE', 'existing')
    with TestClient(create_app()) as client:
        assert client.get('/v1/health').status_code == 200
        for headers in [{}, {'X-Internal-Token': 'wrong'}, {'X-Company-ID': 'U_A'}]:
            response = client.get('/v1/companies/U_A', headers=headers)
            assert response.status_code == 401
            validate('Error', response.json())
        assert client.get('/v1/companies/U_A', headers={'X-Internal-Token': 'x' * 40}).status_code == 200


def test_production_ml_fails_startup_without_credentials_or_with_synthetic_data(monkeypatch):
    monkeypatch.setenv('AUTH_MODE', 'oidc')
    monkeypatch.delenv('INTERNAL_API_TOKEN', raising=False)
    with pytest.raises(ValueError, match='INTERNAL_API_TOKEN'):
        with TestClient(create_app()):
            pass
    monkeypatch.setenv('INTERNAL_API_TOKEN', 'x' * 40)
    monkeypatch.setenv('CONTEXT_MODE', 'fixture')
    monkeypatch.setenv('RANK_MODE', 'mock')
    with pytest.raises(ValueError, match='Production ML'):
        with TestClient(create_app()):
            pass

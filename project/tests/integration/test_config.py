import json
from pathlib import Path
import yaml
from integration.contracts import ROOT


def test_compose_has_distinct_state_and_health_dependencies():
    config = yaml.safe_load((ROOT / "compose.yaml").read_text(encoding="utf-8"))
    services = config["services"]
    assert set(services) == {"gateway", "ml", "mocks"}
    assert services["gateway"]["depends_on"]["ml"]["condition"] == "service_healthy"
    assert all("healthcheck" in service for service in services.values())
    assert services["ml"]["volumes"] != services["gateway"]["volumes"]
    assert "ports" not in services["ml"] and "ports" not in services["mocks"]
    assert services["gateway"]["ports"][0].startswith("127.0.0.1:")


def test_workflow_runs_real_adapters_and_compose_without_secrets():
    # BaseLoader retains YAML's 'on' key rather than interpreting it as YAML 1.1 boolean.
    value = yaml.load((ROOT / ".github/workflows/integration.yml").read_text(encoding="utf-8"), Loader=yaml.BaseLoader)
    assert "pull_request" in value["on"]
    assert value["permissions"] == {"contents": "read"}
    content = (ROOT / ".github/workflows/integration.yml").read_text(encoding="utf-8")
    assert "prepare_news_source.py" in content and "AGENT_MODE=legacy" in content and "docker compose up" in content
    assert "secrets." not in content

"""Exercise Python runtime using only files declared in the Docker image."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

import pytest

from integration.contracts import ROOT


@pytest.fixture
def python_image(tmp_path):
    image = tmp_path / "image"
    image.mkdir()
    for line in (ROOT / "docker/Dockerfile.python").read_text().splitlines():
        if not line.startswith("COPY "):
            continue
        *sources, destination = shlex.split(line)[1:]
        for source in sources:
            original = ROOT / source
            target = image / destination
            if original.is_dir():
                shutil.copytree(original, target, dirs_exist_ok=True,
                                ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            else:
                target.mkdir(parents=True, exist_ok=True)
                shutil.copy2(original, target / original.name)
    return image


def run_isolated(image, code):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("CONTEXT_", "RANK_", "NEWS_", "LEARNING_"))}
    env.update(PYTHONUTF8="1", CONTEXT_MODE="fixture", RANK_MODE="mock")
    result = subprocess.run([sys.executable, "-I", "-c", code], cwd=image, env=env,
                            capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout


def test_python_image_serves_health_profile_and_rank(python_image):
    run_isolated(python_image, '''
import sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd()))
from fastapi.testclient import TestClient
from integration.app import create_app
from integration.contracts import validate
import json
with TestClient(create_app()) as client:
    for route, contract in [("/v1/health", "HealthDataResponse"),
                            ("/v1/companies/U_A", "ProfileResponse")]:
        response = client.get(route)
        assert response.status_code == 200, response.text
        validate(contract, response.json())
    body = json.loads(Path("contracts/v1/examples/rank-request.json").read_text(encoding="utf-8"))
    response = client.post("/v1/rank", json=body)
    assert response.status_code == 200, response.text
    validate("RankDataResponse", response.json())
import news_analysis
assert Path(news_analysis.__file__).resolve().is_relative_to(Path.cwd())
''')


def test_bundled_audit_requires_no_git_history(python_image):
    scripts = python_image / "scripts"
    scripts.mkdir()
    shutil.copy2(ROOT / "scripts/prepare_news_source.py", scripts)
    output = run_isolated(python_image, '''
import runpy
runpy.run_path("scripts/prepare_news_source.py", run_name="__main__")
''')
    report = json.loads(output)
    assert report["contracts"] == "passed"
    assert report["profiles_checked"] == 2
    assert report["items_checked"] > 0

"""Create the parent of pytest's configured var/pytest temp directory on a fresh checkout."""
from pathlib import Path
import os
os.environ.setdefault("AUTH_MODE", "development")


def pytest_configure():
    (Path(__file__).resolve().parents[1] / "var").mkdir(parents=True, exist_ok=True)

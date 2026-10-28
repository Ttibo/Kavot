"""Run every test against a throwaway workspace and configuration folder."""
import os
import tempfile
from pathlib import Path

_ROOT = Path(tempfile.mkdtemp(prefix="kavot-tests-"))
os.environ["KAVOT_STORAGE_PATH"] = str(_ROOT / "workspace")
os.environ["KAVOT_CONFIG_PATH"] = str(_ROOT / "config")
os.environ.pop("KAVOT_DESKTOP", None)
os.environ["KAVOT_DOTENV"] = "0"  # ignore a developer's .env

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="session")
def client():
    from app.factory import create_app
    with TestClient(create_app()) as test_client:
        yield test_client

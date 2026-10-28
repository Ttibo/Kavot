"""Installing an agent CLI runs only a fixed recipe and reports its progress."""
import sys
import time

from app.core.agents import install, sessions


def _wait(job_id: str) -> dict:
    for _ in range(200):
        job = install.get(job_id)
        if job["status"] != "running":
            return job
        time.sleep(.05)
    raise AssertionError("The installation never finished.")


def _use(monkeypatch, code: str) -> None:
    platform = "win32" if install.WINDOWS else "posix"
    monkeypatch.setitem(install.RECIPES, "codex", {platform: [
        {"needs": sys.executable, "label": "test", "command": [sys.executable, "-c", code]}]})


def test_install_reports_output_and_detected_program(monkeypatch):
    _use(monkeypatch, "print('\\x1b[32mdownloading\\x1b[0m'); print('installed')")
    monkeypatch.setattr(sessions, "_resolve_executable", lambda engine, configured="": "/bin/codex")
    assert install.plan("codex")["available"]
    job = _wait(install.start("codex")["id"])
    assert job["status"] == "done" and job["path"] == "/bin/codex"
    assert job["lines"] == ["downloading", "installed"]


def test_install_failure_is_reported(monkeypatch):
    _use(monkeypatch, "import sys; print('no network'); sys.exit(3)")
    job = _wait(install.start("codex")["id"])
    assert job["status"] == "failed" and "code 3" in job["error"] and job["lines"] == ["no network"]


def test_missing_installer_is_explained(monkeypatch, client):
    platform = "win32" if install.WINDOWS else "posix"
    monkeypatch.setitem(install.RECIPES, "opencode", {platform: [
        {"needs": "kavot-missing-tool", "label": "x", "command": ["kavot-missing-tool"]}]})
    assert client.get("/api/external-agents/settings/opencode/install").json()["available"] is False
    assert client.post("/api/external-agents/settings/opencode/install").status_code == 422

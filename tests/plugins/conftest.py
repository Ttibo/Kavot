"""An agent CLI stand-in for conversations: it records what Kavot gives it and edits the files it is told to."""
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest


class FakeAgent:
    def __init__(self, sessions):
        self.sessions, self.calls, self.edits = sessions, [], {}

    def execute(self, run, prompt, config, vendor_id, title):
        sessions = self.sessions
        space = run["space"]
        command, _ = sessions._cli_command(run, "claude", {**config, "executable": ""}, vendor_id, prompt, title, space)
        self.calls.append({"prompt": prompt, "space": space, "command": command, "vendor_id": vendor_id})
        for index, files in self.edits.items():
            for name, content in files.items():
                Path(space.writable[index], name).write_text(content)
        usage = {"input": 120, "output": 30, "cache_read": 400, "cost_usd": 0.012, "turns": 2, "duration_ms": 900}
        with sessions._lock:
            run.update(status="completed", response="Done.", vendor_id="vendor-session", usage=usage)
            sessions._record(run, usage)

    def say(self, client, session_id, text, mode="propose", **context):
        response = client.post(f"/api/external-agents/sessions/{session_id}/messages", json={"text": text, "mode": mode, "context": context})
        assert response.status_code == 202, response.text
        return response.json()

    @property
    def last(self):
        return self.calls[-1]


@pytest.fixture()
def agent(monkeypatch):
    from app.core.agents import sessions
    enabled = {engine: {"enabled": True, "executable": "", "model": "", "effort": "", "access": "read"} for engine in sessions.ENGINES}
    monkeypatch.setattr(sessions, "configuration", lambda: {engine: dict(value) for engine, value in enabled.items()})
    fake = FakeAgent(sessions)
    # Run the request in the calling thread, so it is finished when the route returns.
    now = lambda target, args, **_: type("Now", (), {"start": lambda self: target(*args)})()
    monkeypatch.setattr(sessions, "threading", SimpleNamespace(Thread=now, Timer=threading.Timer))
    monkeypatch.setattr(sessions, "_execute", fake.execute)
    return fake


@pytest.fixture()
def conversation(client):
    def create(project_id=None, engine="claude"):
        response = client.post("/api/external-agents/sessions", json={"engine": engine, "project_id": project_id})
        assert response.status_code == 201, response.text
        return response.json()["id"]
    return create

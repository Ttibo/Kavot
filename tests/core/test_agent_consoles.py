"""Agent terminals inside the app: a real pseudo-terminal, reachable only from the app's own page."""
import json
import sys
import time

import pytest
from starlette.websockets import WebSocketDisconnect

from app.core.agents import consoles, terminal

ECHO = "import sys; print('ready', flush=True); line = sys.stdin.readline(); print('got', line.strip(), flush=True)"


@pytest.fixture
def python_agent(monkeypatch):
    """An 'agent' that is a small Python program, so no CLI or model is needed."""
    monkeypatch.setattr(terminal, "agent_command", lambda engine: ([sys.executable, "-c", ECHO], terminal.settings.storage_path, {}))
    yield
    consoles.shutdown()


def read_until(socket, text, limit=200):
    seen = ""
    for _ in range(limit):
        message = json.loads(socket.receive_text())
        if message["type"] == "output":
            seen += message["data"]
        if text in seen or message["type"] == "exit":
            return seen
    return seen


def test_a_console_runs_the_agent_and_relays_keys(client, python_agent):
    created = client.post("/api/agents/consoles", json={"engine": "claude", "cols": 100, "rows": 30})
    assert created.status_code == 201, created.text
    console = created.json()
    assert console["status"] == "running" and console in client.get("/api/agents/consoles").json()
    with client.websocket_connect(f"/api/agents/consoles/{console['id']}/ws", headers={"Origin": "http://127.0.0.1:8000"}) as socket:
        assert "ready" in read_until(socket, "ready")
        socket.send_text(json.dumps({"type": "resize", "cols": 90, "rows": 20}))
        socket.send_text(json.dumps({"type": "input", "data": "hello\r"}))
        assert "got hello" in read_until(socket, "got hello")
    # Opened again (another tab, a reload), it shows the screen so far.
    for _ in range(50):
        if consoles.get(console["id"]).status == "exited":
            break
        time.sleep(0.1)
    with client.websocket_connect(f"/api/agents/consoles/{console['id']}/ws", headers={"Origin": "http://localhost:5173"}) as socket:
        assert "got hello" in read_until(socket, "got hello")
    assert client.delete(f"/api/agents/consoles/{console['id']}").status_code == 204
    assert client.get("/api/agents/consoles").json() == []


@pytest.mark.parametrize("headers", [{}, {"Origin": "https://example.com"}])
def test_other_pages_cannot_drive_a_console(client, python_agent, headers):
    console = client.post("/api/agents/consoles", json={"engine": "claude"}).json()
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(f"/api/agents/consoles/{console['id']}/ws", headers=headers) as socket:
            socket.receive_text()
    assert closed.value.code == 4403

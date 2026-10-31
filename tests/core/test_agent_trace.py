"""Every step of an agent stays readable in the thread: each call, its result, its reasoning."""
from app.core.agents import sessions


def test_parallel_calls_results_and_reasoning_are_all_kept():
    tools = {}
    calls = sessions._activity("claude", {"type": "assistant", "message": {"id": "m", "content": [
        {"type": "thinking", "thinking": "Read both notes first."},
        {"type": "text", "text": "Reading."},
        {"type": "tool_use", "id": "a", "name": "mcp__kavot__get_note", "input": {"note_id": 1}},
        {"type": "tool_use", "id": "b", "name": "mcp__kavot__get_note", "input": {"note_id": 2}}]}}, tools)
    assert [kind for kind, _, _ in calls] == ["thinking", "message", "tool", "tool"]
    assert calls[3][2] == '{"note_id": 2}'
    results = sessions._activity("claude", {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "a", "content": [{"type": "text", "text": "note one"}]},
        {"type": "tool_result", "tool_use_id": "b", "content": "failed", "is_error": True}]}}, tools)
    assert results == [("tool", "Tool result · mcp__kavot__get_note", "note one"),
                       ("error", "Tool result · mcp__kavot__get_note", "failed")]


def test_a_run_ends_only_once_its_answer_is_saved(client, monkeypatch, tmp_path):
    """A view polling the run reloads the conversation when it ends: the answer must already be there."""
    import io
    import json
    from contextlib import contextmanager
    from types import SimpleNamespace
    from app.core.agents.workspace import Workspace
    enabled = {"enabled": True, "executable": "", "model": "", "effort": "", "access": "read"}
    monkeypatch.setattr(sessions, "configuration", lambda: {engine: dict(enabled) for engine in sessions.ENGINES})
    session = sessions.create_session("claude")
    lines = [{"type": "system"}, {"type": "assistant", "message": {"id": "m", "content": [{"type": "text", "text": "Hello"}],
                                                                  "usage": {"input_tokens": 3, "output_tokens": 1}}},
             {"type": "result", "session_id": "vendor", "result": "Hello", "total_cost_usd": 0.01, "usage": {}}]
    class Process:
        returncode = 0
        def __init__(self, *args, **kwargs):
            self.stdin, self.stderr = io.StringIO(), io.StringIO("")
            self.stdout = io.StringIO("".join(json.dumps(line) + "\n" for line in lines))
        def wait(self, timeout=None):
            return 0
    seen = {}
    @contextmanager
    def serve(run, lock, emit):
        yield SimpleNamespace(token="secret", url="http://mcp")
        # Shutting the MCP server down comes before the answer is saved.
        seen["status"] = run["status"]
    monkeypatch.setattr(sessions, "_resolve_executable", lambda engine, configured="": "claude")
    monkeypatch.setattr(sessions.subprocess, "Popen", Process)
    monkeypatch.setattr(sessions.agent_mcp, "serve_run", serve)
    monkeypatch.setattr(sessions.agent_mcp, "configure_client", lambda engine, command, environment, connection: command)
    run = {"id": "run-1", "session_id": session["id"], "engine": "claude", "workspace": str(sessions.settings.storage_path.resolve()), "status": "running",
           "events": [], "event_seq": 0, "proposals": [], "mode": "answer", "space": Workspace(cwd=str(tmp_path))}
    sessions._execute(run, "Hi", {"executable": "", "model": "", "effort": "", "access": "read"}, None, "Title")
    assert seen["status"] == "running"
    assert run["status"] == "completed"
    saved = sessions.get_session(session["id"])
    assert saved["messages"][-1]["run_id"] == "run-1" and saved["messages"][-1]["content"] == "Hello"


def test_streamed_fragments_do_not_crowd_out_the_steps():
    fragment = {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": "{"}}}
    assert sessions._activity("claude", fragment) == []
    assert sessions._activity("claude", {"type": "unknown"}) is None
    run = {"events": [], "event_seq": 0}
    sessions._append_event(run, "tool", "First step")
    for _ in range(600):
        sessions._append_event(run, "raw", "noise")
    assert run["events"][0]["label"] == "First step" and len(run["events"]) == 500

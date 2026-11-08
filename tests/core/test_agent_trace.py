"""Every step of an agent stays readable in the thread: each call, its result, its reasoning."""
from app.core.agents import cli, engines, sessions, worker


def test_parallel_calls_results_and_reasoning_are_all_kept():
    tools = {}
    calls = cli.activity("claude", {"type": "assistant", "message": {"id": "m", "content": [
        {"type": "thinking", "thinking": "Read both notes first."},
        {"type": "text", "text": "Reading."},
        {"type": "tool_use", "id": "a", "name": "mcp__kavot__get_note", "input": {"note_id": 1}},
        {"type": "tool_use", "id": "b", "name": "mcp__kavot__get_note", "input": {"note_id": 2}}]}}, tools)
    assert [kind for kind, _, _ in calls] == ["thinking", "message", "tool", "tool"]
    assert calls[3][2] == '{"note_id": 2}'
    results = cli.activity("claude", {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "a", "content": [{"type": "text", "text": "note one"}]},
        {"type": "tool_result", "tool_use_id": "b", "content": "failed", "is_error": True}]}}, tools)
    assert results == [("tool", "Tool result · mcp__kavot__get_note", "note one"),
                       ("error", "Tool result · mcp__kavot__get_note", "failed")]


class FakeClaude:
    """A Claude Code process in stream-json mode: one answer per message written on stdin."""
    started = 0

    def __init__(self, command, **kwargs):
        import io
        import json
        import queue
        FakeClaude.started += 1
        self.command, self.returncode, self.costs = command, None, iter([0.01, 0.025])
        self.answers: queue.Queue = queue.Queue()
        self.stderr = io.StringIO("")
        outer = self

        class Stdin:
            def write(self, text):
                message = json.loads(text)
                prompt = message["message"]["content"][0]["text"]
                outer.answers.put([{"type": "system"},
                                   {"type": "assistant", "message": {"id": prompt, "content": [{"type": "text", "text": "Hello"}],
                                                                      "usage": {"input_tokens": 3, "output_tokens": 1}}},
                                   {"type": "result", "session_id": "vendor", "result": "Hello", "total_cost_usd": next(outer.costs), "usage": {}}])

            def flush(self):
                pass

        self.stdin = Stdin()

        class Stdout:
            def __iter__(self):
                while True:
                    lines = outer.answers.get()
                    if lines is None:
                        return
                    for line in lines:
                        yield json.dumps(line) + "\n"

        self.stdout = Stdout()

    def poll(self):
        return self.returncode

    def terminate(self):
        self.returncode = -1
        self.answers.put(None)

    kill = terminate

    def wait(self, timeout=None):
        return self.returncode


def test_a_conversation_keeps_one_claude_process_between_messages(client, monkeypatch, tmp_path):
    """Messages go to the same process (no restart, no replay); each one is saved before its run ends, and costs its own share."""
    enabled = {"enabled": True, "executable": "", "model": "", "effort": "", "access": "read"}
    monkeypatch.setattr(engines, "configuration", lambda: {engine: dict(enabled) for engine in engines.ENGINES})
    monkeypatch.setattr(engines, "resolve_executable", lambda engine, configured="", shims=True: "claude")
    from app.mcp import server as mcp_server
    mcp_server.start()  # Before Popen is replaced: the MCP SDK's modules annotate with subprocess.Popen[...].
    monkeypatch.setattr(worker.subprocess, "Popen", FakeClaude)
    FakeClaude.started = 0
    session = sessions.create_session("claude")
    config = {"executable": "", "model": "", "effort": "", "access": "read"}
    try:
        runs = []
        for number in (1, 2):
            run = {"id": f"run-{number}", "session_id": session["id"], "engine": "claude", "workspace": str(sessions.settings.storage_path.resolve()),
                   "status": "running", "events": [], "event_seq": 0, "proposals": [], "mode": "answer", "context": {},
                   "cwd": str(tmp_path)}
            sessions._execute(run, f"Hi {number}", config, "vendor" if number == 2 else None, "Title")
            runs.append(run)
            assert run["status"] == "completed", run.get("error")
            saved = sessions.get_session(session["id"])
            assert saved["messages"][-1]["run_id"] == run["id"] and saved["messages"][-1]["content"] == "Hello"
        assert FakeClaude.started == 1
        assert "--input-format" in worker._workers[session["id"]].process.command
        assert round(runs[1]["usage"]["cost_usd"], 3) == 0.015
    finally:
        sessions.shutdown()
    assert session["id"] not in worker._workers


def test_streamed_fragments_do_not_crowd_out_the_steps():
    fragment = {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": "{"}}}
    assert cli.activity("claude", fragment) == []
    assert cli.activity("claude", {"type": "unknown"}) is None
    run = {"events": [], "event_seq": 0}
    sessions._append_event(run, "tool", "First step")
    for _ in range(600):
        sessions._append_event(run, "raw", "noise")
    assert run["events"][0]["label"] == "First step" and len(run["events"]) == 500


def test_claude_compacts_at_the_same_size_whatever_the_model_window(monkeypatch):
    """The window is fixed (a 1M-token model would otherwise compact at 400k), and the share gives COMPACT_TOKENS."""
    monkeypatch.delenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW", raising=False)
    monkeypatch.delenv("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", raising=False)
    run = {"id": "run", "engine": "claude"}
    config = {"model": "", "effort": "", "access": "read"}
    _, environment = cli.command(run, "claude", config, None, "Hi", "Title")
    window = int(environment["CLAUDE_CODE_AUTO_COMPACT_WINDOW"])
    assert window * int(environment["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"]) // 100 == cli.COMPACT_TOKENS

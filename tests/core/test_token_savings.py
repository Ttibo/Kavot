"""What keeps agent requests cheap: true per-message costs, lighter models for questions,
background summaries and a get_context that names each thing once."""
import json

from app.core.agents import digests, sessions
from app.core.agents.mcp_server import compact_context
from app.core.agents.usage import Meter

DEFAULT = {"enabled": True, "executable": "", "model": "opus", "effort": "high", "access": "read",
           "answer_model": "", "answer_effort": "", "digest_model": ""}


def test_a_resumed_claude_session_costs_the_difference():
    first = Meter("claude")
    first.feed({"type": "result", "total_cost_usd": 0.34, "usage": {"input_tokens": 6}})
    assert first.value()["cost_usd"] == 0.34
    resumed = Meter("claude", first.cumulative)
    resumed.feed({"type": "result", "total_cost_usd": 0.46, "usage": {"input_tokens": 6}})
    assert round(resumed.value()["cost_usd"], 2) == 0.12 and resumed.cumulative == {"cost_usd": 0.46}
    legacy = {"engine": "claude", "usage_history": [{"cost_usd": 0.34}, {"cost_usd": 0.46}]}
    assert sessions._thread_usage(legacy) == {"cost_usd": 0.46}, "Older conversations stored the running cost"


def test_questions_run_on_the_lighter_model():
    config = {**DEFAULT, "answer_model": "haiku", "answer_effort": "low"}
    assert sessions.run_model(config, {"model": "opus", "effort": "high"}, "answer") == {"model": "haiku", "effort": "low"}
    assert sessions.run_model(config, {"model": "opus", "effort": "high"}, "propose") == {"model": "opus", "effort": "high"}
    picked = {"model": "sonnet", "effort": "medium"}
    assert sessions.run_model(config, picked, "answer") == picked, "A model picked for the conversation is kept"
    effort_only = {**DEFAULT, "answer_effort": "low"}
    assert sessions.run_model(effort_only, {"model": "opus", "effort": "high"}, "answer") == {"model": "opus", "effort": "low"}
    assert sessions.run_model(DEFAULT, {}, "answer") == {"model": "opus", "effort": "high"}


def test_get_context_names_each_source_once():
    note = {"id": "note:3", "title": "Plan", "kind": "note", "path": "notes/3.html", "note_id": 3, "source_id": "note:3",
            "href": "/?view=notes&note_id=3", "truncated": False, "evidence": "document HTML local", "content_format": "html",
            "text": "long text"}
    canvas = {"id": "file:main.canvas", "title": "main.canvas", "kind": "canvas", "path": "main.canvas", "href": "/api/x"}
    result = compact_context({"project_id": 2, "project": {"id": 2, "name": "P", "color": "#fff", "created_at": "x"},
                              "sources": [note, canvas], "target_note": {k: note[k] for k in ("id", "title", "path", "note_id")},
                              "open_documents": [{"id": "note:3", "title": "Plan", "path": "notes/3.html"}],
                              "note_catalog": [{"id": 3, "title": "Plan", "project_id": 2}, {"id": 4, "title": "Other", "project_id": 2}]})
    assert result["sources"] == [{"id": "note:3", "title": "Plan", "kind": "note"},
                                 {"id": "file:main.canvas", "title": "main.canvas", "kind": "canvas", "path": "main.canvas"}]
    assert result["target_note"] == {"id": "note:3", "title": "Plan"} and result["open_documents"] == ["note:3"]
    assert result["project"] == {"id": 2, "name": "P"}
    assert result["note_catalog"] == [{"id": 4, "title": "Other"}]
    assert "note_id=<id>" in result["links"]["note"]


def test_a_light_model_writes_the_summary_in_the_background(client, monkeypatch):
    from app.core.digest import levels, store
    from app.core.records.api import note_text
    note = client.post("/api/notes", json={"title": "Reef survey", "content": "<p>Corals bleached in 2024 at three sites.</p>"}).json()
    ref = levels.ref(note["id"])
    anchor = note_text(note["id"])[1][0]["anchor"]
    assert digests.queue(ref) is False, "Without a summary model the chat agent is still asked"
    monkeypatch.setattr(sessions, "configuration", lambda: {"claude": {**DEFAULT, "digest_model": "haiku"}})
    prompts = []
    def run(name, config, prompt):
        prompts.append(prompt)
        return "```json\n" + json.dumps({"summary": "Coral bleaching observed at three sites in 2024.",
                                          "sections": {anchor: "Bleaching at three sites.", "unknown": "dropped"},
                                          "keywords": ["coral"]}) + "\n```", {"cost_usd": 0.001}
    monkeypatch.setattr(digests, "_run", run)
    saved = digests.summarize(ref)
    assert saved["fresh"] and saved["sections"] == {anchor: "Bleaching at three sites."}
    assert saved["author"]["background"] and saved["author"]["model"] == "haiku"
    assert f"[{anchor}]" in prompts[0] and digests.summarize(ref) is None, "A current digest is not rewritten"
    store.delete(ref)

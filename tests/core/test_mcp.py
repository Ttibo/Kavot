"""The MCP server agents use from their terminal: small on every turn, live on the workspace, safe to reach."""
import asyncio
import json
import urllib.error
import urllib.request

import pytest

from app.mcp import server as mcp_server
from app.mcp.instructions import INSTRUCTIONS
from app.mcp.session import Session

# Budget in characters of the serialized tool list (about 4 characters per token).
TOOLS_BUDGET = 28_000


def new_server():
    """A server with its own session, as after an app start."""
    return mcp_server.create_server(Session())


def input_schema(tool):
    """SDK 2 renamed the attribute; SDK 1 keeps the camelCase name."""
    return tool.input_schema if hasattr(tool, "input_schema") else tool.inputSchema


def call(server, name, arguments=None):
    result = asyncio.run(server.call_tool(name, arguments or {}))
    # SDK 1 returns the content blocks (or a tuple with them); SDK 2 a CallToolResult.
    if hasattr(result, "content"):
        assert result.structured_content is None, "one text block per result, not duplicated as structured content"
        if result.is_error:
            raise RuntimeError(result.content[0].text)
        content = result.content
    else:
        content = result[0] if isinstance(result, tuple) else result
    assert len(content) == 1, "one text block per result, not duplicated as structured content"
    return content[0].text


def test_tool_definitions_fit_the_budget(client):
    tools = asyncio.run(new_server().list_tools())
    size = len(json.dumps([t.model_dump(exclude_none=True) for t in tools], separators=(",", ":")))
    assert size <= TOOLS_BUDGET, f"{size} characters for {len(tools)} tools"
    assert len(INSTRUCTIONS) < 2000


def test_schemas_are_compacted(client):
    tools = asyncio.run(new_server().list_tools())
    text = json.dumps([input_schema(t) for t in tools])
    assert '"title": "Limit"' not in text
    # Only unions with a nested object ($ref) keep an explicit null branch.
    assert text.count('{"type": "null"}') <= text.count('"$ref"')
    note = next(t for t in tools if t.name == "note_create")
    # A field called "title" is a property, not a schema annotation: it must survive.
    assert "title" in json.dumps(input_schema(note)["$defs"])


def test_results_are_compact_json(client):
    client.post("/api/notes", json={"title": "Sediment cores", "content": "<p id='x1'>Cores from the lake bed.</p>"})
    server = new_server()
    text = call(server, "search", {"query": "sediment"})
    assert "\n" not in text and ": " not in text
    hit = json.loads(text)["hits"][0]
    opened = json.loads(call(server, "read", {"ref": hit["ref"]}))
    assert "Cores from the lake bed." in opened["passages"][0]["text"]


def conversation_server(mode="propose", **context):
    """A chat request's session: the view the user was in, its mode and its proposals."""
    from app.core.agents import context as agent_context
    from app.core.kernel.config import settings
    from app.mcp import actions
    from app.mcp.session import ConversationSession
    snapshot, _, _ = agent_context.prepare({"area": "dashboard", **context}, "question")
    events = []
    run = {"id": "run", "mode": mode, "status": "running", "workspace": str(settings.storage_path.resolve()), "engine": "claude",
           "context": snapshot, "baseline": actions.baseline(snapshot), "proposals": []}
    return mcp_server.create_server(ConversationSession(run, lambda _run, *event: events.append(event))), run, events


def test_a_conversation_sees_its_view_and_proposes_changes(client):
    project = client.post("/api/projects", json={"name": "Reef survey"}).json()
    server, run, events = conversation_server(project_id=project["id"], area="project")
    context = json.loads(call(server, "get_context"))
    assert context["mode"] == "propose" and context["context"]["project"]["name"] == "Reef survey"
    result = json.loads(call(server, "apply_action", {"action": {"kind": "task_create", "label": "Add", "values": {"title": "Dive plan", "project_id": project["id"]}}}))
    assert result["status"] == "pending" and run["proposals"][0]["status"] == "pending"
    assert not any(task["title"] == "Dive plan" for task in client.get("/api/tasks").json())
    assert ("tool", "Get context", "{}") in events and any(kind == "proposal" for kind, *_ in events)
    answer, _, _ = conversation_server("answer")
    with pytest.raises(Exception, match="answer"):
        call(answer, "apply_action", {"action": {"kind": "task_create", "label": "Add", "values": {"title": "No"}}})


def test_changes_apply_at_once_and_follow_the_app(client):
    """The agent's change is saved immediately; one made in the app since the agent read the note is not overwritten."""
    server = new_server()
    result = json.loads(call(server, "note_create", {"request": {"label": "New note", "values": {
        "title": "Field log", "content": "# Field log\n\nDay one."}}}))
    assert result["status"] == "applied"
    note_id = result["result"]["id"]
    assert "Day one" in client.get(f"/api/notes/{note_id}").json()["content"]
    call(server, "read_note", {"note_id": note_id})
    client.patch(f"/api/notes/{note_id}", json={"content": "<p>Edited in the app.</p>"})
    with pytest.raises(Exception, match="changed"):
        call(server, "note_content_replace", {"request": {"label": "Rewrite", "id": note_id, "values": {"content": "<p>Agent.</p>"}}})
    assert "Edited in the app." in client.get(f"/api/notes/{note_id}").json()["content"]
    # Read again, the agent changes the current version.
    call(server, "read_note", {"note_id": note_id})
    call(server, "note_content_replace", {"request": {"label": "Rewrite", "id": note_id, "values": {"content": "<p>Agent.</p>"}}})
    assert "Agent." in client.get(f"/api/notes/{note_id}").json()["content"]


def test_items_created_in_the_app_are_visible_without_reconnecting(client):
    server = new_server()
    call(server, "list_notes")
    note = client.post("/api/notes", json={"title": "Created later", "content": "<p>Later.</p>"}).json()
    assert json.loads(call(server, "get_note", {"note_id": note["id"]}))["level"] == 1


def test_invalid_generic_action_returns_its_schema(client):
    with pytest.raises(Exception, match="Expected request.*title"):
        call(new_server(), "apply_action", {"action": {"kind": "task_create", "label": "Add", "values": {"tittle": "typo"}}})


def test_note_levels_and_digest_cycle(client):
    """A note opens brief first; a full read without a summary asks for one, which later briefs show until the note changes."""
    note = client.post("/api/notes", json={"title": "Glacier retreat", "content":
        "<h1 id='h1'>Glacier retreat</h1><p id='p1'>Retreat rates measured from satellite images.</p>"
        "<h2 id='h2'>Methods</h2><p id='p2'>Landsat series from 1990 to 2020.</p>"}).json()
    server = new_server()
    brief = json.loads(call(server, "get_note", {"note_id": note["id"]}))
    assert brief["level"] == 1 and brief["summary"].startswith("Retreat rates") and "outline" not in brief
    detail = json.loads(call(server, "get_note", {"note_id": note["id"], "level": 2}))
    assert [entry["title"] for entry in detail["outline"]][:2] == ["Glacier retreat", "Methods"]
    full = json.loads(call(server, "get_note", {"note_id": note["id"], "level": 3}))
    assert "save_digest" in full["digest"]
    again = json.loads(call(server, "get_note", {"note_id": note["id"], "level": 3}))
    assert "digest" not in again, "asked once per session"
    anchor = detail["outline"][1]["ref"].split("#", 1)[1]
    call(server, "save_digest", {"ref": brief["ref"], "summary": "Satellite-based retreat rates, 1990-2020.",
                                 "sections": {anchor: "Landsat time series."}})
    brief = json.loads(call(server, "get_note", {"note_id": note["id"]}))
    assert brief["summary_source"] == "agent digest"
    assert json.loads(call(server, "get_note", {"note_id": note["id"], "level": 2}))["outline"][1]["gist"] == "Landsat time series."
    client.patch(f"/api/notes/{note['id']}", json={"content": "<h1>Glacier retreat</h1><p>Rewritten.</p>"})
    assert json.loads(call(server, "get_note", {"note_id": note["id"]}))["summary_source"].startswith("opening sentences (the agent digest is outdated")


def test_many_changes_go_in_one_call(client):
    """Importing or deleting many items takes one turn, not one turn per item (each turn resends the conversation)."""
    result = json.loads(call(new_server(), "apply_actions", {"actions": [
        {"kind": "task_create", "label": "Add", "values": {"title": f"Read paper {number}"}} for number in range(3)
    ] + [{"kind": "task_create", "label": "Bad", "values": {"tittle": "typo"}}]}))
    assert result["count"] == 4 and result["failed"] == 1
    assert [item["status"] for item in result["results"]] == ["applied", "applied", "applied", "invalid"]
    assert "title" in result["results"][3]["error"]


def test_the_endpoint_needs_the_token_and_refuses_browsers(client):
    connection = mcp_server.start()
    try:
        for headers in ({}, {"Authorization": "Bearer " + connection.token, "Origin": "https://example.com"}):
            request = urllib.request.Request(connection.url, data=b"{}", headers={"Content-Type": "application/json", **headers})
            with pytest.raises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(request, timeout=5)
            assert error.value.code in {401, 403}
    finally:
        mcp_server.stop()


def test_a_question_only_conversation_does_not_see_the_write_tools(client):
    """In /answer the write tools cannot run: their definitions are not sent on every model call."""
    server, _, _ = conversation_server("answer")
    full = {tool.name for tool in asyncio.run(server.list_tools())}
    from app.mcp.session import ConversationSession
    reader = server
    session = ConversationSession({"status": "ended", "workspace": ""})
    session.profile = "read"
    token = mcp_server.CURRENT.set(session)
    try:
        seen = {tool.name for tool in asyncio.run(reader.list_tools())}
    finally:
        mcp_server.CURRENT.reset(token)
    assert {"note_create", "apply_actions", "canvas_edit", "list_actions"} <= full - seen
    assert {"search", "get_note", "save_digest", "get_context"} <= seen


def test_a_failed_call_is_not_repeated_and_a_request_has_a_tool_budget(client):
    server, run, _ = conversation_server("answer")
    with pytest.raises(Exception, match="not found|Unknown|exist") as first:
        call(server, "get_note", {"note_id": 987654})
    with pytest.raises(Exception, match="already failed"):
        call(server, "get_note", {"note_id": 987654})
    assert "already failed" not in str(first.value)
    run["tool_calls"] = mcp_server.TOOL_BUDGET["answer"]
    with pytest.raises(Exception, match="budget"):
        call(server, "list_notes")


def test_a_conversation_does_not_reread_what_it_already_read(client):
    """A later identical read answers "unchanged"; asked again in the same request, it is sent in full;
    get_context sends only the keys that changed; a change to the note sends it again."""
    from app.mcp import memo
    note = client.post("/api/notes", json={"title": "Lagoon", "content": "<p id='a'>" + "Coral transects. " * 60 + "</p>"}).json()
    server, run, _ = conversation_server("answer", note_id=note["id"])
    run["session_id"] = "conversation-memo"
    memo.forget("conversation-memo")
    first = call(server, "read_note", {"note_id": note["id"]})
    assert "Coral transects" in first
    run["id"] = "second-message"
    assert json.loads(call(server, "read_note", {"note_id": note["id"]}))["unchanged"] is True
    again = json.loads(call(server, "read_note", {"note_id": note["id"]}))
    assert again["html"] == json.loads(first)["html"]
    context = call(server, "get_context")
    run["id"] = "third-message"
    run["context"] = {**run["context"], "view_label": "Another view"}
    changes = json.loads(call(server, "get_context"))
    assert changes["changed"] == {"view_label": "Another view"} and len(json.dumps(changes)) < len(context)
    client.patch(f"/api/notes/{note['id']}", json={"content": "<p id='a'>" + "Seagrass beds. " * 60 + "</p>"})
    assert "Seagrass beds" in call(server, "read_note", {"note_id": note["id"]})
    memo.forget("conversation-memo")

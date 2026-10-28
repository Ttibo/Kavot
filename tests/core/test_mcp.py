"""The MCP surface an agent pays for on every turn stays small, and its reads stay scoped."""
import asyncio
import json
import threading

import pytest

from app.core.agents import actions, context as agent_context, mcp_server
from app.core.kernel.config import settings

# Budgets in characters of the serialized tool list (about 4 characters per token).
ANSWER_BUDGET = 15_000
PROPOSE_BUDGET = 32_000


def make_run(mode="answer", **context):
    snapshot, _, _ = agent_context.prepare({"area": "dashboard", **context}, "question")
    return {"id": "test", "mode": mode, "status": "running", "workspace": str(settings.storage_path.resolve()),
            "context": snapshot, "baseline": actions.baseline(snapshot), "proposals": [], "engine": "claude"}


def tools_of(run):
    server = mcp_server.create_server(run, threading.Lock(), lambda *args: None)
    return server, asyncio.run(server.list_tools())


def input_schema(tool):
    """SDK 2 renamed the attribute; SDK 1 keeps the camelCase name."""
    return tool.input_schema if hasattr(tool, "input_schema") else tool.inputSchema


def call(server, name, arguments):
    result = asyncio.run(server.call_tool(name, arguments))
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


@pytest.mark.parametrize("mode, budget", [("answer", ANSWER_BUDGET), ("propose", PROPOSE_BUDGET)])
def test_tool_definitions_fit_the_budget(client, mode, budget):
    _, tools = tools_of(make_run(mode))
    size = len(json.dumps([t.model_dump(exclude_none=True) for t in tools], separators=(",", ":")))
    assert size <= budget, f"{mode}: {size} characters for {len(tools)} tools"
    assert len(mcp_server.INSTRUCTIONS) < 2000


def test_schemas_are_compacted(client):
    _, tools = tools_of(make_run("propose"))
    text = json.dumps([input_schema(t) for t in tools])
    assert '"title": "Limit"' not in text
    # Only unions with a nested object ($ref) keep an explicit null branch.
    assert text.count('{"type": "null"}') <= text.count('"$ref"')
    task = next(t for t in tools_of(make_run("propose", area="tasks"))[1] if t.name == "task_create")
    # A field called "title" is a property, not a schema annotation: it must survive.
    assert "title" in json.dumps(input_schema(task)["$defs"])


def test_write_tools_follow_the_area(client):
    dashboard = {t.name for t in tools_of(make_run("propose"))[1]}
    calendar = {t.name for t in tools_of(make_run("propose", area="calendar"))[1]}
    assert "propose_action" in dashboard and "event_create" not in dashboard
    assert "event_create" in calendar and "task_create" in calendar


def test_results_are_compact_json(client):
    client.post("/api/notes", json={"title": "Sediment cores", "content": "<p id='x1'>Cores from the lake bed.</p>"})
    server, _ = tools_of(make_run())
    text = call(server, "search", {"query": "sediment"})
    assert "\n" not in text and ": " not in text
    hit = json.loads(text)["hits"][0]
    opened = json.loads(call(server, "read", {"ref": hit["ref"]}))
    assert "Cores from the lake bed." in opened["passages"][0]["text"]


def test_search_respects_the_request_scope(client):
    inside = client.post("/api/projects", json={"name": "Scoped"}).json()
    outside = client.post("/api/projects", json={"name": "Elsewhere"}).json()
    client.post("/api/notes", json={"title": "Moraine survey", "project_id": inside["id"], "content": "<p>moraine</p>"})
    secret = client.post("/api/notes", json={"title": "Moraine budget", "project_id": outside["id"], "content": "<p>moraine</p>"}).json()
    server, _ = tools_of(make_run(project_id=inside["id"]))
    refs = [hit["ref"] for hit in json.loads(call(server, "search", {"query": "moraine"}))["hits"]]
    assert refs and f"kavot://notes/{secret['id']}" not in refs
    with pytest.raises(Exception, match="outside"):
        call(server, "read", {"ref": f"kavot://notes/{secret['id']}"})


def test_invalid_generic_action_returns_its_schema(client):
    server, _ = tools_of(make_run("propose"))
    with pytest.raises(Exception, match="Expected request.*access_status"):
        asyncio.run(server.call_tool("propose_action", {"action": {
            "kind": "dataset_create", "label": "Add", "values": {"nme": "typo"}}}))

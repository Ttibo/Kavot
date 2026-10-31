"""Context picked in the chat page: only what the user chose, and the agent is told what it is."""
from app.core.agents import context as agent_context


def test_chat_without_picks_has_no_automatic_sources(client):
    client.post("/api/notes", json={"title": "Unrelated note", "content": "<p>x</p>"})
    snapshot, resources, _ = agent_context.prepare({"area": "chat", "view": "chat"}, "question")
    assert resources == [] and snapshot["sources"] == []


def test_picked_articles_and_collection_become_the_context(client):
    first = client.post("/api/papers", data={"title": "Picked article", "abstract": "About ice."})
    assert first.status_code in (200, 201), first.text
    picked = first.json()
    client.post("/api/papers", data={"title": "Other article"})
    client.post("/api/databases", json={"id": "samples", "name": "Samples", "record_kind": "sample"})
    client.post("/api/databases/samples/records", json={"values": {"title": "Core A"}})
    focus = [{"kind": "article", "title": "Picked article", "ref": f"kavot://articles/{picked['id']}"},
             {"kind": "collection", "title": "Samples", "ref": "kavot://collections/samples"}]
    snapshot, _, _ = agent_context.prepare({"area": "chat", "view": "chat", "paper_ids": [picked["id"]],
                                            "collection_id": "samples", "picked_collection": True, "focus": focus}, "question")
    assert [p["title"] for p in snapshot["records"]["papers"]] == ["Picked article"]
    assert [r["values"]["title"] for r in snapshot["records"]["collection"]] == ["Core A"]
    assert snapshot["focus"] == focus


def test_the_prompt_names_the_picked_context():
    from app.core.agents.sessions import focus_lines
    lines = focus_lines([{"kind": "article folder", "title": "Methods", "count": 3},
                         {"kind": "project", "title": "Reefs", "ref": "kavot://projects/2"}, "ignored"])
    assert lines == ["- article folder: Methods (3 items)", "- project: Reefs — kavot://projects/2"]


def test_tabs_that_are_not_files_do_not_block_the_context(client):
    """Pages and Atelier sections open as editor tabs; they add no source and never reject the request."""
    from app.core.agents.resources import resolve_context
    note = client.post("/api/notes", json={"title": "Open beside", "content": "<p>x</p>"}).json()
    selected, _ = resolve_context({"open_documents": [
        {"resource_path": "view/papers"}, {"resource_path": "atelier/1/code/abc"}, {"note_id": note["id"]}]})
    assert [item["id"] for item in selected] == [f"note:{note['id']}"]


def test_a_project_canvas_beside_the_agents_gives_the_project_context(client):
    """Talking from the Agents tab with a project's canvas open beside it: the project's notes are sources."""
    project = client.post("/api/projects", json={"name": "Canvas context"}).json()
    note = client.post("/api/notes", json={"title": "Project method", "content": "<p>x</p>", "project_id": project["id"]}).json()
    other = client.post("/api/notes", json={"title": "Unrelated", "content": "<p>y</p>"}).json()
    canvas = client.get("/api/projects").json()
    canvas_path = next(p for p in canvas if p["id"] == project["id"])["canvas_path"]
    snapshot, resources, _ = agent_context.prepare({"view": "notes", "area": "canvas", "canvas_path": canvas_path,
                                                    "project_id": project["id"]}, "summarize the project")
    ids = {item["id"] for item in resources}
    assert f"note:{note['id']}" in ids and f"note:{other['id']}" not in ids
    assert snapshot["canvas"]["path"] == canvas_path

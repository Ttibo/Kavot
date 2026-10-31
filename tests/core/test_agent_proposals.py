"""Proposals an agent prepares for a note: applied one by one, each on the note as it is then."""
import re


def test_several_block_proposals_for_one_note_all_apply(client):
    """An answer often proposes one insertion per section of a note: applying one must not block the others."""
    from app.core.agents import actions, context as agent_context
    from app.core.kernel.config import settings
    note = client.post("/api/notes", json={"title": "Paper notes", "content": "<h2>Summary</h2><p>.</p><h2>Key points</h2><p>.</p>"}).json()
    snapshot, _, _ = agent_context.prepare({"area": "notes", "note_id": note["id"], "target_note_id": note["id"]}, "question")
    run = {"id": "test", "mode": "propose", "status": "running", "workspace": str(settings.storage_path.resolve()),
           "context": snapshot, "baseline": actions.baseline(snapshot), "proposals": [], "engine": "claude"}
    text = actions.load_note(run, note["id"])["text"]
    blocks = re.findall(r'<h2[^>]*id="([^"]+)"', text)
    assert len(blocks) == 2, text
    first, second = (actions.prepare({"kind": "note_block_insert", "id": note["id"], "label": label,
                                      "values": {"after_block_id": block, "html": f"<p>{label}</p>"}}, run)
                     for label, block in (("Summary text", blocks[0]), ("Key points text", blocks[1])))
    actions.apply(first)
    actions.apply(second)
    content = client.get(f"/api/notes/{note['id']}").json()["content"]
    assert "Summary text" in content and "Key points text" in content
    assert content.index("Summary text") < content.index("Key points") < content.index("Key points text")


def test_a_block_that_disappeared_still_refuses(client):
    from app.core.agents import actions, context as agent_context
    from app.core.kernel.config import settings
    from fastapi import HTTPException
    note = client.post("/api/notes", json={"title": "Short notes", "content": "<h2>Only</h2><p>.</p>"}).json()
    snapshot, _, _ = agent_context.prepare({"area": "notes", "note_id": note["id"], "target_note_id": note["id"]}, "question")
    run = {"id": "test", "mode": "propose", "status": "running", "workspace": str(settings.storage_path.resolve()),
           "context": snapshot, "baseline": actions.baseline(snapshot), "proposals": [], "engine": "claude"}
    block = re.findall(r'<h2[^>]*id="([^"]+)"', actions.load_note(run, note["id"])["text"])[0]
    proposal = actions.prepare({"kind": "note_block_insert", "id": note["id"], "values": {"after_block_id": block, "html": "<p>x</p>"}}, run)
    client.patch(f"/api/notes/{note['id']}", json={"content": "<p>Rewritten</p>"})
    try:
        actions.apply(proposal)
    except HTTPException as error:
        assert error.status_code == 409
    else:
        raise AssertionError("A change anchored on a removed block must not apply.")


def test_an_editor_without_version_cannot_restore_the_text_an_agent_just_replaced(client):
    """Right after an agent's change, a client write without the version it started from is refused."""
    from app.core.agents import actions, context as agent_context
    from app.core.kernel.config import settings
    note = client.post("/api/notes", json={"title": "Guarded", "content": "<p>old</p>"}).json()
    snapshot, _, _ = agent_context.prepare({"area": "notes", "note_id": note["id"], "target_note_id": note["id"]}, "question")
    run = {"id": "test", "mode": "propose", "status": "running", "workspace": str(settings.storage_path.resolve()),
           "context": snapshot, "baseline": actions.baseline(snapshot), "proposals": [], "engine": "claude"}
    actions.load_note(run, note["id"])
    actions.apply(actions.prepare({"kind": "note_content_replace", "id": note["id"], "values": {"content": "<p>agent table</p>"}}, run))
    assert client.patch(f"/api/notes/{note['id']}", json={"content": "<p>old</p>"}).status_code == 409
    current = client.get(f"/api/notes/{note['id']}").json()
    assert "agent table" in current["content"]
    # An editor that loaded the agent's version saves normally.
    saved = client.patch(f"/api/notes/{note['id']}", json={"content": "<p>agent table, edited</p>", "expected_hash": current["content_hash"]})
    assert saved.status_code == 200, saved.text


def test_workspace_file_writes_check_the_version_read(client, tmp_path):
    """A document opened as a workspace file saves on top of the version it read, never over a newer one."""
    from app.core.kernel.config import settings
    path = "notes/general/versioned.md"
    target = settings.storage_path / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("v1", encoding="utf-8")
    read = client.get("/api/workspace/file", params={"path": path})
    version = read.headers["X-Kavot-Version"]
    target.write_text("v2 from elsewhere", encoding="utf-8")
    stale = client.put("/api/workspace/file", json={"path": path, "content": "v1 edited", "expected_version": version})
    assert stale.status_code == 409 and target.read_text(encoding="utf-8") == "v2 from elsewhere"
    fresh = client.get("/api/workspace/file", params={"path": path}).headers["X-Kavot-Version"]
    assert client.put("/api/workspace/file", json={"path": path, "content": "v2 edited", "expected_version": fresh}).status_code == 200

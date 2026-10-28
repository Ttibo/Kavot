"""Workspace map: from the workspace down to sections, with summaries kept by agents and themes."""
import asyncio
import json

import pytest

from app.core.digest import explore, store
from app.core.kernel.config import settings
from app.core.search import embeddings


@pytest.fixture(scope="module")
def mapped(client):
    project = client.post("/api/projects", json={"name": "Coral reefs", "description": "Bleaching surveys in the Pacific."}).json()
    note = client.post("/api/notes", json={"title": "Reef survey protocol", "project_id": project["id"], "content":
        "<h1 id='h-intro'>Survey protocol</h1><p id='p1'>Divers record bleaching along fixed transects.</p>"
        "<h2 id='h-gear'>Equipment</h2><p id='p2'>Each team carries a camera and a temperature logger.</p>"}).json()
    client.post("/api/databases", json={"id": "sites", "name": "Sites", "record_kind": "site", "fields": [
        {"id": "region", "name": "Region", "type": "select", "options": ["North", "South"]},
        {"id": "depth", "name": "Depth", "type": "number"}]})
    for region, depth in (("North", 5), ("North", 12), ("South", 20)):
        client.post("/api/databases/sites/records", json={"values": {"title": f"Site {depth}", "region": region, "depth": depth}})
    folder = settings.storage_path / "notes" / "data"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "temperatures.csv").write_text("site,temperature,date\nA,28.5,2026-01-03\nB,29.1,2026-01-04\nC,30.2,2026-02-01\n",
                                             encoding="utf-8")
    (folder / "field-diary.md").write_text("Day one\n\nThe lagoon water was unusually warm and turbid.", encoding="utf-8")
    client.post("/api/search/reindex")
    return {"project": project, "note": note}


def test_workspace_level_lists_collections_and_projects(mapped):
    top = explore()
    collections = {c["ref"]: c for c in top["collections"]}
    assert collections["kavot://collections/sites"]["items"] == 3 and collections["kavot://collections/files"]["items"] >= 2
    reef = next(p for p in top["projects"] if p["ref"] == f"kavot://projects/{mapped['project']['id']}")
    # The protocol note and the project's own home note.
    assert reef["gist"].startswith("Bleaching") and reef["items"] == 2
    assert top["keywords"]


def test_collection_level_profiles_the_data(mapped):
    sites = explore("kavot://collections/sites")
    columns = sites["profile"]["columns"]
    assert columns["region"]["top"] == ["North (2)", "South (1)"]
    assert columns["depth"] == {"filled": "3/3", "type": "number", "min": 5.0, "max": 20.0, "mean": 12.3333}
    assert len(sites["children"]) == 3 and all("cost" in child for child in sites["children"])


def test_item_level_outline_and_section_reading(mapped):
    note_ref = f"kavot://notes/{mapped['note']['id']}"
    card = explore(note_ref)
    assert [entry["title"] for entry in card["outline"]] == ["Survey protocol", "Equipment"]
    assert card["outline"][1]["ref"] == note_ref + "#h-gear" and card["outline"][1]["gist"].startswith("Each team")
    from app.core.records import api
    section = api.read(note_ref + "#h-gear")
    assert section["passages"][0]["text"].startswith("Equipment") and section["next"] is None
    # Any block id works as a starting point.
    assert api.read(note_ref + "#p2")["passages"][0]["anchor"] == "h-gear"


def test_files_are_indexed_profiled_and_readable(mapped, client):
    files = explore("kavot://collections/files")
    assert files["kinds"]["data"] >= 1 and files["kinds"]["text"] >= 1
    csv_ref = next(c["ref"] for c in files["children"] if c["title"] == "temperatures.csv")
    card = explore(csv_ref)
    assert card["kind"] == "data" and card["profile"]["columns"]["temperature"]["max"] == 30.2
    assert card["profile"]["columns"]["date"]["type"] == "date"
    hit = client.get("/api/search", params={"q": "turbid lagoon"}).json()["hits"][0]
    assert hit["collection"] == "files"
    from app.core.records import api
    assert "unusually warm" in " ".join(p["text"] for p in api.read(hit["ref"])["passages"])


def test_digest_replaces_the_extracted_summary_until_the_source_changes(mapped, client):
    note_ref = f"kavot://notes/{mapped['note']['id']}"
    saved = client.put("/api/digests", json={"ref": note_ref, "summary": "How divers survey bleaching on fixed transects.",
                                             "sections": {"h-gear": "Camera and temperature logger per team."}})
    assert saved.status_code == 200, saved.text
    card = explore(note_ref)
    assert card["summary"].startswith("How divers") and card["summary_by"]["kind"] == "user"
    assert card["outline"][1]["gist"] == "Camera and temperature logger per team."
    with pytest.raises(ValueError, match="Unknown section anchors"):
        store.save(note_ref, "A summary long enough to be kept.", sections={"nope": "x"})
    client.patch(f"/api/notes/{mapped['note']['id']}", json={"content": "<h1 id='h-intro'>Survey protocol</h1><p>Changed.</p>"})
    client.post("/api/search/reindex")
    stale = explore(note_ref)
    assert stale.get("stale_digest") and "summary" not in stale
    assert [d["fresh"] for d in client.get("/api/digests").json() if d["ref"] == note_ref] == [False]
    assert client.delete("/api/digests", params={"ref": note_ref}).status_code == 204


def test_agents_save_digests_and_explore_within_scope(mapped, client):
    from tests.core.test_mcp import call, make_run, tools_of
    other = client.post("/api/projects", json={"name": "Hidden"}).json()
    client.post("/api/notes", json={"title": "Hidden plan", "project_id": other["id"], "content": "<p>secret</p>"})
    run = make_run(project_id=mapped["project"]["id"])
    server = tools_of(run)[0]
    top = json.loads(call(server, "explore", {}))
    assert [p["title"] for p in top["projects"]] == ["Coral reefs"]
    note_ref = f"kavot://notes/{mapped['note']['id']}"
    call(server, "save_digest", {"ref": note_ref, "summary": "Protocol for reef bleaching surveys."})
    digest = store.get(note_ref)
    assert digest["fresh"] and digest["author"]["kind"] == "agent" and digest["author"]["run"] == "test"
    with pytest.raises(Exception, match="outside"):
        asyncio.run(server.call_tool("explore", {"ref": f"kavot://projects/{other['id']}"}))


class TopicProvider:
    """Embeddings with two clear topics, so clustering has something to find."""
    name = "test-topics"
    TOPICS = {"coral": 0, "reef": 0, "bleaching": 0, "lagoon": 0, "sleep": 1, "memory": 1, "dream": 1, "nap": 1}

    def embed(self, texts):
        result = []
        for text in texts:
            vector = [0.01, 0.01, 0.0]
            for word in text.casefold().split():
                if word.strip(".,") in self.TOPICS:
                    vector[self.TOPICS[word.strip(".,")]] += 1
            result.append(vector)
        return result


def test_themes_group_items_by_meaning(client):
    project = client.post("/api/projects", json={"name": "Themes"}).json()
    for word in ("coral reef", "reef bleaching", "coral lagoon", "bleaching reef", "sleep memory", "dream sleep", "nap memory", "memory dream"):
        client.post("/api/notes", json={"title": f"About {word}", "project_id": project["id"], "content": f"<p>{word} {word}</p>"})
    embeddings.configure(TopicProvider())
    try:
        from app.core.search.index import ensure_fresh
        index = ensure_fresh(force=True)
        while index.embed_pending():
            pass
        themes = explore(f"kavot://projects/{project['id']}")["themes"]
        # Two groups, one per topic (the project's home note has no topic and joins either).
        assert len(themes) == 2 and all(t["size"] >= 4 for t in themes)
        labels = sorted(t["label"] for t in themes)
        assert any(w in labels[0] + labels[1] for w in ("reef", "coral", "bleaching", "lagoon"))
        assert any(w in labels[0] + labels[1] for w in ("sleep", "memory", "dream", "nap"))
    finally:
        embeddings.configure(None)

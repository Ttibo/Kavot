"""Records, links, journal and search over a small workspace."""
import pytest

from app.core import journal
from app.core.search import embeddings


@pytest.fixture(scope="module")
def workspace(client):
    project = client.post("/api/projects", json={"name": "Glacier study"}).json()
    other = client.post("/api/projects", json={"name": "Teaching"}).json()
    dataset = client.post("/api/datasets", json={"name": "Alpine ice cores", "project_ids": [project["id"]]}).json()
    conference = client.post("/api/conferences", json={"name": "European Geosciences Union", "acronym": "EGU",
                                                       "dataset_ids": [dataset["id"]], "project_ids": [project["id"]]}).json()
    melt = client.post("/api/notes", json={"title": "Résumé of melt rates", "project_id": project["id"],
                                           "content": "<p id='b1'>Glaciers lose mass faster in summer.</p>"
                                                      "<p id='b2'>Albedo feedback accelerates surface melting.</p>"}).json()
    lecture = client.post("/api/notes", json={"title": "Lecture plan", "project_id": other["id"],
                                              "content": "<p>Automobile emissions and urban air.</p>"}).json()
    task = client.post("/api/tasks", json={"title": "Calibrate the ablation stakes", "project_id": project["id"]}).json()
    return {"project": project, "other": other, "dataset": dataset, "conference": conference,
            "melt": melt, "lecture": lecture, "task": task}


def test_records_api_reads_every_collection(client, workspace):
    catalog = {c["id"]: c for c in client.get("/api/records").json()}
    assert catalog["conferences"]["plugin"] == "research" and catalog["notes"]["plugin"] == "core"
    item = client.get(f"/api/records/tasks/{workspace['task']['id']}").json()
    assert item["title"] == "Calibrate the ablation stakes"
    listed = client.get("/api/records/conferences", params={"fields": ["acronym"]}).json()
    assert listed["items"] == [{"id": workspace["conference"]["id"], "acronym": "EGU"}]


def test_links_are_derived_with_provenance(client, workspace):
    project_ref = f"kavot://projects/{workspace['project']['id']}"
    links = client.get("/api/links", params={"ref": project_ref}).json()
    members = {link["ref"] for link in links["links"] if link["relation"] == "in_project"}
    assert f"kavot://notes/{workspace['melt']['id']}" in members
    assert f"kavot://tasks/{workspace['task']['id']}" in members
    conference = client.get("/api/links", params={"ref": f"kavot://conferences/{workspace['conference']['id']}",
                                                  "relation": "uses_dataset"}).json()
    assert conference["links"][0]["ref"] == f"kavot://datasets/{workspace['dataset']['id']}"
    assert conference["links"][0]["provenance"] == "field:conferences.dataset_ids"


def test_journal_records_author(client, workspace):
    entries = client.get("/api/history", params={"ref": f"kavot://tasks/{workspace['task']['id']}"}).json()
    assert entries[0]["op"] == "create" and entries[0]["author"]["kind"] == "user"
    with journal.author("agent", run="r1"):
        client.patch(f"/api/tasks/{workspace['task']['id']}", json={"status": "doing"})
    latest = journal.history(f"kavot://tasks/{workspace['task']['id']}", limit=1)[0]
    assert latest["op"] == "update" and latest["author"] == {"kind": "agent", "run": "r1"}


def test_search_stages(client, workspace):
    melt = f"kavot://notes/{workspace['melt']['id']}"
    # Accents and case are ignored.
    hits = client.get("/api/search", params={"q": "resume melt"}).json()
    assert hits["hits"][0]["ref"] == melt and hits["stages"][0] == "lexical"
    # A passage deeper in the note is found and addressed by its block.
    albedo = client.get("/api/search", params={"q": "albedo"}).json()["hits"][0]
    assert albedo["ref"].startswith(melt) and "«Albedo»" in albedo["snippet"]
    # Partial words fall back to trigram matching.
    fuzzy = client.get("/api/search", params={"q": "ablat"}).json()
    assert fuzzy["hits"][0]["collection"] == "tasks"
    # Typos too, without matching unrelated words that only share a suffix.
    typo = client.get("/api/search", params={"q": "calibrte"}).json()
    assert typo["stages"] == ["fuzzy"] and typo["hits"][0]["collection"] == "tasks"
    assert client.get("/api/search", params={"q": "nation"}).json()["hits"] == []
    # Filters by collection and project.
    scoped = client.get("/api/search", params={"q": "plan", "project_id": workspace["project"]["id"]}).json()
    assert all(workspace["project"]["id"] in hit.get("project_ids", []) for hit in scoped["hits"])
    only = client.get("/api/search", params={"q": "EGU", "collections": ["conferences"]}).json()
    assert [hit["collection"] for hit in only["hits"]] == ["conferences"]


def test_index_follows_changes(client, workspace):
    client.patch(f"/api/notes/{workspace['lecture']['id']}", json={"content": "<p>Permafrost thaw in the Arctic.</p>"})
    hits = client.get("/api/search", params={"q": "permafrost"}).json()["hits"]
    assert hits and hits[0]["ref"] == f"kavot://notes/{workspace['lecture']['id']}"


class MeaningProvider:
    """Tiny embedding model: words with the same meaning share a dimension."""
    name = "test-meaning"
    MEANINGS = {"car": 0, "automobile": 0, "vehicle": 0, "ice": 1, "glacier": 1, "glaciers": 1, "permafrost": 1}

    def embed(self, texts):
        vectors = []
        for text in texts:
            vector = [0.0, 0.0, 0.01]
            for word in text.casefold().replace(".", " ").split():
                if word in self.MEANINGS:
                    vector[self.MEANINGS[word]] += 1.0
            vectors.append(vector)
        return vectors


def test_semantic_stage_finds_meaning_without_shared_words(client, workspace):
    embeddings.configure(MeaningProvider())
    try:
        client.patch(f"/api/notes/{workspace['lecture']['id']}", json={"content": "<p>Automobile emissions and urban air.</p>"})
        client.post("/api/search/reindex")
        from app.core.search.index import get
        while get().embed_pending():
            pass
        result = client.get("/api/search", params={"q": "car", "mode": "semantic"}).json()
        assert result["stages"] == ["semantic"]
        assert result["hits"][0]["ref"] == f"kavot://notes/{workspace['lecture']['id']}"
    finally:
        embeddings.configure(None)


def test_read_by_address(workspace):
    from app.core.records import api
    note = api.read(f"kavot://notes/{workspace['melt']['id']}")
    assert note["passages"][0]["anchor"] == "b1" and "Albedo" in note["passages"][0]["text"]
    conference = api.read(f"kavot://conferences/{workspace['conference']['id']}", fields=["acronym"])
    assert conference["item"] == {"id": workspace["conference"]["id"], "acronym": "EGU"}


def test_script_blocks_keep_no_block_ids_inside():
    """The editor treats a script block as one node: ids inside it made every script note look unsaved."""
    from app.core.workspace import html_documents, note_format
    block = note_format.script_block("Demo", "<div></div>", "", "console.log(1 < 2)")
    stored = "<p>Before</p>" + block.replace("<pre", '<pre id="b-old"', 1)
    once = html_documents.fragment(stored)
    assert 'id="b-old"' not in once and once.count(' id="') == 2  # the paragraph and the block itself
    assert html_documents.fragment(once) == once

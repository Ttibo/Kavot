"""Markdown dropped in the notes folder becomes regular notes, and the .md file is removed."""
from app.core.kernel.config import settings
from app.core.projects import projects
from app.core.records.repository import store
from app.core.workspace import html_documents as html_docs
from app.core.workspace.documents import note_path
from app.core.workspace.markdown_import import import_markdown_notes, register_orphan_documents, split_frontmatter


def _note(note_id):
    return next(note for note in store.read()["notes"] if note["id"] == note_id)


def _project(project_id):
    return next(project for project in store.read()["projects"] if project["id"] == project_id)


def test_frontmatter_becomes_properties():
    properties, body = split_frontmatter("---\ntitle: Plan\ntags: [a, b]\naliases:\n  - x\n  - y\n---\n# Body\n")
    assert properties == {"title": "Plan", "tags": "a, b", "aliases": "x, y"}
    assert body == "# Body\n"


def test_markdown_files_become_notes_in_matching_folders(client):
    root = settings.notes_path / "general" / "Cours" / "Maths"
    root.mkdir(parents=True, exist_ok=True)
    (root / "algebre.md").write_text("# Algèbre linéaire\n\nVoir [[geometrie|la géométrie]] et [suite](geometrie.md).\n\n- [ ] exercice\n", encoding="utf-8")
    (root / "geometrie.md").write_text("---\nauteur: Moi\n---\nSans titre ici, $x^2$.\n", encoding="utf-8")
    loose = settings.notes_path / "vrac.md"
    loose.write_text("Une note posée à la racine.", encoding="utf-8")

    ids = import_markdown_notes(settle=0)

    assert len(ids) >= 3  # other tests of the session may have left Markdown files in notes/
    assert not list(settings.notes_path.rglob("*.md")), "imported Markdown files are deleted"
    state = store.read()
    notes = {note["title"]: note for note in state["notes"] if note["id"] in ids}
    algebra, geometry, loose_note = notes["Algèbre linéaire"], notes["geometrie"], notes["vrac"]

    maths = next(f for f in state["note_folders"] if f["id"] == algebra["folder_id"])
    cours = next(f for f in state["note_folders"] if f["id"] == maths["parent_id"])
    assert (maths["name"], cours["name"], cours["parent_id"], maths["project_id"]) == ("Maths", "Cours", None, None)
    assert geometry["folder_id"] == algebra["folder_id"] and loose_note["folder_id"] is None

    path = note_path(algebra, state)
    assert path.suffix == ".html" and path.is_file()
    content = client.get(f"/api/notes/{algebra['id']}").json()["content"]
    assert f'href="#note-{geometry["id"]}"' in content and "la géométrie" in content
    assert 'type="checkbox"' in content or "taskList" in content or "task-list" in content

    geometry_html = note_path(geometry, state).read_text(encoding="utf-8")
    assert html_docs.metadata(geometry_html)["properties"] == {"auteur": "Moi"}
    assert 'data-type="math"' in geometry_html and "<h1" in geometry_html

    # Backups are kept before deletion, and a second scan finds nothing to do.
    assert list((settings.storage_path / ".meta_kavot" / "imports" / "markdown").rglob("algebre.md"))
    assert import_markdown_notes(settle=0) == []


def test_project_folder_markdown_goes_to_the_project(client):
    project = client.post("/api/projects", json={"name": "Thèse import"}).json()
    folder = settings.notes_path / "projects" / projects.directory(_project(project["id"])).name
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / "chapitre-1.md"
    target.write_text("# Chapitre 1\n\nIntroduction.", encoding="utf-8")

    [note_id] = import_markdown_notes(settle=0)

    note = _note(note_id)
    assert note["project_id"] == project["id"] and note["folder_id"] is None and not target.exists()


def test_files_still_being_written_wait(client):
    path = settings.notes_path / "general" / "en-cours.md"
    path.write_text("# En cours", encoding="utf-8")
    assert import_markdown_notes(settle=60) == [] and path.exists()
    assert len(import_markdown_notes(settle=0)) == 1 and not path.exists()


def test_orphan_html_documents_are_catalogued(client):
    folder = settings.notes_path / "general" / "Archives"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / "ancienne.html"
    target.write_text(html_docs.serialize({"title": "Ancienne", "document_uid": "orphan-uid-1"}, "<p>Texte</p>", target, store.read()), encoding="utf-8")

    [note_id] = register_orphan_documents()

    note = _note(note_id)
    assert note["title"] == "Ancienne" and note_path(note, store.read()).resolve() == target.resolve()
    assert next(f for f in store.read()["note_folders"] if f["id"] == note["folder_id"])["name"] == "Archives"
    assert register_orphan_documents() == []

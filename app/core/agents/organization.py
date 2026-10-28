"""Reviewable organization operations. Only the chat approval path calls execute."""
from __future__ import annotations

import copy
import hashlib
import shutil
import uuid
from pathlib import Path

from fastapi import HTTPException
from pydantic import BaseModel, Field

from app.core.kernel.config import settings
from app.core.kernel.files import atomic_write_json, atomic_write_text, read_json_object
from app.models.documents import NoteFolderCreate, NoteFolderUpdate, DatabaseCreate, DatabaseFolderCreate, DatabaseAppearanceUpdate
from app.plugins.papers.models import PaperFolderCreate, PaperFolderUpdate
from app.models.projects import ProjectUpdate
from app.core.records import databases
from app.core.workspace import documents
from app.plugins.papers import library
from app.core.records.repository import store


class Empty(BaseModel):
    pass


class NoteOrganize(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=240)
    project_id: int | None = None
    folder_id: int | None = None


class RecordOrganize(BaseModel):
    folder_id: str | None = None


class PaperOrganize(BaseModel):
    folder_ids: list[int] | None = None
    project_ids: list[int] | None = None


class CollectionUpdate(DatabaseAppearanceUpdate):
    """Rename a collection or change its icon, field schema and content template."""


class FolderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    parent_id: str | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


class FileCreate(BaseModel):
    name: str = Field(min_length=1, max_length=240)
    content: str = Field(default="", max_length=100_000)
    project_id: int | None = None
    folder_id: int | None = None


class FileRename(BaseModel):
    name: str = Field(min_length=1, max_length=240)


class FileMove(BaseModel):
    project_id: int | None = None
    folder_id: int | None = None


SCHEMAS = {
    "note_organize": NoteOrganize, "note_delete": Empty,
    "note_folder_create": NoteFolderCreate, "note_folder_update": NoteFolderUpdate, "note_folder_delete": Empty,
    "paper_folder_create": PaperFolderCreate, "paper_folder_update": PaperFolderUpdate, "paper_folder_delete": Empty,
    "project_update": ProjectUpdate, "project_delete": Empty,
    "paper_delete": Empty, "task_delete": Empty, "event_delete": Empty,
    "dataset_delete": Empty, "conference_delete": Empty,
    "collection_create": DatabaseCreate, "collection_update": CollectionUpdate, "collection_delete": Empty,
    "collection_folder_create": DatabaseFolderCreate, "collection_folder_update": FolderUpdate, "collection_folder_delete": Empty,
    "record_delete": Empty, "record_organize": RecordOrganize, "paper_organize": PaperOrganize,
    "file_create": FileCreate, "file_rename": FileRename, "file_move": FileMove, "file_delete": Empty,
}
COLLECTIONS = {"note": "notes", "note_folder": "note_folders", "paper_folder": "paper_folders",
               "project": "projects", "paper": "papers", "task": "tasks", "event": "calendar_events",
               "dataset": "datasets", "conference": "conferences"}


def capture(context):
    state = store.read()
    project_id = context.get("project_id")
    excluded = set(context.get("excluded_resource_ids") or [])
    def visible(domain, item):
        if f"{domain}:{item['id']}" in excluded:
            return False
        if domain == "note" and f"paper:{item.get('paper_id')}" in excluded:
            return False
        if not project_id or domain == "paper_folder":
            return True
        if domain == "project":
            return item["id"] == project_id
        return item.get("project_id") == project_id or project_id in item.get("project_ids", [])
    result = {key: [copy.deepcopy(i) for i in state.get(key, []) if visible(domain, i)]
              for domain, key in COLLECTIONS.items()}
    result["collections"] = [copy.deepcopy(d) for d in databases.list_databases()
                             if not project_id or d["id"] == context.get("collection_id")]
    result["collection_records"] = {d["id"]: [r for p in databases.path(d["id"]).parent.joinpath("items").glob("*.json") if (r := read_json_object(p)) and (not project_id or project_id in r.get("values", {}).get("project_ids", []))]
                                    for d in result["collections"] if d.get("storage", {}).get("driver") == "json-files"}
    result["files"] = {}
    for source in context.get("sources", []):
        if source.get("note_id") or source.get("paper_id") or source.get("read_only"):
            continue
        path = source.get("path", "")
        if Path(path).suffix.lower() not in {".html", ".md", ".txt", ".csv", ".pdf", ".png", ".jpg", ".jpeg", ".webp"}:
            continue
        try:
            result["files"][path] = file_state(path)
        except (ValueError, HTTPException, FileNotFoundError):
            continue
    return result


def public(snapshot):
    result = copy.deepcopy(snapshot)
    for key in COLLECTIONS.values():
        result[key] = [{k: v for k, v in item.items() if k in {
            "id", "title", "name", "project_id", "project_ids", "folder_id", "folder_ids", "parent_id", "color", "status"}}
            for item in result[key]]
    # Content is still read through read_source; discovery only exposes organization.
    result["collection_records"] = {key: [{"id": r["id"], "folder_id": r.get("folder_id"),
        "title": r.get("values", {}).get("title", "")} for r in rows] for key, rows in result["collection_records"].items()}
    return result


def file_state(path):
    from app.core.agents.resources import workspace_file
    raw = settings.storage_path.resolve() / path
    if any(p.is_symlink() for p in (raw, *[p for p in raw.parents if p != settings.storage_path.resolve() and p.is_relative_to(settings.storage_path.resolve())])):
        raise ValueError("Symbolic links cannot be changed.")
    source = workspace_file(path)
    if not source.is_file():
        raise ValueError("File missing or not editable.")
    digest = hashlib.sha256()
    with source.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return {"path": path, "sha256": digest.hexdigest(), "size": source.stat().st_size}


def find(rows, identifier):
    item = next((i for i in rows if str(i["id"]) == str(identifier)), None)
    if item is None:
        raise ValueError("Object outside the scope. Read get_organization.")
    return copy.deepcopy(item)


def descendants(rows, identifier):
    ids = {identifier}
    while True:
        children = {r["id"] for r in rows if r.get("parent_id") in ids}
        if children <= ids:
            return ids
        ids.update(children)


def validate_parent(rows, identifier, values, current=None):
    parent_id = values.get("parent_id")
    if parent_id is None:
        return
    parent = find(rows, parent_id)
    if identifier is not None and parent_id in descendants(rows, identifier):
        raise ValueError("A folder cannot contain one of its ancestors.")
    if current is not None and parent.get("project_id") != current.get("project_id"):
        raise ValueError("The parent must belong to the same project.")


def describe(action, snapshot, context):
    kind, values = action["kind"], action["values"]
    domain, operation = kind.rsplit("_", 1)
    identifier = action.get("id")
    project_id = context.get("project_id")
    if "project_id" in values and project_id and values["project_id"] != project_id:
        raise ValueError("Destination project outside the context.")
    if domain == "file":
        if operation == "create":
            if (Path(values["name"]).name != values["name"] or "\\" in values["name"] or values["name"].startswith(".")) or Path(values["name"]).suffix.lower() not in {".html", ".txt", ".md", ".csv"}:
                raise ValueError("Create an .html document or a .txt, .md or .csv file with a simple name.")
            destination(values, snapshot)
            return None, values, values["name"]
        before = snapshot["files"].get(action.get("path"))
        if before is None:
            raise ValueError("File not in the selected sources.")
        if operation == "rename" and ((Path(values["name"]).name != values["name"] or "\\" in values["name"] or values["name"].startswith(".")) or Path(values["name"]).suffix.lower() not in {".html", ".md", ".txt", ".csv", ".pdf", ".png", ".jpg", ".jpeg", ".webp"}):
            raise ValueError("Invalid file name or unsupported extension.")
        if operation == "move":
            destination(values, snapshot)
        return before, None if operation == "delete" else {**before, **values}, action["path"]
    if domain.startswith("collection") or domain == "record":
        if kind == "collection_create":
            if any(d["id"] == values["id"] for d in snapshot["collections"]):
                raise ValueError("This collection already exists.")
            return None, values, values["name"]
        database_id = action.get("database_id")
        definition = find(snapshot["collections"], database_id)
        rows = snapshot["collection_records"].get(database_id, [])
        if domain == "collection":
            if database_id in {d["id"] for d in databases.builtins()}:
                raise ValueError("Built-in collections cannot be renamed or deleted.")
            before = {"definition": definition, "records": rows}
            after = None if operation == "delete" else {**before, "definition": {**definition, **values}}
            return before, after, definition["name"]
        if domain == "record":
            before = find(rows, identifier)
            if values.get("folder_id") is not None:
                find(definition["organization"]["folders"], values["folder_id"])
            title = str(before.get("values", {}).get("title") or identifier)
            return before, None if operation == "delete" else {**before, **values}, title
        folders = definition["organization"]["folders"]
        if operation == "create":
            validate_parent(folders, None, values)
            return None, values, values["name"]
        folder = find(folders, identifier)
        validate_parent(folders, identifier, values)
        # Show all affected records and subfolders before approval.
        ids = descendants(folders, identifier)
        before = {"folder": folder, "folders": [f for f in folders if f["id"] in ids],
                  "records": [r for r in rows if r.get("folder_id") in ids]}
        return before, None if operation == "delete" else {**before, "folder": {**folder, **values}}, folder["name"]
    key = COLLECTIONS[domain]
    rows = snapshot[key]
    if any(values.get(field) is None for field in ("name", "title", "color", "status") if field in values):
        raise ValueError("Names, titles, colors and statuses cannot be null.")
    if operation == "create":
        if domain == "note_folder":
            destination({"project_id": values.get("project_id")}, snapshot)
        validate_parent(rows, None, values, values if domain == "note_folder" else None)
        return None, values, values["name"]
    before = find(rows, identifier)
    if domain == "note" and documents.note_path(before, store.read()).name == "relations.generated.html":
        raise ValueError("This generated note is read-only.")
    if domain == "note" and before.get("trashed_at"):
        raise ValueError("This note is in the trash.")
    if domain == "paper" and operation == "organize":
        if any(value is None for value in values.values()):
            raise ValueError("Use an empty list to remove the associated folders or projects.")
        for folder_id in values.get("folder_ids") or []:
            find(snapshot["paper_folders"], folder_id)
        for target_id in values.get("project_ids") or []:
            find(snapshot["projects"], target_id)
    if domain == "note" and operation == "organize":
        destination({**before, **values}, snapshot)
    if domain.endswith("_folder"):
        validate_parent(rows, identifier, values, before if domain == "note_folder" else None)
        ids = descendants(rows, before["id"])
        affected = snapshot["notes" if domain == "note_folder" else "papers"]
        before = {"folder": before, "folders": [f for f in rows if f["id"] in ids],
                  "items": [i for i in affected if i.get("folder_id") in ids or ids.intersection(i.get("folder_ids", []))]}
        after = None if operation == "delete" else {**before, "folder": {**before["folder"], **values}}
    else:
        after = None if operation == "delete" else {**before, **values}
    if kind == "paper_delete":
        before = {"paper": before, "notes": [n for n in snapshot["notes"] if n.get("paper_id") == identifier]}
    if kind == "project_delete":
        before = {"project": before, "affected": {k: [i for i in snapshot[k] if i.get("project_id") == identifier or identifier in i.get("project_ids", [])]
                  for k in COLLECTIONS.values() if k != "projects"}}
    return before, after, str((before.get("folder") or before.get("project") or before.get("paper") or before).get("title") or
                              (before.get("folder") or before.get("project") or before.get("paper") or before).get("name") or identifier)


def destination(values, snapshot):
    project_id, folder_id = values.get("project_id"), values.get("folder_id")
    if project_id is not None:
        find(snapshot["projects"], project_id)
    if folder_id is not None:
        folder = find(snapshot["note_folders"], folder_id)
        if folder.get("project_id") != project_id:
            raise ValueError("The folder is not in the destination project.")
    root = documents.notes_directory(store.read(), project_id, folder_id)
    if not root.resolve().is_relative_to(settings.storage_path.resolve()):
        raise ValueError("Destination hors du workspace.")


def execute(action):
    # Reuse the application domain handlers, including trash and reference cleanup.
    from app.api.routes import documents as doc_routes, projects as project_routes
    from app.plugins.papers.routes import library as paper_routes
    from app.api.routes import databases as db_routes
    from app.plugins.planning import routes as tasks, calendar_routes as calendar
    from app.plugins.research import routes as research
    from app.models.documents import NoteUpdate
    kind, values = action["kind"], action["values"]
    domain, operation = kind.rsplit("_", 1)
    identifier = action.get("id")
    payload = SCHEMAS[kind].model_validate(values)
    if domain == "file":
        if operation == "create":
            root = documents.notes_directory(store.read(), values.get("project_id"), values.get("folder_id"))
            target = root / values["name"]
            if target.exists():
                raise HTTPException(409, "This file already exists.")
            if target.suffix == '.html':
                from app.core.workspace.html_documents import serialize
                atomic_write_text(target, serialize({'title': target.stem}, values.get('content', ''), target, store.read()))
            else:
                atomic_write_text(target, values.get("content", ""))
            return {"path": target.relative_to(settings.storage_path).as_posix(), "kind": kind}
        model, handler = {"rename": (doc_routes.WorkspaceRename, doc_routes.rename_workspace_item),
                          "move": (doc_routes.WorkspaceMove, doc_routes.move_workspace_item),
                          "delete": (doc_routes.WorkspaceTrash, doc_routes.trash_workspace_item)}[operation]
        return {**handler(model(path=action["path"], **values)), "kind": kind}
    if domain == "collection" or domain == "collection_folder":
        database_id = action.get("database_id")
        if kind == "collection_create":
            result = databases.create(values)
        else:
            definition = databases.load(database_id)
            if domain == "collection":
                if operation == "delete":
                    target = settings.notes_path / ".trash" / uuid.uuid4().hex / database_id
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(databases.path(database_id).parent), str(target))
                    return {"id": database_id, "kind": kind}
                # The domain service keeps field types stable for existing records.
                return {"id": databases.update(database_id, values)["id"], "kind": kind}
            else:
                folders = definition["organization"]["folders"]
                if operation == "create":
                    result = {"id": uuid.uuid4().hex, **values}
                    folders.append(result)
                elif operation == "update":
                    result = next(f for f in folders if str(f["id"]) == str(identifier))
                    result.update(values)
                else:
                    ids = descendants(folders, identifier)
                    definition["organization"]["folders"] = [f for f in folders if f["id"] not in ids]
                    for record in databases.records(database_id):
                        if record.get("folder_id") in ids:
                            databases.save_record(database_id, {"folder_id": None}, record["id"])
                    result = {"id": identifier}
            atomic_write_json(databases.path(database_id), definition)
    elif domain == "record":
        if operation == "delete":
            db_routes.delete_record(action["database_id"], str(identifier))
        else:
            databases.save_record(action["database_id"], values, str(identifier))
        result = {"id": identifier}
    else:
        handlers = {
            "note_organize": lambda: documents.update_note(int(identifier), NoteUpdate(**values)),
            "note_delete": lambda: documents.delete_note(int(identifier)),
            "note_folder_create": lambda: doc_routes.create_note_folder(payload),
            "note_folder_update": lambda: doc_routes.update_note_folder(int(identifier), payload),
            "note_folder_delete": lambda: doc_routes.delete_note_folder(int(identifier)),
            "paper_folder_create": lambda: paper_routes.create_folder(payload),
            "paper_folder_update": lambda: paper_routes.update_folder(int(identifier), payload),
            "paper_folder_delete": lambda: paper_routes.delete_folder(int(identifier)),
            "project_update": lambda: project_routes.update_project(int(identifier), payload),
            "project_delete": lambda: project_routes.delete_project(int(identifier)),
            "paper_organize": lambda: library.update_paper(int(identifier), values),
            "paper_delete": lambda: library.delete_paper(int(identifier)),
            "task_delete": lambda: tasks.delete_task(int(identifier)),
            "event_delete": lambda: calendar.delete_event(int(identifier)),
            "dataset_delete": lambda: research.delete_dataset(int(identifier)),
            "conference_delete": lambda: research.delete_conference(int(identifier)),
        }
        result = handlers[kind]()
    return {"id": result.get("id") if isinstance(result, dict) else identifier, "kind": kind}


def check_impact(action, before, context):
    """A cascade must not touch data hidden by the captured scope/exclusions."""
    if action["kind"].endswith("_delete"):
        affected = guard(action, before)
        excluded = set(context.get("excluded_resource_ids") or [])
        if any("file:" + path in excluded for path in affected["files"]):
            raise ValueError("This deletion affects an excluded file.")
    if action["kind"] not in {"project_delete", "note_folder_delete", "note_folder_update", "paper_folder_delete", "paper_delete", "collection_delete", "collection_folder_delete", "record_delete"}:
        return
    unrestricted = capture({})
    complete, _, _ = describe(action, unrestricted, {})
    if complete != before:
        raise ValueError("This operation affects items outside the context or excluded. Widen the selection.")
    if action["kind"] == "paper_delete":
        excluded = set(context.get("excluded_resource_ids") or [])
        if any(f"note:{n['id']}" in excluded for n in unrestricted["notes"] if n.get("paper_id") == action["id"]):
            raise ValueError("The deletion affects an excluded note.")


def guard(action, before):
    """Fingerprint on-disk content and dependencies that cascades can remove."""
    from app.core.projects import projects
    kind = action["kind"]
    state = store.read()
    paths = []
    notes = []
    if kind.startswith("note_folder_") and before:
        notes = before["items"]
    elif kind in {"note_delete", "note_organize"}:
        notes = [before]
    elif kind == "project_delete":
        root = projects.directory(before["project"])
        paths.extend(p for p in root.rglob("*") if p.is_file())
        notes = before["affected"].get("notes", [])
    elif kind == "paper_delete":
        paths.extend(p for p in library.paper_directory(before["paper"]).rglob("*") if p.is_file())
        notes = [n for n in state["notes"] if n.get("paper_id") == action["id"]]
    elif kind == "collection_delete":
        paths.extend(p for p in databases.path(action["database_id"]).parent.rglob("*") if p.is_file())
    for note in notes:
        paths.append(documents.note_path(note, state))
    result = {"notes": notes, "files": {}}
    for path in sorted(set(paths)):
        if not path.resolve().is_relative_to(settings.storage_path.resolve()):
            raise ValueError("Affected file is outside the workspace.")
        if path.is_file():
            relative = path.relative_to(settings.storage_path).as_posix()
            result["files"][relative] = file_state(relative)
    return result


def scope(context):
    result = {k: copy.deepcopy(v) for k, v in context.items() if k in {"project_id", "collection_id", "excluded_resource_ids"}}
    result["sources"] = [{k: v for k, v in s.items() if k in {"id", "path", "note_id", "paper_id", "read_only"}}
                         for s in context.get("sources", [])]
    return result


def deletion_effect(kind):
    return {
        "note_delete": "The note will be moved to the trash.",
        "file_delete": "The file will be moved to the trash.",
        "note_folder_delete": "The folder and its subfolders will be deleted; their notes will be moved to the trash.",
        "paper_folder_delete": "The folders will be deleted; the articles are kept and removed from these folders.",
        "paper_delete": "The article, its PDF, its notes and its references will be permanently deleted.",
        "project_delete": "The project, its files, its notes and its tasks will be permanently deleted. Articles, conferences and datasets will be detached from the project.",
        "collection_delete": "The collection and its files will be moved to notes/.trash for manual recovery.",
        "collection_folder_delete": "The folders will be deleted; their records are kept at the root of the collection.",
    }.get(kind, "This item will be deleted after approval.")

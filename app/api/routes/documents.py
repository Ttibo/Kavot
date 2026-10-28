from __future__ import annotations

import json
import mimetypes
import shutil
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel, Field

from app.core.kernel.config import settings
from app.core.kernel.files import atomic_write_json, atomic_write_text, resolve_inside, safe_name
from app.models.documents import (
    NoteCreate, NoteFolderCreate, NoteFolderUpdate, NotePlacementUpdate, NoteUpdate,
    NoteTemplateApply, NoteTemplateCreate, NoteTemplatePreview, NoteTemplateUpdate,
)
from app.core.workspace import documents, web_preview, asset_metadata
from app.core.projects import projects
from app.core.projects import canvas_store as canvas_tasks
from app.core.workspace import html_documents
from app.core.records.repository import json_values, now, store


router = APIRouter(tags=["documents"])


class WorkspaceWrite(BaseModel):
    path: str
    content: Any


class WorkspaceRename(BaseModel):
    path: str
    name: str = Field(min_length=1, max_length=240)


class WorkspaceMove(BaseModel):
    path: str
    project_id: int | None = None
    folder_id: int | None = None


class WorkspaceTrash(BaseModel):
    path: str


class CanvasCreate(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    project_id: int | None = None
    folder_id: int | None = None


class LinkPreviewRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)







@router.post("/workspace/link-preview")
def preview_web_link(payload: LinkPreviewRequest) -> dict[str, Any]:
    return web_preview.link_preview(payload.url)


def workspace_path(value: str) -> Path:
    roots = {
        "projects": settings.projects_path,
        "library": settings.library_path,
        "notes": settings.notes_path,
        "databases": settings.databases_path,
    }
    parts = Path(value).parts
    if not parts or parts[0] not in roots:
        raise HTTPException(status_code=422, detail="Invalid workspace path")
    try:
        return resolve_inside(roots[parts[0]], str(Path(*parts[1:])))
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


def protect_generated_note(path: Path) -> None:
    from app.core.projects.overview import is_overview
    if is_overview(path):
        raise HTTPException(409, "This relational note is generated from the project canvas and is read-only")


def protect_project_note_path(path: Path) -> None:
    state = store.read()
    target = path.resolve()
    for note in state["notes"]:
        if note.get("system_kind") != "project_home" or note.get("trashed_at"):
            continue
        home = documents.note_path(note, state).resolve()
        if home == target or home.is_relative_to(target):
            raise HTTPException(409, "The project note cannot be moved or deleted")


def virtual_path(path: Path) -> str:
    for prefix, root in (("projects", settings.projects_path), ("library", settings.library_path), ("notes", settings.notes_path), ("databases", settings.databases_path)):
        try:
            return f"{prefix}/{path.resolve().relative_to(root.resolve()).as_posix()}"
        except ValueError:
            continue
    raise HTTPException(status_code=422, detail="File is outside the workspace")


@router.get("/notes")
def notes(project_id: int | None = None, paper_id: int | None = None) -> list[dict[str, Any]]:
    return documents.list_notes(project_id, paper_id)


@router.post("/notes", status_code=201)
def create_note(payload: NoteCreate) -> dict[str, Any]:
    return documents.create_note(payload)


@router.get("/notes/{note_id}")
def get_note(note_id: int) -> dict[str, Any]:
    state = store.read()
    note = store.find("notes", note_id, "Note")
    path = documents.note_path(note, state)
    if not note.get("trashed_at") and path.is_file():
        note["content"] = html_documents.read(path.read_text(encoding="utf-8"), path)
    return documents.enrich_note(note, state)


@router.patch("/notes/{note_id}")
def update_note(note_id: int, payload: NoteUpdate) -> dict[str, Any]:
    return documents.update_note(note_id, payload)


@router.delete("/notes/{note_id}", status_code=204)
def delete_note(note_id: int) -> Response:
    documents.delete_note(note_id)
    return Response(status_code=204)


@router.post("/notes/{note_id}/template/{template_id}")
def apply_note_template(
    note_id: int, template_id: int, payload: NoteTemplateApply,
) -> dict[str, Any]:
    return documents.apply_note_template(note_id, template_id, payload)


@router.post("/notes/{note_id}/assets", status_code=201)
def upload_note_asset(note_id: int, file: UploadFile = File(...), cursor: int | None = Form(None)) -> dict[str, Any]:
    note = store.find("notes", note_id, "Note")
    from app.core.records.migrations import import_file
    result = import_file(file, project_id=note.get("project_id"), note_id=note_id)
    if cursor is not None:
        content = documents.enrich_note(note, store.read()).get('content', '')
        content = html_documents.insert(content, result['markdown'], cursor)
        updated = documents.update_note(note_id, NoteUpdate(content=content))
        result.update(content=updated['content'], note=updated, insertion_end=len(updated['content'].encode('utf-16-le')) // 2)
    return result


@router.get("/notes/{note_id}/assets/{filename}")
def note_asset(note_id: int, filename: str) -> FileResponse:
    path = documents.asset_path(note_id, filename)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")
    return FileResponse(path)


@router.get("/note-folders")
def note_folders() -> list[dict[str, Any]]:
    state = store.read()
    return [{**item, "note_count": sum(note.get("folder_id") == item["id"] and not note.get("trashed_at") for note in state["notes"])} for item in state["note_folders"]]


@router.post("/note-folders", status_code=201)
def create_note_folder(payload: NoteFolderCreate) -> dict[str, Any]:
    values = json_values(payload)
    parent_id = values.get("parent_id")
    if parent_id is not None:
        parent = store.find("note_folders", parent_id, "Parent note folder")
        if parent.get("project_id") != values.get("project_id"):
            raise HTTPException(status_code=422, detail="Parent folder must be in the same notes workspace")
    return store.create("note_folders", values)


@router.patch("/note-folders/{folder_id}")
def update_note_folder(folder_id: int, payload: NoteFolderUpdate) -> dict[str, Any]:
    values = json_values(payload, exclude_unset=True)
    with store.transaction() as state:
        folder = next((item for item in state["note_folders"] if item["id"] == folder_id), None)
        if not folder:
            raise HTTPException(status_code=404, detail="Note folder not found")
        if values.get("parent_id") == folder_id:
            raise HTTPException(status_code=422, detail="A folder cannot contain itself")
        if "parent_id" in values and values["parent_id"] is not None:
            parent = next((item for item in state["note_folders"] if item["id"] == values["parent_id"]), None)
            if not parent:
                raise HTTPException(status_code=404, detail="Parent note folder not found")
            if parent.get("project_id") != folder.get("project_id"):
                raise HTTPException(status_code=422, detail="Parent folder must be in the same notes workspace")
            ancestor = parent
            seen: set[int] = set()
            while ancestor and ancestor["id"] not in seen:
                if ancestor["id"] == folder_id:
                    raise HTTPException(status_code=422, detail="A folder cannot be moved inside one of its descendants")
                seen.add(ancestor["id"])
                ancestor = next(
                    (item for item in state["note_folders"] if item["id"] == ancestor.get("parent_id")),
                    None,
                )
        previous = {note["id"]: documents.note_path(note, state) for note in state["notes"]}
        folder.update(values)
        folder["updated_at"] = now()
        moved: set[int] = set()
        for note in state["notes"]:
            current = documents.note_path(note, state)
            if previous[note["id"]] != current and previous[note["id"]].is_file():
                documents.write_note(note, state, previous[note["id"]], refresh_links=False)
                moved.add(note["id"])
        # One pass for the whole folder instead of one per moved note.
        if moved:
            documents.refresh_document_links(state, moved)
        return dict(folder)


@router.delete("/note-folders/{folder_id}", status_code=204)
def delete_note_folder(folder_id: int) -> Response:
    with store.transaction() as state:
        if not any(item["id"] == folder_id for item in state["note_folders"]):
            raise HTTPException(status_code=404, detail="Note folder not found")
        descendants = {folder_id}
        while True:
            children = {item["id"] for item in state["note_folders"] if item.get("parent_id") in descendants}
            if children <= descendants:
                break
            descendants.update(children)
        for note in state["notes"]:
            if note.get("folder_id") in descendants:
                documents.trash_note(note, state)
                note["folder_id"] = None
                for project in state["projects"]:
                    projects.remove_note_reference(project, note["id"])
        state["note_folders"] = [item for item in state["note_folders"] if item["id"] not in descendants]
    return Response(status_code=204)


@router.get("/note-placements")
def placements() -> list[dict[str, Any]]:
    return store.list("note_placements")


@router.put("/note-placements/{note_id}")
def place_note(note_id: int, payload: NotePlacementUpdate) -> dict[str, Any]:
    store.find("notes", note_id, "Note")
    values = json_values(payload)
    with store.transaction() as state:
        item = next((row for row in state["note_placements"] if row.get("note_id") == note_id and row.get("project_id") == payload.project_id), None)
        if item:
            item.update(values)
        else:
            item = {"id": store.next_id(state, "note_placements"), "note_id": note_id, **values}
            state["note_placements"].append(item)
        return item


@router.get("/note-templates")
def templates() -> list[dict[str, Any]]:
    return store.list("note_templates")


@router.post("/note-templates", status_code=201)
def create_template(payload: NoteTemplateCreate) -> dict[str, Any]:
    values = json_values(payload)
    with store.transaction() as state:
        if values.get("is_article_default"):
            for item in state["note_templates"]:
                item["is_article_default"] = False
        template = {**values, "id": store.next_id(state, "note_templates"), "revision": 1,
                    "archived": False, "created_at": now(), "updated_at": now()}
        state["note_templates"].append(template)
        return dict(template)


@router.patch("/note-templates/{template_id}")
def update_template(template_id: int, payload: NoteTemplateUpdate) -> dict[str, Any]:
    values = json_values(payload, exclude_unset=True)
    if any(value is None for value in values.values()):
        raise HTTPException(422, "Template properties cannot be null")
    with store.transaction() as state:
        template = next((item for item in state["note_templates"] if item["id"] == template_id), None)
        if not template:
            raise HTTPException(404, "Template not found")
        if values.get("archived", template.get("archived")):
            values.update(is_article_default=False, auto_create=False)
        if values.get("is_article_default"):
            for item in state["note_templates"]:
                item["is_article_default"] = False
        template.update(values)
        template["revision"] = template.get("revision", 1) + 1
        template["updated_at"] = now()
        return dict(template)


@router.delete("/note-templates/{template_id}", status_code=204)
def delete_template(template_id: int) -> Response:
    # Keep the ID and presentation metadata for cards already using this template.
    update_template(template_id, NoteTemplateUpdate(archived=True))
    return Response(status_code=204)


@router.post("/note-templates/preview")
def preview_template(payload: NoteTemplatePreview) -> dict[str, str]:
    state = store.read()
    project = next((item for item in state["projects"] if item["id"] == payload.project_id), {})
    paper = next((item for item in state["papers"] if item["id"] == payload.paper_id), {})
    return {
        "title": documents.render_template(payload.title_template, project, paper, state),
        "content": documents.render_template(payload.content_template, project, paper, state),
    }


@router.get("/workspace/tree")
def workspace_tree() -> list[dict[str, Any]]:
    return documents.workspace_tree()


@router.get("/workspace/file")
def read_workspace_file(path: str):
    # Derived metadata is readable, but deliberately excluded from workspace mutation roots.
    if Path(path).parts and Path(path).parts[0] == ".meta_kavot":
        try:
            target = resolve_inside(settings.storage_path / ".meta_kavot", str(Path(*Path(path).parts[1:])))
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
    else:
        target = workspace_path(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    if target.suffix.lower() in {".md", ".txt"}:
        return PlainTextResponse(target.read_text(encoding="utf-8"))
    if target.suffix.lower() == '.html':
        # Source is fetched as text by the editor. Direct previews are inert.
        source = target.read_text(encoding='utf-8')
        clean = html_documents.serialize(html_documents.metadata(source), html_documents.read(source, target), target, store.read())
        return Response(clean, media_type='text/html', headers={'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data: https:; media-src 'self' https:; style-src 'unsafe-inline'"})
    return FileResponse(target, media_type=mimetypes.guess_type(target.name)[0])


@router.put("/workspace/file")
def write_workspace_file(payload: WorkspaceWrite) -> dict[str, Any]:
    target = workspace_path(payload.path)
    protect_generated_note(target)
    if target.suffix == ".canvas":
        if not isinstance(payload.content, dict):
            raise HTTPException(status_code=422, detail="Canvas content must be an object")
        canvas_tasks.save(target, payload.content)
        return {"path": payload.path, "name": target.name, "content": payload.content}
    else:
        state = store.read()
        note = next((item for item in state["notes"] if documents.note_path(item, state) == target), None)
        if note:
            documents.update_note(note['id'], NoteUpdate(content=str(payload.content)))
        elif target.suffix.lower() == '.html':
            meta = html_documents.metadata(target.read_text(encoding='utf-8')) if target.exists() else {'title': target.stem}
            atomic_write_text(target, html_documents.serialize(meta, str(payload.content), target, state))
        else:
            atomic_write_text(target, str(payload.content))
    return {"path": payload.path, "name": target.name}


@router.post("/workspace/file", status_code=201)
def upload_workspace_file(file: UploadFile = File(...), project_id: int | None = Form(None), folder_id: int | None = Form(None), target_path: str | None = Form(None)) -> dict[str, Any]:
    from app.core.records.migrations import import_file
    return import_file(file, project_id=project_id, folder_id=folder_id, target_path=target_path)


@router.post("/workspace/canvas", status_code=201)
def create_canvas(payload: CanvasCreate) -> dict[str, str]:
    # Projects keep their single project canvas; free canvases live in General.
    if payload.project_id:
        raise HTTPException(403, "Additional project canvases cannot be created. Use the project canvas.")
    state = store.read()
    root = documents.notes_directory(state, None, payload.folder_id)
    root.mkdir(parents=True, exist_ok=True)
    stem = safe_name(payload.title, "canvas")
    target = root / f"{stem}.canvas"
    counter = 2
    while target.exists():
        target = root / f"{stem}-{counter}.canvas"
        counter += 1
    atomic_write_json(target, {"schemaVersion": 1, "title": payload.title, "nodes": [], "edges": []})
    return {"path": virtual_path(target), "name": target.name, "kind": "canvas"}


@router.put("/workspace/canvas")
def save_canvas(payload: WorkspaceWrite) -> dict[str, Any]:
    return write_workspace_file(payload)


@router.post("/workspace/canvas/image", status_code=201)
@router.post("/workspace/canvas/asset", status_code=201)
def upload_canvas_asset(file: UploadFile = File(...), canvas_path: str = Form(...)) -> dict[str, Any]:
    canvas = workspace_path(canvas_path)
    from app.core.records.migrations import import_file
    state = store.read()
    project_id = next((p["id"] for p in state["projects"] if canvas.resolve().is_relative_to(projects.directory(p).resolve())), None)
    return import_file(file, project_id=project_id, canvas_path=canvas_path)


@router.patch("/workspace/item")
def rename_workspace_item(payload: WorkspaceRename) -> dict[str, str]:
    source = workspace_path(payload.path)
    protect_generated_note(source)
    protect_project_note_path(source)
    if not source.exists():
        raise HTTPException(status_code=404, detail="Item not found")
    suffix = source.suffix if source.is_file() and not Path(payload.name).suffix else ""
    target = source.with_name(f"{safe_name(payload.name, 'item')}{suffix}")
    if source.resolve() == target.resolve():
        return {"path": virtual_path(source), "name": source.name, "kind": source.suffix.lstrip(".") or "directory"}
    if target.exists():
        raise HTTPException(409, "An item with this name already exists")
    asset_metadata.move(source, target)
    return {"path": virtual_path(target), "name": target.name, "kind": target.suffix.lstrip(".") or "directory"}


@router.post("/workspace/move")
def move_workspace_item(payload: WorkspaceMove) -> dict[str, str]:
    source = workspace_path(payload.path)
    protect_generated_note(source)
    protect_project_note_path(source)
    if not source.exists():
        raise HTTPException(status_code=404, detail="Item not found")
    state = store.read()
    root = documents.notes_directory(state, payload.project_id, payload.folder_id)
    root.mkdir(parents=True, exist_ok=True)
    target = root / source.name
    if source.resolve() == target.resolve():
        return {"path": virtual_path(source), "name": source.name, "kind": source.suffix.lstrip(".") or "directory"}
    if target.exists():
        raise HTTPException(status_code=409, detail="An item with this name already exists in the destination")
    if source.is_dir() and root.resolve().is_relative_to(source.resolve()):
        raise HTTPException(status_code=422, detail="A folder cannot be moved inside itself")
    asset_metadata.move(source, target)
    return {"path": virtual_path(target), "name": target.name, "kind": target.suffix.lstrip(".") or "directory"}


@router.post("/workspace/trash")
def trash_workspace_item(payload: WorkspaceTrash) -> dict[str, str]:
    state = store.read()
    target = workspace_path(payload.path)
    protect_generated_note(target)
    protect_project_note_path(target)
    note = next((item for item in state["notes"] if documents.note_path(item, state) == target), None)
    if note:
        documents.delete_note(note["id"])
        return {"trash_id": store.find("notes", note["id"])["trash_id"]}
    if not target.exists():
        raise HTTPException(status_code=404, detail="Item not found")
    trash_id = uuid.uuid4().hex
    destination = settings.notes_path / ".trash" / trash_id / target.name
    destination.parent.mkdir(parents=True, exist_ok=True)
    asset_metadata.move(target, destination)
    atomic_write_json(destination.parent / "trash.kavot.json", {"id": trash_id, "original_path": payload.path, "name": target.name})
    return {"trash_id": trash_id}


@router.post("/workspace/trash/{trash_id}/restore")
def restore_workspace_item(trash_id: str) -> dict[str, str]:
    with store.transaction() as state:
        note = next((item for item in state["notes"] if item.get("trash_id") == trash_id), None)
        if note:
            previous = Path(note.get("trash_file_path") or note.get("original_file_path") or "")
            if previous.is_file():
                raw = previous.read_text(encoding='utf-8')
                note['content'] = html_documents.read(raw) if previous.suffix == '.html' else html_documents.fragment(raw, markdown=True)
            note["trashed_at"] = None
            note["trash_id"] = None
            note["original_file_path"] = None
            note["trash_file_path"] = None
            documents.write_note(note, state, previous if previous.is_file() else None)
            target = documents.note_path(note, state)
            if previous.parent.is_dir() and previous.parent.parent == settings.notes_path / ".trash":
                shutil.rmtree(previous.parent, ignore_errors=True)
            return {"path": virtual_path(target), "name": target.name}
    root = settings.notes_path / ".trash" / safe_name(trash_id, "")
    metadata = json.loads((root / "trash.kavot.json").read_text(encoding="utf-8")) if (root / "trash.kavot.json").is_file() else None
    if not metadata:
        raise HTTPException(status_code=404, detail="Trash item not found")
    source = next((item for item in root.iterdir() if item.name != "trash.kavot.json"), None)
    target = workspace_path(metadata["original_path"])
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise HTTPException(409, "An item with this name already exists")
    asset_metadata.move(source, target)
    shutil.rmtree(root)
    return {"path": metadata["original_path"], "name": target.name}


@router.delete("/workspace/trash/{trash_id}", status_code=204)
def delete_workspace_item(trash_id: str) -> Response:
    with store.transaction() as state:
        note = next((item for item in state["notes"] if item.get("trash_id") == trash_id), None)
        if note:
            target = Path(note.get("trash_file_path") or note.get("original_file_path") or "")
            if target.is_file():
                target.unlink()
            if target.parent.is_dir() and target.parent.parent == settings.notes_path / ".trash":
                shutil.rmtree(target.parent, ignore_errors=True)
        before = len(state["notes"])
        state["notes"] = [item for item in state["notes"] if item.get("trash_id") != trash_id]
        if len(state["notes"]) != before:
            return Response(status_code=204)
    root = settings.notes_path / ".trash" / safe_name(trash_id, "")
    if not root.is_dir():
        raise HTTPException(status_code=404, detail="Trash item not found")
    asset_metadata.remove(root)
    shutil.rmtree(root)
    return Response(status_code=204)

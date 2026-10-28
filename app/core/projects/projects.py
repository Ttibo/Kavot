from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

from fastapi import HTTPException

from app.core.kernel.config import settings
from app.core.kernel.files import atomic_write_json, prefixed_entry, read_json_object, safe_name
from app.core.records.repository import json_values, now, store
from app.models.projects import ProjectCreate


MANIFEST = "project.kavot.json"
CANVAS = "main.canvas"
RELATIONS = "relations.kavot.json"
REFERENCES = "references.kavot.json"


def directory(project: dict[str, Any]) -> Path:
    existing = prefixed_entry(settings.projects_path, project['id'])
    return existing or settings.projects_path / f"{project['id']}-{safe_name(project['name'], 'project')}"


def paths(project: dict[str, Any]) -> dict[str, Path]:
    root = directory(project)
    return {"directory": root, "manifest": root / MANIFEST, "canvas": root / CANVAS, "relations": root / RELATIONS, "references": root / REFERENCES}


def _canvas(project: dict[str, Any], uid: str) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "projectId": project["id"],
        "projectUid": uid,
        "title": project["name"],
        "nodes": [],
        "edges": [],
    }


def initialize_project_note(project: dict[str, Any]) -> dict[str, Any]:
    """Create the editable project note and make it the sole initial canvas card."""
    from app.models.documents import NoteCreate
    from app.core.workspace import documents

    canvas_path = paths(project)["canvas"]
    canvas = read_json_object(canvas_path)
    objective = str(project.get("description") or "").strip()
    content = f"# {project['name']}\n\n## Objectif\n\n{objective}\n"
    note = documents.create_note(NoteCreate(
        project_id=project["id"], title=project["name"], content=content,
    ), system_kind="project_home")
    canvas["nodes"] = [{
        "id": f"project-note-{note['id']}", "type": "note", "noteId": note["id"],
        "title": note["title"], "color": project.get("color", "#087e86"),
        "x": 1750, "y": 1150, "width": 520, "height": 340,
    }]
    canvas["edges"] = []
    atomic_write_json(canvas_path, canvas)
    index_canvas(canvas_path, canvas)
    return note


def ensure_files(project: dict[str, Any]) -> dict[str, Any]:
    project_paths = paths(project)
    project_paths["directory"].mkdir(parents=True, exist_ok=True)
    previous = read_json_object(project_paths["manifest"]) or {}
    uid = str(previous.get("uid") or uuid.uuid4())
    manifest = {
        "schema_version": 1, "kind": "kavot.project", "id": project["id"], "uid": uid,
        "name": project["name"], "description": project.get("description", ""),
        "color": project.get("color", "#087e86"), "status": project.get("status", "active"),
        "created_at": project.get("created_at", now()), "updated_at": project.get("updated_at", now()),
        "entrypoints": {"canvas": CANVAS, "relations": RELATIONS, "references": REFERENCES},
        "external_resources": project.get("external_resources", []),
        "repository_path": project.get("repository_path", ""),
        "repository_context_enabled": project.get("repository_context_enabled", False),
    }
    atomic_write_json(project_paths["manifest"], manifest)
    canvas = read_json_object(project_paths["canvas"]) or _canvas(project, uid)
    canvas.update({"projectId": project["id"], "projectUid": uid, "title": project["name"]})
    root = next((item for item in canvas.get("nodes", []) if item.get("type") == "project"), None)
    if root:
        root.update({"title": project["name"], "description": project.get("description", ""), "status": project.get("status", "active"), "color": project.get("color", "#087e86")})
    atomic_write_json(project_paths["canvas"], canvas)
    index_canvas(project_paths["canvas"], canvas)
    return manifest


def index_canvas(canvas_path: Path, canvas: dict[str, Any]) -> None:
    relations = [{
        "id": edge.get("id"), "from": edge.get("fromNode"), "to": edge.get("toNode"),
        "label": edge.get("label", ""), "note": edge.get("note", ""), "color": edge.get("color", "#77746d"),
        "collapsed": bool(edge.get("collapsed", False)),
    } for edge in canvas.get("edges", []) if isinstance(edge, dict)]
    references = [{
        "node_id": node.get("id"), "type": node.get("type"), "title": node.get("title", ""),
        "path": node.get("path"), "note_id": node.get("noteId"), "paper_id": node.get("paperId"),
        "collection_type": node.get("collectionType"), "database_id": node.get("databaseId"),
        "record_id": node.get("recordId"), "template_id": node.get("templateId"),
        "scope": node.get("scope"), "collection_project_id": node.get("projectId"),
        "url": node.get("url"), "labels": node.get("labels", []),
        "annotation": node.get("annotation", ""), "card_notes": node.get("cardNotes", ""), "progress": node.get("progress", ""),
    } for node in canvas.get("nodes", []) if isinstance(node, dict) and node.get("type") not in {"project", "zone", "shape", "text"}]
    common = {"schema_version": 1, "project_id": canvas.get("projectId"), "project_uid": canvas.get("projectUid")}
    atomic_write_json(canvas_path.parent / RELATIONS, {**common, "relations": relations})
    # Include free ideas and areas for future assistant context, not just linked files.
    elements = [{key: node[key] for key in (
        "id", "type", "title", "text", "description", "noteId", "url", "databaseId", "scope", "recordId", "collectionType",
        "labels", "annotation", "cardNotes", "progress", "taskId", "taskColumnId", "projectId", "templateId", "collapsed", "x", "y", "width", "height",
    ) if key in node} for node in canvas.get("nodes", []) if isinstance(node, dict)]
    atomic_write_json(canvas_path.parent / REFERENCES, {**common, "references": references, "elements": elements})


def remove_note_reference(project: dict[str, Any], note_id: int) -> bool:
    """Remove a trashed note and its connected edges from one project canvas."""

    canvas_path = paths(project)["canvas"]
    canvas = read_json_object(canvas_path)
    if not canvas:
        return False
    removed_ids = {
        str(node.get("id"))
        for node in canvas.get("nodes", [])
        if node.get("type") == "note" and int(node.get("noteId") or 0) == int(note_id)
    }
    if not removed_ids:
        return False
    canvas["nodes"] = [
        node for node in canvas.get("nodes", []) if str(node.get("id")) not in removed_ids
    ]
    canvas["edges"] = [
        edge
        for edge in canvas.get("edges", [])
        if str(edge.get("fromNode")) not in removed_ids
        and str(edge.get("toNode")) not in removed_ids
    ]
    atomic_write_json(canvas_path, canvas)
    index_canvas(canvas_path, canvas)
    return True


def enrich(project: dict[str, Any], state: dict[str, Any] | None = None) -> dict[str, Any]:
    state = state or store.read()
    result = dict(project)
    result.update({
        "paper_count": sum(project["id"] in item.get("project_ids", []) for item in state["papers"]),
        "note_count": sum(item.get("project_id") == project["id"] and not item.get("trashed_at") for item in state["notes"]),
        "task_count": sum(item.get("project_id") == project["id"] and not item.get("archived_at") for item in state["tasks"]),
    })
    manifest = ensure_files(result)
    root = paths(result)["directory"].name
    result.update({
        "uid": manifest["uid"],
        "manifest_path": f"projects/{root}/{MANIFEST}",
        "canvas_path": f"projects/{root}/{CANVAS}",
        "relations_path": f"projects/{root}/{RELATIONS}",
        "references_path": f"projects/{root}/{REFERENCES}",
        "canvas_url": f"/api/workspace/file?path={quote(f'projects/{root}/{CANVAS}', safe='')}",
    })
    total = sum(1 for item in state["tasks"] if item.get("project_id") == project["id"] and not item.get("archived_at"))
    done = sum(1 for item in state["tasks"] if item.get("project_id") == project["id"] and item.get("status") == "done" and not item.get("archived_at"))
    result["progress"] = round(done / total * 100) if total else 0
    return result


def list_projects() -> list[dict[str, Any]]:
    state = store.read()
    return [enrich(item, state) for item in sorted(state["projects"], key=lambda value: value["updated_at"], reverse=True)]


def _external_resource_title(resource: dict[str, Any]) -> str:
    title = str(resource.get("title") or "").strip()
    if title:
        return title
    resource_type = resource["resource_type"]
    target = str(resource["target"])
    if resource_type == "github":
        return "GitHub repository"
    if resource_type == "overleaf":
        return "Overleaf project"
    if resource_type == "local_path":
        return Path(target).name or target
    return urlparse(target).netloc or target


def _normalise_external_resource(resource: dict[str, Any]) -> dict[str, Any]:
    resource_type = resource["resource_type"]
    target = str(resource["target"]).strip()
    if resource_type == "local_path":
        path = Path(target).expanduser()
        if not path.is_absolute():
            raise HTTPException(status_code=422, detail="A local resource must use an absolute folder path")
        target = str(path)
    else:
        parsed = urlparse(target)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise HTTPException(status_code=422, detail="A web resource must use a valid http(s) URL")
        target = target.rstrip("/")
    normalised = {
        "id": uuid.uuid4().hex,
        "resource_type": resource_type,
        "target": target,
        "title": str(resource.get("title") or "").strip(),
        "created_at": now(),
    }
    normalised["title"] = _external_resource_title(normalised)
    return normalised


def add_external_resource(project_id: int, resource: dict[str, Any]) -> dict[str, Any]:
    normalised = _normalise_external_resource(resource)
    with store.transaction() as state:
        project = next((item for item in state["projects"] if int(item["id"]) == int(project_id)), None)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        resources = project.setdefault("external_resources", [])
        if any(item.get("resource_type") == normalised["resource_type"] and item.get("target") == normalised["target"] for item in resources):
            raise HTTPException(status_code=409, detail="This resource is already linked to the project")
        resources.append(normalised)
        project["updated_at"] = now()
        updated = dict(project)
    ensure_files(updated)
    return {"resource": normalised, "project": enrich(updated)}


def remove_external_resource(project_id: int, resource_id: str) -> dict[str, Any]:
    with store.transaction() as state:
        project = next((item for item in state["projects"] if int(item["id"]) == int(project_id)), None)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        resources = project.get("external_resources", [])
        retained = [item for item in resources if str(item.get("id")) != resource_id]
        if len(retained) == len(resources):
            raise HTTPException(status_code=404, detail="Linked resource not found")
        project["external_resources"] = retained
        project["updated_at"] = now()
        updated = dict(project)
    ensure_files(updated)
    return {"project": enrich(updated)}


def add_resource(project_id: int, resource: dict[str, Any]) -> dict[str, Any]:
    project = store.find("projects", project_id, "Project")
    project_paths = paths(project)
    canvas = read_json_object(project_paths["canvas"]) or _canvas(project, ensure_files(project)["uid"])
    kind = resource["resource_type"]
    record_id = resource["resource_id"]
    node_id = f"{kind}-{record_id}"
    article_note = None
    if kind == "paper":
        from app.core.workspace.documents import create_article_note
        article_note = create_article_note(int(record_id))
    if not any(item.get("id") == node_id or (article_note and item.get("type") == "note" and item.get("noteId") == article_note["id"]) for item in canvas["nodes"]):
        node = {
            "id": node_id, "type": kind, "title": str(resource.get("title") or f"{kind.title()} {record_id}"),
            "recordId": record_id, "databaseId": resource.get("database_id"),
            "x": 2260, "y": 1080 + len(canvas["nodes"]) * 30, "width": 320, "height": 210,
        }
        if article_note:
            node.update({"type": "note", "noteId": article_note["id"], "title": article_note["title"], "paperId": int(record_id), "templateId": article_note.get("template_id")})
        canvas["nodes"].append(node)
        home_ids = {note["id"] for note in store.read()["notes"] if note.get("project_id") == project_id and note.get("system_kind") == "project_home"}
        anchor = next((item for item in canvas["nodes"] if item.get("type") == "project" or item.get("noteId") in home_ids), None)
        if anchor:
            canvas["edges"].append({"id": f"edge-project-{node_id}", "fromNode": anchor["id"], "toNode": node_id, "label": "project resource"})
        atomic_write_json(project_paths["canvas"], canvas)
        index_canvas(project_paths["canvas"], canvas)
    return {"project": enrich(project), "canvas": canvas}



def create(payload: ProjectCreate) -> dict[str, Any]:
    """Create a project and its initial files for both the API and agent proposals."""
    from app.core.projects import code as project_code

    values = json_values(payload)
    if values.get('repository_path'):
        values['repository_path'] = str(project_code.folder(values['repository_path']))
    else:
        values['repository_context_enabled'] = False
    project = store.create("projects", {**values, "status": "active"})
    ensure_files(project)
    initialize_project_note(project)
    return enrich(project)

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Response
from fastapi.responses import FileResponse

from app.models.projects import ProjectCreate, ProjectExternalResourceCreate, ProjectResourceLink, ProjectUpdate
from app.core.projects import projects, code as project_code, trash as project_trash
from app.core.records.repository import json_values, store


router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("")
def list_projects() -> list[dict[str, Any]]:
    return projects.list_projects()


@router.post("", status_code=201)
def create_project(payload: ProjectCreate) -> dict[str, Any]:
    return projects.create(payload)


@router.get("/trash")
def deleted_projects() -> list[dict[str, Any]]:
    return project_trash.list_entries()


@router.post("/trash/{trash_id}/restore")
def restore_project(trash_id: str) -> dict[str, Any]:
    return project_trash.restore(trash_id)


@router.delete("/trash/{trash_id}", status_code=204)
def purge_project(trash_id: str) -> Response:
    project_trash.purge(trash_id)
    return Response(status_code=204)


@router.get("/{project_id}")
def get_project(project_id: int) -> dict[str, Any]:
    state = store.read()
    project = store.find("projects", project_id, "Project")
    result = projects.enrich(project, state)
    result.update({
        "papers": [item for item in state["papers"] if project_id in item.get("project_ids", [])],
        "tasks": [item for item in state["tasks"] if item.get("project_id") == project_id and not item.get("archived_at")],
        "notes": [item for item in state["notes"] if item.get("project_id") == project_id and not item.get("trashed_at")],
        "conferences": [item for item in state["conferences"] if project_id in item.get("project_ids", [])],
        "datasets": [item for item in state["datasets"] if project_id in item.get("project_ids", [])],
    })
    return result


@router.patch("/{project_id}")
def update_project(project_id: int, payload: ProjectUpdate) -> dict[str, Any]:
    values = json_values(payload, exclude_unset=True)
    if 'repository_path' in values:
        values['repository_path'] = str(project_code.folder(values['repository_path'])) if values['repository_path'] else ''
        if not values['repository_path']:
            values['repository_context_enabled'] = False
    project = store.update("projects", project_id, values, "Project")
    projects.ensure_files(project)
    return projects.enrich(project)


@router.post("/{project_id}/resources")
def add_resource(project_id: int, payload: ProjectResourceLink) -> dict[str, Any]:
    values = json_values(payload)
    state = store.read()
    collection = {"paper": "papers", "task": "tasks", "conference": "conferences", "dataset": "datasets"}.get(payload.resource_type)
    if collection:
        item = next((row for row in state[collection] if str(row["id"]) == str(payload.resource_id)), None)
        if item:
            values["title"] = item.get("title") or item.get("name")
            if payload.resource_type in {"paper", "conference", "dataset"} and project_id not in item.get("project_ids", []):
                store.update(collection, int(item["id"]), {"project_ids": [*item.get("project_ids", []), project_id]})
            elif payload.resource_type == "task":
                store.update(collection, int(item["id"]), {"project_id": project_id})
    return projects.add_resource(project_id, values)


@router.post("/{project_id}/external-resources", status_code=201)
def add_external_resource(project_id: int, payload: ProjectExternalResourceCreate) -> dict[str, Any]:
    return projects.add_external_resource(project_id, json_values(payload))


@router.delete("/{project_id}/external-resources/{resource_id}")
def delete_external_resource(project_id: int, resource_id: str) -> dict[str, Any]:
    return projects.remove_external_resource(project_id, resource_id)


@router.get("/{project_id}/export")
def export_project(project_id: int) -> FileResponse:
    project = store.find("projects", project_id, "Project")
    root = projects.directory(project)
    temporary = Path(tempfile.mkdtemp(prefix="kavot-export-"))
    archive = temporary / f"{root.name}.zip"
    import shutil
    shutil.make_archive(str(archive.with_suffix("")), "zip", root)
    return FileResponse(archive, filename=archive.name, media_type="application/zip")


@router.delete("/{project_id}")
def delete_project(project_id: int) -> dict[str, str]:
    return {"trash_id": project_trash.trash(project_id)}








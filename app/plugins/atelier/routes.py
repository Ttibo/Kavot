"""HTTP routes of the Atelier, under /api/atelier/projects/{project_id}."""
from __future__ import annotations

import os
import subprocess
import sys
import webbrowser
from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.core.projects import code as project_code
from app.core.records.repository import store as records
from app.core.agents import sessions
from app.plugins.atelier import agents, codemap, folders, gitview, preview

router = APIRouter(prefix="/atelier", tags=["atelier"])


class FolderCreate(BaseModel):
    path: str = Field(min_length=1, max_length=2000)
    name: str = Field(default="", max_length=120)
    kind: Literal["code", "resources"] = "code"


class FolderRename(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class OpenRequest(BaseModel):
    path: str = Field(default="", max_length=2000)
    line: int = Field(default=1, ge=1)
    editor: Literal["vscode", "cursor", "system", "default"] = "vscode"


class WorkspaceOpen(BaseModel):
    path: str = Field(min_length=1, max_length=2000)


class CodeAccept(BaseModel):
    message: str = Field(default="", max_length=2000)
    merge: bool = False


@router.get("/engines")
def list_engines() -> list[dict[str, Any]]:
    return [{"id": item["id"], "name": item["name"], "enabled": item["enabled"], "model": item["model"], "effort": item["effort"],
             "available": bool(item["detected_path"])} for item in sessions.public_settings()["engines"]]


def _system_open(target) -> None:
    """Open a document with the app the system uses for it; programs and scripts are refused."""
    if not target.is_file() or target.suffix.lower() not in preview.DOCUMENTS:
        raise HTTPException(422, "Kavot opens documents with their app, not programs or scripts.")
    if sys.platform == "win32":
        os.startfile(target)  # noqa: S606 - a validated document
    else:
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(target)])


# Documents of the workspace (notes and project folders), shown in the Workspace editor.
@router.get("/workspace/preview")
def workspace_preview(path: str = Query(min_length=1)) -> dict[str, Any]:
    from app.api.routes.documents import workspace_path
    target = workspace_path(path)
    if not target.is_file():
        raise HTTPException(404, "File not found")
    return preview.preview(target)


@router.post("/workspace/open", status_code=204)
def workspace_open(payload: WorkspaceOpen) -> None:
    from app.api.routes.documents import workspace_path
    _system_open(workspace_path(payload.path))


@router.get("/projects/{project_id}")
def overview(project_id: int) -> dict[str, Any]:
    project = folders.project(project_id)
    state = records.read()
    return {
        "project": {key: project.get(key) for key in ("id", "name", "description", "color", "status", "canvas_path")},
        "folders": [folders.describe(item) for item in folders.listing(project)],
        "conversations": sessions.list_sessions(project_id=project_id),
        "notes": [{"id": n["id"], "title": n.get("title") or "Untitled", "updated_at": n.get("updated_at")}
                  for n in state.get("notes", []) if n.get("project_id") == project_id and not n.get("trashed_at")],
        "tasks": [{"id": t["id"], "title": t.get("title") or "", "status": t.get("status", "todo"), "priority": t.get("priority"),
                   "due_date": t.get("due_date")}
                  for t in state.get("tasks", []) if t.get("project_id") == project_id and not t.get("archived_at")],
    }


@router.post("/projects/{project_id}/folders", status_code=201)
def add_folder(project_id: int, payload: FolderCreate) -> dict[str, Any]:
    return folders.add(folders.project(project_id), payload.path, payload.name, payload.kind)


@router.patch("/projects/{project_id}/folders/{folder_id}")
def rename_folder(project_id: int, folder_id: str, payload: FolderRename) -> dict[str, Any]:
    return folders.rename(folders.project(project_id), folder_id, payload.name)


@router.delete("/projects/{project_id}/folders/{folder_id}", status_code=204)
def remove_folder(project_id: int, folder_id: str) -> None:
    folders.remove(folders.project(project_id), folder_id)


@router.get("/projects/{project_id}/folders/{folder_id}/tree")
def tree(project_id: int, folder_id: str, path: str = "") -> dict[str, Any]:
    project = folders.project(project_id)
    single = folders.only(project, folder_id)
    if single is not None:
        return {"path": "", "entries": [{"name": single, "path": single, "directory": False}], "truncated": False}
    return project_code.tree_at(folders.root(project, folder_id), path)


@router.get("/projects/{project_id}/folders/{folder_id}/file")
def read_file(project_id: int, folder_id: str, path: str = Query(min_length=1)) -> dict[str, Any]:
    project = folders.project(project_id)
    folders.target(project, folder_id, path)
    return project_code.file_at(folders.root(project, folder_id), path)


@router.get("/projects/{project_id}/folders/{folder_id}/preview")
def preview_file(project_id: int, folder_id: str, path: str = Query(min_length=1)) -> dict[str, Any]:
    target = folders.target(folders.project(project_id), folder_id, path)
    if not target.is_file():
        raise HTTPException(422, "This path is not a file.")
    return preview.preview(target)


@router.get("/projects/{project_id}/folders/{folder_id}/raw")
def raw_file(project_id: int, folder_id: str, path: str = Query(min_length=1)) -> FileResponse:
    """PDFs and images, shown in the viewer. Served sandboxed: nothing in them can run in the app."""
    target = folders.target(folders.project(project_id), folder_id, path)
    media = preview.RAW.get(target.suffix.lower())
    if not target.is_file() or not media:
        raise HTTPException(422, "This file cannot be shown here.")
    # Browsers refuse to render a PDF under a sandbox policy; their PDF viewer is isolated anyway.
    headers = {"X-Content-Type-Options": "nosniff", **({} if media == "application/pdf" else {"Content-Security-Policy": "sandbox"})}
    return FileResponse(target, media_type=media, content_disposition_type="inline", headers=headers)


@router.get("/projects/{project_id}/folders/{folder_id}/log")
def log(project_id: int, folder_id: str, limit: int = Query(50, ge=1, le=200), skip: int = Query(0, ge=0)) -> list[dict[str, Any]]:
    return gitview.log(folders.root(folders.project(project_id), folder_id), limit, skip)


@router.get("/projects/{project_id}/folders/{folder_id}/commits/{sha}")
def commit(project_id: int, folder_id: str, sha: str) -> dict[str, Any]:
    return gitview.commit(folders.root(folders.project(project_id), folder_id), sha)


@router.get("/projects/{project_id}/folders/{folder_id}/changes")
def changes(project_id: int, folder_id: str) -> dict[str, Any]:
    return gitview.working(folders.root(folders.project(project_id), folder_id))


@router.get("/projects/{project_id}/folders/{folder_id}/map")
def code_map(project_id: int, folder_id: str) -> dict[str, Any]:
    return codemap.build(folders.root(folders.project(project_id), folder_id))


@router.post("/projects/{project_id}/folders/{folder_id}/open", status_code=204)
def open_in_editor(project_id: int, folder_id: str, payload: OpenRequest) -> None:
    project = folders.project(project_id)
    base = folders.root(project, folder_id)
    single = folders.only(project, folder_id)
    target = folders.target(project, folder_id, payload.path or single) if payload.path or single else base
    if payload.editor == "default":
        _system_open(target)
        return
    if payload.editor == "system":
        folder = target if target.is_dir() else target.parent
        if sys.platform == "win32":
            os.startfile(folder)  # noqa: S606 - a validated local folder
        else:
            subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(folder)])
        return
    location = quote(target.as_posix(), safe="/:") + (f":{payload.line}" if target.is_file() else "")
    if not webbrowser.open(f"{payload.editor}://file/{location}"):
        raise HTTPException(502, "No editor answered. Check that it is installed.")


# The code of an agent conversation: its changes in the worktrees, then commit, merge or discard.
@router.get("/conversations/{session_id}/code")
def conversation_code(session_id: str) -> dict[str, Any] | None:
    return agents.detail(session_id)


@router.get("/conversations/{session_id}/diff")
def conversation_diff(session_id: str) -> dict[str, Any]:
    return agents.diff(session_id)


@router.post("/conversations/{session_id}/accept")
def accept_code(session_id: str, payload: CodeAccept) -> dict[str, Any] | None:
    return agents.accept(session_id, payload.message, payload.merge)


@router.post("/conversations/{session_id}/merge")
def merge_code(session_id: str) -> dict[str, Any] | None:
    return agents.merge(session_id)


@router.post("/conversations/{session_id}/discard")
def discard_code(session_id: str) -> dict[str, Any] | None:
    return agents.discard(session_id)

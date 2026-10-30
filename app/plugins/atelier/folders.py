"""Folders and single files linked to a project, as code (Git, map, agents that write) or resources
(documents, data, read-only). A linked file is served as a folder holding only that file.

The project's legacy `repository_path` is the first code folder."""
from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.core.projects import code as project_code
from app.core.records.repository import store
from app.plugins.atelier import gitview, store as state_store

LEGACY_ID = "primary"


def project(project_id: int) -> dict[str, Any]:
    return store.find("projects", project_id, "Project")


def listing(project: dict[str, Any]) -> list[dict[str, Any]]:
    folders = [dict(entry) for entry in state_store.read(project["id"])["folders"]]
    legacy = project.get("repository_path") or ""
    if legacy and not any(entry["path"] == legacy for entry in folders):
        folders.insert(0, {"id": LEGACY_ID, "name": Path(legacy).name, "path": legacy, "legacy": True})
    for item in folders:
        item.setdefault("kind", "code")
    return folders


def entry(project: dict[str, Any], folder_id: str) -> dict[str, Any]:
    found = next((item for item in listing(project) if item["id"] == folder_id), None)
    if not found:
        raise HTTPException(404, "This item is not linked to the project.")
    return found


def linked_file(path: str) -> Path:
    candidate = Path(path.strip()).expanduser()
    if not path.strip() or not candidate.is_absolute():
        raise HTTPException(422, "Give the absolute path of a local folder or file.")
    try:
        resolved = candidate.resolve(strict=True)
    except (OSError, RuntimeError):
        raise HTTPException(422, "This file was not found or is not accessible.") from None
    if not resolved.is_file():
        raise HTTPException(422, "This path is not a file.")
    return resolved


def root(project: dict[str, Any], folder_id: str) -> Path:
    """The folder to browse; for a linked file, the folder that contains it."""
    item = entry(project, folder_id)
    return linked_file(item["path"]).parent if item.get("file") else project_code.folder(item["path"])


def only(project: dict[str, Any], folder_id: str) -> str | None:
    """For a linked file, the only name that may be read in its folder."""
    item = entry(project, folder_id)
    return Path(item["path"]).name if item.get("file") else None


def target(project: dict[str, Any], folder_id: str, relative: str) -> Path:
    """A path inside a linked folder, or the linked file itself."""
    single = only(project, folder_id)
    if single is not None and relative != single:
        raise HTTPException(404, "Only the linked file can be read here.")
    return project_code.target(root(project, folder_id), relative)


def add(project: dict[str, Any], path: str, name: str = "", kind: str = "code") -> dict[str, Any]:
    candidate = Path(path.strip()).expanduser()
    is_file = candidate.is_absolute() and candidate.is_file()
    resolved = str(linked_file(path) if is_file else project_code.folder(path))
    if any(item["path"] == resolved for item in listing(project)):
        raise HTTPException(409, "This folder is already linked to the project.")
    with state_store.lock:
        doc = state_store.read(project["id"])
        item = {"id": uuid.uuid4().hex[:8], "name": (name.strip() or Path(resolved).name)[:120], "path": resolved,
                "kind": "resources" if kind == "resources" else "code", **({"file": True} if is_file else {})}
        doc["folders"].append(item)
        state_store.write(project["id"], doc)
    return describe(item)


def rename(project: dict[str, Any], folder_id: str, name: str) -> dict[str, Any]:
    with state_store.lock:
        doc = state_store.read(project["id"])
        item = next((f for f in doc["folders"] if f["id"] == folder_id), None)
        if not item:
            raise HTTPException(409, "The project's main folder keeps its folder name.")
        item["name"] = name.strip()[:120] or item["name"]
        state_store.write(project["id"], doc)
    return describe(item)


def remove(project: dict[str, Any], folder_id: str) -> None:
    item = entry(project, folder_id)
    with state_store.lock:
        doc = state_store.read(project["id"])
        used = lambda run: folder_id in {run.get("folder_id"), *(space.get("folder_id") for space in run.get("workspaces") or []),
                                         *(item.get("folder_id") for item in run.get("resources") or [])}
        if any(used(run) and run["status"] in {"running", "review"} for run in doc["runs"]):
            raise HTTPException(409, "Accept or discard the agent runs of this folder first.")
        if item.get("legacy"):
            store.update("projects", project["id"], {"repository_path": "", "repository_context_enabled": False}, "Project")
        else:
            doc["folders"] = [f for f in doc["folders"] if f["id"] != folder_id]
            state_store.write(project["id"], doc)


def describe(item: dict[str, Any]) -> dict[str, Any]:
    """A folder with its Git state, or the reason it cannot be read."""
    if item.get("file"):
        try:
            path = linked_file(item["path"])
        except HTTPException as error:
            return {**item, "available": False, "error": error.detail, "changes": [], "commits": []}
        return {**item, "kind": item.get("kind", "code"), "available": True, "is_git": False, "branch": None,
                "size": path.stat().st_size, "changes": [], "commits": []}
    try:
        base = project_code.folder(item["path"])
        info = project_code.inspect(str(base))
    except HTTPException as error:
        return {**item, "available": False, "error": error.detail}
    # The folder's own name and path win over the ones `inspect` derives from the directory.
    result = {**info, **item, "available": True, "changes": [], "commits": []}
    result.setdefault("kind", "code")
    if info["is_git"] and result["kind"] == "code":
        try:
            result["changes"] = project_code.summary({"repository_path": str(base)})["changes"]
            result["commits"] = gitview.log(base, limit=5)
        except HTTPException as error:
            result["git_error"] = error.detail
    return result

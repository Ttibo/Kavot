"""Recoverable project deletion. Snapshots live inside the portable workspace."""
from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from fastapi import HTTPException

from app.core.kernel.config import settings
from app.core.kernel.files import atomic_write_json, read_json_object
from app.core.workspace import documents
from app.core.projects import projects
from app.core.records.repository import now, store


def _root() -> Path:
    return settings.storage_path / ".meta_kavot" / "project-trash"


def _entry(identifier: str) -> Path:
    try:
        return _root() / str(uuid.UUID(identifier))
    except ValueError as error:
        raise HTTPException(404, "Deleted project not found") from error


def list_entries() -> list[dict]:
    if not _root().exists():
        return []
    entries = [read_json_object(path / "manifest.json") for path in _root().iterdir() if path.is_dir()]
    return sorted(({"id": item["id"], "name": item["project"]["name"], "deleted_at": item["deleted_at"]}
                   for item in entries if item), key=lambda item: item["deleted_at"], reverse=True)


def trash(project_id: int) -> str:
    state = store.read()
    project = next((item for item in state["projects"] if item["id"] == project_id), None)
    if project is None:
        raise HTTPException(404, "Project not found")
    identifier = str(uuid.uuid4())
    entry = _entry(identifier)
    files = []
    project_dir = projects.directory(project)
    paths = [project_dir, *(documents.note_path(item, state) for item in state["notes"]
                            if item.get("project_id") == project_id)]
    try:
        for path in paths:
            if not path.exists():
                continue
            relative = path.relative_to(settings.storage_path)
            destination = entry / "files" / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            if path.is_dir():
                shutil.copytree(path, destination, symlinks=True)
            else:
                shutil.copy2(path, destination)
            files.append(relative.as_posix())
        manifest = {
            "id": identifier, "deleted_at": now(), "project": project,
            "tasks": [item for item in state["tasks"] if item.get("project_id") == project_id],
            "notes": [item for item in state["notes"] if item.get("project_id") == project_id],
            "note_folders": [item for item in state["note_folders"] if item.get("project_id") == project_id],
            "linked": {collection: [item["id"] for item in state[collection]
                                    if project_id in item.get("project_ids", [])]
                       for collection in ("papers", "conferences", "datasets")},
            "files": files,
        }
        atomic_write_json(entry / "manifest.json", manifest)
    except Exception:
        shutil.rmtree(entry, ignore_errors=True)
        raise
    # The snapshot is complete before any live data is removed.
    with store.transaction() as current:
        current["projects"] = [item for item in current["projects"] if item["id"] != project_id]
        for collection in ("tasks", "notes", "note_folders"):
            current[collection] = [item for item in current[collection] if item.get("project_id") != project_id]
        for collection in ("papers", "conferences", "datasets"):
            for item in current[collection]:
                item["project_ids"] = [value for value in item.get("project_ids", []) if value != project_id]
    for relative in files:
        path = settings.storage_path / relative
        if path.is_dir():
            shutil.rmtree(path)
        elif path.is_file():
            path.unlink()
    return identifier


def restore(identifier: str) -> dict:
    entry = _entry(identifier)
    manifest = read_json_object(entry / "manifest.json")
    if not manifest:
        raise HTTPException(404, "Deleted project not found")
    state = store.read()
    project = manifest["project"]
    if any(item["id"] == project["id"] for item in state["projects"]):
        raise HTTPException(409, "A project with this ID already exists")
    for collection in ("tasks", "notes", "note_folders"):
        existing = {item["id"] for item in state[collection]}
        if any(item["id"] in existing for item in manifest[collection]):
            raise HTTPException(409, "A project item was replaced since it was deleted")
    for relative in manifest["files"]:
        if (settings.storage_path / relative).exists():
            raise HTTPException(409, "A file already exists at the restore location")
    copied = []
    try:
        for relative in manifest["files"]:
            source, target = entry / "files" / relative, settings.storage_path / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, target, symlinks=True)
            else:
                shutil.copy2(source, target)
            copied.append(target)
        with store.transaction() as current:
            current["projects"].append(project)
            for collection in ("tasks", "notes", "note_folders"):
                current[collection].extend(manifest[collection])
            for collection in ("papers", "conferences", "datasets"):
                for item in current[collection]:
                    if item["id"] in manifest["linked"][collection]:
                        item["project_ids"] = list(dict.fromkeys([*item.get("project_ids", []), project["id"]]))
    except Exception:
        for path in reversed(copied):
            shutil.rmtree(path) if path.is_dir() else path.unlink(missing_ok=True)
        raise
    shutil.rmtree(entry)
    return projects.enrich(project)


def purge(identifier: str) -> None:
    entry = _entry(identifier)
    if not (entry / "manifest.json").is_file():
        raise HTTPException(404, "Deleted project not found")
    shutil.rmtree(entry)

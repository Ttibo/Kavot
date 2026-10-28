"""Persist canvases without turning their notes or cards into tasks."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.core.kernel.config import settings
from app.core.kernel.files import atomic_write_json


def save(path: Path, content: dict[str, Any]) -> None:
    from app.core.projects import projects
    from app.core.records.repository import store

    nodes = content.get("nodes", [])
    if not isinstance(nodes, list) or any(not isinstance(node, dict) for node in nodes):
        raise HTTPException(status_code=422, detail="Canvas nodes must be objects")
    ids = [node.get("id") for node in nodes]
    if any(not isinstance(node_id, str) or not node_id for node_id in ids) or len(set(ids)) != len(ids):
        raise HTTPException(status_code=422, detail="Canvas cards need unique IDs")
    if path.name == projects.CANVAS and path.parent.parent.resolve() == settings.projects_path.resolve():
        state = store.read()
        project = next((item for item in state["projects"] if projects.directory(item).resolve() == path.parent.resolve()), None)
        if project:
            home = next((note for note in state["notes"] if note.get("project_id") == project["id"] and note.get("system_kind") == "project_home" and not note.get("trashed_at")), None)
            if home and sum(node.get("type") == "note" and node.get("noteId") == home["id"] for node in nodes) != 1:
                raise HTTPException(status_code=409, detail="The project note must remain on its canvas")
    # Preserve historical annotations/labels in the file, but remove the obsolete
    # task synchronization fields. Explicit task cards reference a recordId.
    for node in nodes:
        for key in ("taskId", "taskColumnId", "taskSyncedColumnId", "progress"):
            node.pop(key, None)
    atomic_write_json(path, content)
    if path.parent.parent.resolve() == settings.projects_path.resolve():
        projects.index_canvas(path, content)

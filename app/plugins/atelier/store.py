"""Per-project Atelier state: linked code folders and agent runs.

Folder paths and worktrees only make sense on this computer, so the state lives in
the configuration folder (one directory per workspace), not in the synced workspace.
"""
from __future__ import annotations

import hashlib
import threading
from pathlib import Path
from typing import Any

from app.core.kernel.config import settings
from app.core.kernel.files import atomic_write_json, read_json_object
from app.core.kernel.user_settings import config_dir

lock = threading.RLock()


def base() -> Path:
    workspace = str(settings.storage_path.resolve())
    return config_dir() / "atelier" / hashlib.sha256(workspace.encode("utf-8")).hexdigest()[:16]


def worktrees() -> Path:
    return base() / "worktrees"


def _path(project_id: int) -> Path:
    return base() / f"project-{int(project_id)}.json"


def read(project_id: int) -> dict[str, Any]:
    with lock:
        doc = read_json_object(_path(project_id)) or {}
        doc.setdefault("folders", [])
        doc.setdefault("runs", [])
        return doc


def write(project_id: int, doc: dict[str, Any]) -> None:
    with lock:
        atomic_write_json(_path(project_id), doc)


def projects_with_state() -> list[int]:
    folder = base()
    if not folder.is_dir():
        return []
    return [int(path.stem.split("-", 1)[1]) for path in folder.glob("project-*.json") if path.stem.split("-", 1)[1].isdigit()]

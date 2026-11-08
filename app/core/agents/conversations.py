"""Saved agent conversations: one JSON file in the user's config folder.

The Agents view polls the conversation list every few seconds while it is open: reads
go through a cache, parsed again only when the file changes. Code that changes a
conversation reads its own copy (:func:`load`) and saves it with :func:`save`.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import HTTPException

from app.core.kernel.config import settings
from app.core.kernel.user_settings import config_dir

_lock = threading.Lock()
_cache: tuple[tuple[int, int] | None, list[dict]] | None = None


def _file() -> Path:
    return config_dir() / "external-agent-sessions.json"


def _stamp(path: Path) -> tuple[int, int] | None:
    try:
        info = path.stat()
    except OSError:
        return None
    return info.st_mtime_ns, info.st_size


def _parse(path: Path) -> list[dict]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, list) else []
    except (OSError, ValueError):
        return []


def load() -> list[dict]:
    """Every saved conversation, as a copy to change and save."""
    return _parse(_file())


def cached() -> list[dict]:
    """Every saved conversation, shared: read it, never change it."""
    global _cache
    path = _file()
    stamp = _stamp(path)
    with _lock:
        if _cache is not None and _cache[0] == stamp and stamp is not None:
            return _cache[1]
    value = _parse(path)
    with _lock:
        _cache = (stamp, value)
    return value


def save(sessions: list[dict]) -> None:
    global _cache
    target = _file()
    temporary = None
    try:
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(sessions, handle, ensure_ascii=False, indent=2)
        os.replace(temporary, target)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)
        with _lock:
            _cache = None


def workspace() -> str:
    """The current workspace, as conversations record it."""
    return str(settings.storage_path.resolve())


def find(sessions: list[dict], session_id: str) -> dict:
    root = workspace()
    for session in sessions:
        if session.get("id") == session_id and session.get("workspace") == root:
            return session
    raise HTTPException(404, "Session not found in this workspace.")


def home(session: dict) -> Path:
    """The folder a new conversation's CLI starts in: its own, empty, so nothing is read or written by accident."""
    return config_dir() / "agent-conversations" / session["id"]

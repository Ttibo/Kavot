"""Workspace paths an agent change may target."""
from pathlib import Path

from fastapi import HTTPException

from app.core.kernel.config import settings

ROOTS = {"notes", "projects", "library", "databases"}


def workspace_file(value: str) -> Path:
    """A path inside the workspace's data folders, resolved; anything else is refused."""
    root = settings.storage_path.resolve()
    relative = Path(value)
    if relative.is_absolute() or not relative.parts or relative.parts[0] not in ROOTS:
        raise HTTPException(422, "Path outside the workspace.")
    target = (root / relative).resolve()
    if not target.is_relative_to(root):
        raise HTTPException(422, "Path outside the workspace.")
    return target

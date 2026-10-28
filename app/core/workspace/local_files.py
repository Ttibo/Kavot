"""Local folders opened to agents by a workflow: reading, and changes the user approves.

Agents never write on disk. They propose a patch or a whole file; Kavot shows
the diff, and writes it only once the user applies it, after checking that the
file has not changed since the proposal (same hash as when it was read).
"""
from __future__ import annotations

import difflib
import hashlib
import uuid
from pathlib import Path

from fastapi import HTTPException

from app.core.kernel.files import atomic_write_text
from app.core.projects import code as project_code

KINDS = {"local_file_patch", "local_file_write"}
MAX_WRITE = 512_000


def allowed_root(run: dict, root: str, *, changes: bool = False) -> Path:
    """The local folder named by the agent, if this request opened it (for changes: with permission)."""
    for folder in (run.get("context") or {}).get("local_folders") or []:
        base = project_code.folder(folder["path"])
        if Path(root).expanduser().resolve() == base:
            if changes and not folder.get("allow_changes"):
                raise ValueError("This workflow does not allow changes in this folder.")
            return base
    raise ValueError("This folder is not open to this request. Use one of the local_folders of the context.")


def tree(run: dict, root: str, relative: str = "") -> dict:
    return project_code.tree_at(allowed_root(run, root), relative)


def read(run: dict, root: str, relative: str, offset: int = 0, limit: int = 40_000) -> dict:
    result = project_code.file_at(allowed_root(run, root), relative)
    content = result.get("content") or ""
    end = min(offset + limit, len(content))
    return {**result, "content": content[offset:end], "next_offset": end if end < len(content) else None}


def _digest(text: str | None) -> str | None:
    return None if text is None else hashlib.sha256(text.encode("utf-8")).hexdigest()


def _destination(base: Path, relative: str) -> Path:
    candidate = Path(relative)
    if not relative.strip() or candidate.is_absolute() or ".." in candidate.parts or any(p.lower() == ".git" for p in candidate.parts):
        raise ValueError("Path outside the local folder.")
    try:
        parent = (base / candidate).parent.resolve(strict=True)
    except (OSError, RuntimeError):
        raise ValueError("The parent folder of this file does not exist.") from None
    if not parent.is_relative_to(base):
        raise ValueError("Path outside the local folder.")
    path = parent / candidate.name
    if path.is_symlink():
        raise ValueError("Symbolic links cannot be changed.")
    return path


def _current(path: Path) -> str | None:
    if not path.exists():
        return None
    if not path.is_file():
        raise ValueError("This path is not a file.")
    data = path.read_bytes()
    if b"\0" in data:
        raise ValueError("Binary files cannot be changed.")
    return data.decode("utf-8-sig")


def prepare(run: dict, kind: str, root: str, relative: str, *, content: str | None = None,
            old_text: str = "", new_text: str = "") -> dict:
    base = allowed_root(run, root, changes=True)
    path = _destination(base, relative)
    before = _current(path)
    if kind == "local_file_patch":
        if before is None:
            raise ValueError("The file does not exist; use local_file_write to create it.")
        if not old_text or before.count(old_text) != 1:
            raise ValueError("old_text must appear exactly once in the file. Read it again and quote a unique passage.")
        after = before.replace(old_text, new_text, 1)
    else:
        after = content or ""
    if len(after.encode("utf-8")) > MAX_WRITE:
        raise ValueError("The resulting file is too large.")
    if after == before:
        raise ValueError("This change does not modify the file.")
    relative = path.relative_to(base).as_posix()
    diff = "".join(difflib.unified_diff((before or "").splitlines(True), after.splitlines(True),
                                        f"a/{relative}", f"b/{relative}"))
    return {"proposal_id": uuid.uuid4().hex, "status": "pending", "kind": kind,
            "label": ("Edit " if before is not None else "Create ") + relative, "target": str(base / relative),
            "diff": diff, "before": {"hash": _digest(before)}, "after": None,
            "action": {"kind": kind, "root": str(base), "path": relative, "content": after}}


def apply(proposal: dict) -> dict:
    action = proposal["action"]
    base = project_code.folder(action["root"])
    try:
        path = _destination(base, action["path"])
        current = _current(path)
    except ValueError as error:
        raise HTTPException(409, str(error)) from None
    if _digest(current) != proposal["before"]["hash"]:
        raise HTTPException(409, "The file changed since the proposal. Run the step again.")
    # newline="" keeps the line endings exactly as proposed (the file's own, for a patch).
    atomic_write_text(path, action["content"], newline="")
    return {"kind": action["kind"], "path": action["path"], "root": action["root"]}

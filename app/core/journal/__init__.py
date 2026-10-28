"""Append-only journal of workspace changes, with their author.

Writes are detected where they are committed (the state repository and the
collection records), so every feature is journaled without opting in. The
author comes from the calling context: ``with journal.author("agent", run=…)``.
Entries are JSON lines in ``<workspace>/.kavot-local/journal.jsonl``, local to
this computer and rotated when the file grows past ``ROTATE_BYTES``.
"""
from __future__ import annotations

import json
import os
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

ROTATE_BYTES = 4_000_000
_author: ContextVar[dict[str, Any]] = ContextVar("kavot_journal_author", default={"kind": "user"})
_lock = threading.Lock()


@contextmanager
def author(kind: str, **details: Any) -> Iterator[None]:
    """Attribute the changes made inside this block (user, agent, workflow, watcher, sync, system)."""
    token = _author.set({"kind": kind, **{k: v for k, v in details.items() if v is not None}})
    try:
        yield
    finally:
        _author.reset(token)


def journal_path() -> Path:
    from app.core.kernel.config import settings
    return settings.storage_path / ".kavot-local" / "journal.jsonl"


def _collection_ids() -> dict[str, str]:
    """State key -> public collection id (papers are the "articles" collection)."""
    from app.core.kernel.plugins import load
    return {c["state_key"]: c["id"] for c in load().collections if c.get("state_key")}


def fingerprint(state: dict[str, Any], keys: tuple[str, ...]) -> dict[str, dict[Any, str]]:
    """Cheap view of the state used to find what a write changed: id -> updated_at."""
    return {key: {item.get("id"): str(item.get("updated_at", "")) for item in state.get(key, []) if isinstance(item, dict)}
            for key in keys}


def changes(before: dict[str, dict[Any, str]], state: dict[str, Any]) -> list[dict[str, Any]]:
    names = _collection_ids()
    entries = []
    for key, old in before.items():
        items = {item.get("id"): item for item in state.get(key, []) if isinstance(item, dict)}
        for identifier, item in items.items():
            if identifier not in old:
                operation = "create"
            elif old[identifier] != str(item.get("updated_at", "")):
                operation = "trash" if item.get("trashed_at") and str(item.get("trashed_at")) == str(item.get("updated_at")) else "update"
            else:
                continue
            entries.append(_entry(names.get(key, key), identifier, operation, item))
        for identifier in old.keys() - items.keys():
            entries.append(_entry(names.get(key, key), identifier, "delete", None))
    return entries


def _entry(collection: str, identifier: Any, operation: str, item: dict | None) -> dict[str, Any]:
    entry = {"op": operation, "ref": f"kavot://{collection}/{identifier}", "collection": collection}
    title = item and (item.get("title") or item.get("name") or (item.get("values") or {}).get("title"))
    if title:
        entry["title"] = str(title)[:160]
    return entry


def record(entries: list[dict[str, Any]]) -> None:
    if not entries:
        return
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    who = _author.get()
    path = journal_path()
    lines = "".join(json.dumps({"at": stamp, "author": who, **entry}, ensure_ascii=False) + "\n" for entry in entries)
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_file() and path.stat().st_size > ROTATE_BYTES:
            os.replace(path, path.with_name(f"journal-{datetime.now(timezone.utc):%Y%m%d%H%M%S}.jsonl"))
        with path.open("a", encoding="utf-8") as handle:
            handle.write(lines)
    from app.core.search import mark_dirty
    mark_dirty()


def _tail(path: Path, max_bytes: int = 512_000) -> list[str]:
    if not path.is_file():
        return []
    with path.open("rb") as handle:
        size = handle.seek(0, os.SEEK_END)
        handle.seek(max(0, size - max_bytes))
        data = handle.read().decode("utf-8", errors="replace")
    lines = data.splitlines()
    return lines[1:] if size > max_bytes else lines


def history(ref: str | None = None, collection: str | None = None, author_kind: str | None = None,
            since: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    """Latest entries first, filtered by item address (with or without #anchor), collection or author."""
    base = ref.split("#", 1)[0] if ref else None
    found = []
    for line in reversed(_tail(journal_path())):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if base and entry.get("ref") != base:
            continue
        if collection and entry.get("collection") != collection:
            continue
        if author_kind and entry.get("author", {}).get("kind") != author_kind:
            continue
        if since and entry.get("at", "") < since:
            break
        found.append(entry)
        if len(found) >= limit:
            break
    return found


__all__ = ["author", "changes", "fingerprint", "history", "record"]

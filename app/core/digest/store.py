"""Summaries written by agents (or the user), kept so the next request need not reread the source.

A digest is tied to the content it summarizes: its ``version`` is a hash of the
item's indexed text, identical on every device. When the source changes, the
digest is reported stale and no longer shown as the item's summary. Digests
live in ``<workspace>/.meta_kavot/digests/``: they are synced and backed up,
because producing them cost tokens.
"""
from __future__ import annotations

import hashlib
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.core.kernel.files import atomic_write_json, read_json_object

SUMMARY_CHARS = 1500
SECTION_CHARS = 400
MAX_SECTIONS = 60
MAX_KEYWORDS = 12
_lock = threading.Lock()


def folder() -> Path:
    from app.core.kernel.config import settings
    return settings.storage_path / ".meta_kavot" / "digests"


def _path(collection: str, item_id: str) -> Path:
    name = hashlib.blake2b(item_id.encode(), digest_size=12).hexdigest()
    return folder() / collection / f"{name}.json"


def _parts(ref: str) -> tuple[str, str]:
    from app.core.links import parse
    parts = parse(ref)
    return parts["collection"], parts["id"]


def content_version(collection: str, item_id: str) -> str | None:
    """Hash of the item's indexed title and text, or None when the item is not indexed."""
    from app.core.search.index import ensure_fresh
    item = ensure_fresh().item(collection, item_id)
    if item is None:
        return None
    digest = hashlib.blake2b(item["title"].encode(), digest_size=12)
    for passage in item["passages"]:
        digest.update(b"\0" + passage["text"].encode())
    return digest.hexdigest()


def get(ref: str) -> dict[str, Any] | None:
    collection, item_id = _parts(ref)
    data = read_json_object(_path(collection, item_id))
    if not data:
        return None
    return {**data, "fresh": data.get("version") == content_version(collection, item_id)}


def save(ref: str, summary: str, *, sections: dict[str, str] | None = None, keywords: list[str] | None = None,
         author: dict[str, Any] | None = None) -> dict[str, Any]:
    collection, item_id = _parts(ref)
    summary = " ".join(str(summary or "").split())
    if not 20 <= len(summary) <= SUMMARY_CHARS:
        raise ValueError(f"Write a summary of 20 to {SUMMARY_CHARS} characters.")
    sections = {str(k): " ".join(str(v).split())[:SECTION_CHARS] for k, v in (sections or {}).items() if str(v).strip()}
    if len(sections) > MAX_SECTIONS:
        raise ValueError(f"At most {MAX_SECTIONS} section summaries.")
    version = content_version(collection, item_id)
    if version is None:
        raise ValueError("Unknown address, or not indexed yet. Use an address returned by search or explore.")
    from app.core.search.index import ensure_fresh
    item = ensure_fresh().item(collection, item_id)
    anchors = {p["anchor"] for p in item["passages"]}
    unknown = [anchor for anchor in sections if anchor not in anchors]
    if unknown:
        raise ValueError(f"Unknown section anchors {unknown[:5]}; use anchors from explore or read.")
    data = {"schema_version": 1, "kind": "kavot.digest", "ref": f"kavot://{collection}/{item_id}", "title": item["title"],
            "version": version, "summary": summary, "sections": sections,
            "keywords": [str(k)[:40] for k in (keywords or [])][:MAX_KEYWORDS],
            "author": author or {"kind": "user"}, "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    with _lock:
        atomic_write_json(_path(collection, item_id), data)
    return {**data, "fresh": True}


def delete(ref: str) -> bool:
    collection, item_id = _parts(ref)
    path = _path(collection, item_id)
    with _lock:
        if not path.is_file():
            return False
        path.unlink()
    return True


def list_all() -> list[dict[str, Any]]:
    found = []
    for path in sorted(folder().glob("*/*.json")):
        data = read_json_object(path)
        if not data or data.get("kind") != "kavot.digest":
            continue
        collection, item_id = _parts(data["ref"])
        found.append({k: data.get(k) for k in ("ref", "title", "summary", "author", "updated_at")}
                     | {"fresh": data.get("version") == content_version(collection, item_id), "sections": len(data.get("sections") or {})})
    return sorted(found, key=lambda item: item.get("updated_at") or "", reverse=True)

from __future__ import annotations

import re
from threading import RLock
from typing import Any

from app.core.kernel.config import settings
from app.core.kernel.files import atomic_write_json, read_json_object


# Collections of the core itself; plugins declare theirs in their manifest.
CORE_COLLECTIONS = (
    {"id": "notes", "name": "Notes", "record_kind": "note", "source": "notes/", "views": ["table", "folders", "canvas"], "tools": [],
     "storage": {"driver": "domain", "domain": "notes"}, "state_key": "notes", "position": 20, "title_field": "title",
     "agent_actions": {"create": "note_create", "update": "note_block_update / note_update / note_content_replace",
                       "organize": "note_organize", "delete": "note_delete"}},
)


def declared() -> list[dict[str, Any]]:
    """Built-in collections with their full declaration (state key, agent actions, search fields…)."""
    from app.core.kernel.plugins import load
    return sorted([*CORE_COLLECTIONS, *load().collections], key=lambda item: item.get("position", 100))


def builtins() -> list[dict[str, Any]]:
    """Built-in collections as written to databases/<id>/database.kavot.json."""
    from app.core.kernel.plugins import CATALOG_KEYS
    return [{key: item[key] for key in CATALOG_KEYS if key in item} for item in declared()]


def path(database_id: str):
    if not re.fullmatch(r"[a-z][a-z0-9_-]{1,63}", database_id):
        raise FileNotFoundError(database_id)
    return settings.databases_path / database_id / "database.kavot.json"


_catalog_lock = RLock()


def ensure_catalog() -> None:
    with _catalog_lock:
        for definition in builtins():
            target = path(definition["id"])
            current = read_json_object(target) or {}
            organization = current.get("organization", {"folders": [], "saved_views": []})
            expected = {"schema_version": 1, "kind": "kavot.database", **definition, "organization": organization}
            for key in ("icon", "removed"):
                if key in current:
                    expected[key] = current[key]
            if current != expected:
                atomic_write_json(target, expected)


def list_databases() -> list[dict[str, Any]]:
    """Collections of the workspace.

    Only built-in collections are listed: custom collections were retired (folders of notes
    replace them), and their files stay on disk untouched."""
    ensure_catalog()
    known = {definition["id"] for definition in builtins()}
    items = []
    for manifest in settings.databases_path.glob("*/database.kavot.json"):
        item = read_json_object(manifest)
        if item and item.get("kind") == "kavot.database" and item.get("id") in known and not item.get("removed"):
            items.append(item)
    order = {item["id"]: index for index, item in enumerate(builtins())}
    return sorted(items, key=lambda item: (order.get(item["id"], 999), item["name"].casefold()))


def load(database_id: str) -> dict[str, Any]:
    ensure_catalog()
    item = read_json_object(path(database_id))
    if not item or database_id not in {definition["id"] for definition in builtins()}:
        raise FileNotFoundError(database_id)
    return item


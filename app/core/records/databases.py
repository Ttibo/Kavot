from __future__ import annotations

import re
import shutil
import uuid
from threading import RLock
from typing import Any

from fastapi import HTTPException

from app.core import journal
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


def optional_builtins() -> set[str]:
    """Built-in collections the user may remove from the workspace (their data is kept and they can be restored)."""
    return {item["id"] for item in declared() if item.get("removable")}


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


def list_databases(removed: bool = False) -> list[dict[str, Any]]:
    """Collections of the workspace; with `removed`, only the built-in ones the user removed."""
    ensure_catalog()
    items = []
    for manifest in settings.databases_path.glob("*/database.kavot.json"):
        item = read_json_object(manifest)
        if item and item.get("kind") == "kavot.database" and item.get('id') not in {'resources', 'codes'} and bool(item.get("removed")) == removed:
            items.append(item)
    order = {item["id"]: index for index, item in enumerate(builtins())}
    return sorted(items, key=lambda item: (order.get(item["id"], 999), item["name"].casefold()))


def load(database_id: str) -> dict[str, Any]:
    ensure_catalog()
    item = read_json_object(path(database_id))
    if not item:
        raise FileNotFoundError(database_id)
    return item


def create(values: dict[str, Any]) -> dict[str, Any]:
    ensure_catalog()
    with _catalog_lock:
        return _create(values)


def _create(values: dict[str, Any]) -> dict[str, Any]:
    if values['id'] in {'resources', 'codes'}:
        raise FileExistsError(values['id'])
    target = path(values["id"])
    if target.exists():
        raise FileExistsError(values["id"])
    item = {"schema_version": 1, "kind": "kavot.database", **values, "source": f"databases/{values['id']}/items/", "storage": {"driver": "json-files"}, "organization": {"folders": [], "saved_views": []}}
    atomic_write_json(target, item)
    target.parent.joinpath("items").mkdir(parents=True, exist_ok=True)
    return item


def update(database_id: str, values: dict[str, Any]) -> dict[str, Any]:
    with _catalog_lock:
        item = load(database_id)
        if set(values) - {"icon"} and database_id in {builtin["id"] for builtin in builtins()}:
            raise HTTPException(422, "Only the icon of a built-in collection can change.")
        if values.get("fields") is not None:
            previous = {field["id"]: field.get("type") for field in item.get("fields", [])}
            if any(field["id"] in previous and field["type"] != previous[field["id"]] for field in values["fields"]):
                raise HTTPException(422, "The type of an existing field cannot change.")
        item.update({key: value for key, value in values.items() if value is not None})
        atomic_write_json(path(database_id), item)
        return item


def delete(database_id: str) -> None:
    """Removes a collection: optional built-ins are hidden, custom ones are moved to the collection trash."""
    with _catalog_lock:
        item = load(database_id)
        if database_id in optional_builtins():
            item["removed"] = True
            atomic_write_json(path(database_id), item)
            return
        if database_id in {builtin["id"] for builtin in builtins()}:
            raise HTTPException(422, "This built-in collection cannot be removed.")
        from app.core.records.repository import now
        trash = settings.databases_path / ".trash"
        trash.mkdir(parents=True, exist_ok=True)
        stamp = re.sub(r"[^0-9]", "", now())[:14]
        shutil.move(str(path(database_id).parent), str(trash / f"{database_id}-{stamp}-{uuid.uuid4().hex[:6]}"))


def restore(database_id: str) -> dict[str, Any]:
    """Shows again a built-in collection the user removed."""
    if database_id not in optional_builtins():
        raise FileNotFoundError(database_id)
    with _catalog_lock:
        item = load(database_id)
        item.pop("removed", None)
        atomic_write_json(path(database_id), item)
        return item


def add_folder(database_id: str, values: dict[str, Any]) -> dict[str, Any]:
    item = load(database_id)
    folder = {"id": uuid.uuid4().hex, **values}
    item["organization"]["folders"].append(folder)
    atomic_write_json(path(database_id), item)
    return folder


def _record_path(database_id: str, record_id: str):
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", record_id):
        raise FileNotFoundError(record_id)
    return path(database_id).parent / "items" / f"{record_id}.json"


def records(database_id: str, folder_id: str | None = None) -> list[dict[str, Any]]:
    database = load(database_id)
    if database.get("storage", {}).get("driver") != "json-files":
        return []
    items = [read_json_object(item) for item in path(database_id).parent.joinpath("items").glob("*.json")]
    selected = [item for item in items if item and (folder_id is None or item.get("folder_id") == folder_id)]
    return sorted(selected, key=lambda item: item.get("updated_at", ""), reverse=True)


def save_record(database_id: str, values: dict[str, Any], record_id: str | None = None) -> dict[str, Any]:
    from app.core.records.repository import now
    if database_id in {'resources', 'codes'}:
        raise HTTPException(410, 'This collection has been retired')
    database = load(database_id)
    creating = record_id is None
    record_id = record_id or uuid.uuid4().hex
    current = read_json_object(_record_path(database_id, record_id)) or {"schema_version": 1, "kind": "kavot.record", "id": record_id, "database_id": database_id, "created_at": now()}
    if database_id not in {item['id'] for item in builtins()}:
        from app.core.records.schema import initial_values, validate_values
        merged = {**(initial_values(database) if creating else {}), **current.get("values", {}), **(values.get("values") or {})}
        validate_values(database, merged)
        values = {**values, "values": merged}
    current.update(values)
    current["updated_at"] = now()
    atomic_write_json(_record_path(database_id, record_id), current)
    journal.record([journal._entry(database_id, record_id, "create" if creating else "update", current)])
    return current


def delete_record(database_id: str, record_id: str) -> None:
    try:
        target = _record_path(database_id, record_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Record not found") from error
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Record not found")
    record = read_json_object(target)
    target.unlink()
    journal.record([journal._entry(database_id, record_id, "delete", record)])

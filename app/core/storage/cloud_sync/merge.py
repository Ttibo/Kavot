"""Three-way merge of kavot.state.json, so two devices editing different records never collide.

The state file is one JSON object whose collections are lists of records with an ``id``.
Given the version both devices last agreed on (``base``) and each side's version:

- a value changed on one side only takes that side's value;
- a record changed on both sides is merged field by field; a field changed on both sides
  takes the value of the side whose record was updated last (``updated_at``);
- a record deleted on one side and left unchanged on the other is deleted; deleted on one
  side but edited on the other, it is kept (an edit is never lost to a deletion);
- two different records created with the same ``id`` (each device took the next free id)
  are both kept: the local one gets a new id, and the local references to it follow.
"""
from __future__ import annotations

import copy
from typing import Any

MISSING = object()

# Fields that point to a record of a collection, to follow a record whose id had to change.
REFERENCES: dict[str, tuple[str, ...]] = {
    "projects": ("project_id", "project_ids"),
    "notes": ("note_id", "linked_note_ids"),
    "note_folders": ("folder_id",),
    "papers": ("paper_id", "paper_ids"),
    "paper_folders": ("folder_ids",),
    "tasks": ("task_id", "task_ids"),
    "task_columns": ("column_id",),
}
# Fields that point to a record of the same collection (a parent folder).
SELF_REFERENCES = {"note_folders": ("parent_id",), "paper_folders": ("parent_id",)}


def _is_records(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, dict) and "id" in item for item in value)


def _newer(local: dict, remote: dict) -> bool:
    """True when the local record was updated last (ISO dates compare as text)."""
    return str(local.get("updated_at") or "") >= str(remote.get("updated_at") or "")


def _merge_value(base: Any, local: Any, remote: Any, prefer_local: bool) -> Any:
    if local == remote:
        return local
    if local == base:
        return remote
    if remote == base:
        return local
    if isinstance(local, dict) and isinstance(remote, dict):
        return _merge_object(base if isinstance(base, dict) else {}, local, remote, prefer_local)
    return local if prefer_local else remote


def _merge_object(base: dict, local: dict, remote: dict, prefer_local: bool) -> dict:
    result = {}
    for key in [*local, *(key for key in remote if key not in local)]:
        value = _merge_value(base.get(key, MISSING), local.get(key, MISSING), remote.get(key, MISSING), prefer_local)
        if value is not MISSING:
            result[key] = value
    return result


def _merge_records(base: list, local: list, remote: list, renamed: dict[Any, Any]) -> list:
    """Merge one collection; ``renamed`` receives {old local id: new id} for clashing creations."""
    base_by_id = {item["id"]: item for item in base}
    local_by_id = {item["id"]: item for item in local}
    remote_by_id = {item["id"]: item for item in remote}
    merged: dict[Any, dict] = {}
    moved: list[dict] = []
    for record_id in [*local_by_id, *(key for key in remote_by_id if key not in local_by_id)]:
        before = base_by_id.get(record_id, MISSING)
        mine = local_by_id.get(record_id, MISSING)
        theirs = remote_by_id.get(record_id, MISSING)
        if mine == theirs:
            value = mine
        elif mine == before:
            value = theirs
        elif theirs == before:
            value = mine
        elif mine is MISSING:
            value = theirs  # deleted here, edited there: keep the edit
        elif theirs is MISSING:
            value = mine
        elif before is MISSING:
            # Two different records created with the same id: keep both.
            value = theirs
            moved.append(mine)
        else:
            value = _merge_object(before, mine, theirs, _newer(mine, theirs))
        if value is not MISSING:
            merged[record_id] = value
    if moved:
        numeric = [key for key in merged if isinstance(key, int)]
        next_id = max(numeric, default=0) + 1
        for record in moved:
            if isinstance(record["id"], int):
                renamed[record["id"]] = next_id
                merged[next_id] = {**record, "id": next_id}
                next_id += 1
            else:
                new_id = f"{record['id']}-local"
                renamed[record["id"]] = new_id
                merged[new_id] = {**record, "id": new_id}
    return list(merged.values())


def _follow(value: Any, field: str, renamed: dict) -> Any:
    if field.endswith("_ids") and isinstance(value, list):
        return [renamed.get(item, item) for item in value]
    return renamed.get(value, value)


def merge_state(base: dict | None, local: dict, remote: dict) -> dict:
    """Merge the local and remote state files against the version both last agreed on."""
    base = base or {}
    result: dict[str, Any] = {}
    renamed_by_collection: dict[str, dict] = {}
    local_only_ids: dict[str, set] = {}
    for key in [*local, *(key for key in remote if key not in local)]:
        before, mine, theirs = base.get(key, MISSING), local.get(key, MISSING), remote.get(key, MISSING)
        if all(value is MISSING or _is_records(value) for value in (before, mine, theirs)) and not (mine == theirs):
            renamed: dict = {}
            result[key] = _merge_records(before if before is not MISSING else [], mine if mine is not MISSING else [],
                                         theirs if theirs is not MISSING else [], renamed)
            if renamed:
                renamed_by_collection[key] = renamed
            local_only_ids[key] = {item["id"] for item in (mine if mine is not MISSING else [])} - \
                {item["id"] for item in (theirs if theirs is not MISSING else [])}
        else:
            value = _merge_value(before, mine, theirs, prefer_local=True)
            if value is not MISSING:
                result[key] = value
    if renamed_by_collection:
        result = _follow_renamed(result, renamed_by_collection, local_only_ids)
    return result


def _follow_renamed(state: dict, renamed_by_collection: dict[str, dict], local_only_ids: dict[str, set]) -> dict:
    """Point the local records that referred to a renamed record at its new id."""
    state = copy.deepcopy(state)
    new_ids = {collection: set(renamed.values()) for collection, renamed in renamed_by_collection.items()}
    for collection, records in state.items():
        if not _is_records(records):
            continue
        local_records = local_only_ids.get(collection, set()) | new_ids.get(collection, set())
        for record in records:
            if record["id"] not in local_records:
                continue
            for target, fields in REFERENCES.items():
                renamed = renamed_by_collection.get(target)
                if renamed:
                    for field in fields:
                        if field in record:
                            record[field] = _follow(record[field], field, renamed)
            renamed = renamed_by_collection.get(collection)
            if renamed:
                for field in SELF_REFERENCES.get(collection, ()):
                    if field in record:
                        record[field] = _follow(record[field], field, renamed)
    return state

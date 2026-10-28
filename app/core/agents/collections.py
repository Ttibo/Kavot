"""Read-only views of collections, records and notes for MCP agents.

Every listing goes through the request's organization snapshot, so project
scope and excluded resources apply exactly as they do for proposals.
"""
from __future__ import annotations

import copy
import json

from app.core.agents import organization
from app.core.records import databases

# Built-in collections are stored by their domain; they change through domain actions.
def builtin_rows() -> dict[str, str]:
    """Built-in collection id -> kavot.state.json key of its items."""
    return {d["id"]: d["state_key"] for d in databases.declared() if d.get("state_key")}


def builtin_actions() -> dict[str, dict[str, str]]:
    return {d["id"]: d["agent_actions"] for d in databases.declared() if d.get("agent_actions")}


CUSTOM_ACTIONS = {"create": "record_create", "update": "record_update", "organize": "record_organize",
                  "delete": "record_delete", "schema": "collection_update",
                  "folders": "collection_folder_create / collection_folder_update / collection_folder_delete"}
SUMMARY_LIMIT = 400


def snapshot(run: dict) -> dict:
    """Refresh the scoped organization; proposals compare against this capture."""
    result = organization.capture(run["context"])
    run["baseline"]["organization"] = result
    return result


def _definition(snap: dict, collection_id: str) -> dict:
    definition = next((d for d in snap["collections"] if d["id"] == collection_id), None)
    if definition is None:
        raise ValueError("Collection outside this request's scope. Use list_collections for valid IDs.")
    return definition


def _short(value):
    if isinstance(value, str) and len(value) > SUMMARY_LIMIT:
        return value[:SUMMARY_LIMIT] + "…"
    if isinstance(value, list) and len(value) > 20:
        return value[:20] + ["…"]
    return value


def _rows(snap: dict, definition: dict) -> list[dict]:
    if definition["id"] in builtin_rows():
        rows = snap.get(builtin_rows()[definition["id"]], [])
        return [r for r in rows if not r.get("trashed_at")]
    return snap["collection_records"].get(definition["id"], [])


def _title(row: dict) -> str:
    return str(row.get("title") or row.get("name") or row.get("values", {}).get("title") or row["id"])


def describe(definition: dict, rows: list[dict] | None = None) -> dict:
    builtin = definition["id"] in builtin_rows()
    return {"id": definition["id"], "name": definition["name"], "icon": definition.get("icon"),
            "record_kind": definition.get("record_kind"), "builtin": builtin,
            "fields": definition.get("fields", []), "content_template": definition.get("content_template", ""),
            "folders": definition.get("organization", {}).get("folders", []),
            "views": definition.get("views", []),
            "record_count": None if rows is None else len(rows),
            "actions": builtin_actions().get(definition["id"], CUSTOM_ACTIONS)}


def catalog(run: dict) -> list[dict]:
    snap = snapshot(run)
    return [{k: v for k, v in describe(d, _rows(snap, d)).items() if k not in {"content_template", "folders"}}
            | {"field_ids": [f["id"] for f in d.get("fields", [])]}
            for d in snap["collections"]]


def collection(run: dict, collection_id: str) -> dict:
    snap = snapshot(run)
    definition = _definition(snap, collection_id)
    return describe(definition, _rows(snap, definition))


def records(run: dict, collection_id: str, query: str = "", folder_id: str | None = None,
            offset: int = 0, limit: int = 30) -> dict:
    snap = snapshot(run)
    definition = _definition(snap, collection_id)
    rows = _rows(snap, definition)
    if folder_id is not None:
        rows = [r for r in rows if str(r.get("folder_id")) == str(folder_id) or folder_id in map(str, r.get("folder_ids") or [])]
    if query.strip():
        needle = query.casefold().strip()
        rows = [r for r in rows if needle in json.dumps(r, ensure_ascii=False).casefold()]
    page = rows[offset:offset + limit]
    items = []
    for row in page:
        item = {key: _short(value) for key, value in row.items() if key != "values"}
        if "values" in row:
            item["values"] = {key: _short(value) for key, value in row["values"].items()}
        item["title"] = _title(row)
        items.append(item)
    end = offset + len(page)
    return {"collection_id": collection_id, "total": len(rows), "items": items,
            "next_offset": end if end < len(rows) else None,
            "note": "Long values are shortened; use get_record for a complete item."}


def record(run: dict, collection_id: str, record_id: str) -> dict:
    snap = snapshot(run)
    definition = _definition(snap, collection_id)
    row = next((r for r in _rows(snap, definition) if str(r["id"]) == str(record_id)), None)
    if row is None:
        raise ValueError("Item missing from this collection or outside the scope.")
    return {"collection_id": collection_id, "record": copy.deepcopy(row),
            "fields": definition.get("fields", []), "actions": builtin_actions().get(collection_id, CUSTOM_ACTIONS)}


def notes(run: dict, query: str = "", project_id: int | None = None, folder_id: int | None = None,
          offset: int = 0, limit: int = 50) -> dict:
    snap = snapshot(run)
    excluded = set(run["context"].get("excluded_resource_ids") or [])
    rows = [n for n in snap["notes"] if not n.get("trashed_at") and f"note:{n['id']}" not in excluded]
    if project_id is not None:
        rows = [n for n in rows if n.get("project_id") == project_id]
    if folder_id is not None:
        rows = [n for n in rows if n.get("folder_id") == folder_id]
    if query.strip():
        needle = query.casefold().strip()
        rows = [n for n in rows if needle in str(n.get("title") or "").casefold()
                or any(needle in str(tag).casefold() for tag in n.get("tags") or [])]
    rows.sort(key=lambda n: str(n.get("updated_at") or ""), reverse=True)
    page = rows[offset:offset + limit]
    end = offset + len(page)
    return {"total": len(rows), "next_offset": end if end < len(rows) else None,
            "notes": [{key: n.get(key) for key in ("id", "title", "project_id", "folder_id", "paper_id", "tags", "updated_at")}
                      for n in page],
            "folders": [{key: f.get(key) for key in ("id", "name", "project_id", "parent_id")} for f in snap["note_folders"]]}

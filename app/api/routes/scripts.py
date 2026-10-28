"""Note script library: user scripts that can be inserted into notes and shared as files."""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Response

from app.models.documents import NoteScriptCreate, NoteScriptFetch, NoteScriptImport, NoteScriptNetworkApproval, NoteScriptUpdate
from app.core.records.repository import json_values, now, store
from app.core.workspace import script_network

router = APIRouter(tags=["scripts"])


def _new_script(state: dict[str, Any], values: dict[str, Any]) -> dict[str, Any]:
    script = {**values, "uid": values.get("uid") or uuid.uuid4().hex, "id": store.next_id(state, "note_scripts"),
              "created_at": now(), "updated_at": now()}
    state.setdefault("note_scripts", []).append(script)
    return script


@router.get("/note-scripts")
def scripts() -> list[dict[str, Any]]:
    return store.list("note_scripts")


@router.post("/note-scripts", status_code=201)
def create_script(payload: NoteScriptCreate) -> dict[str, Any]:
    with store.transaction() as state:
        values = json_values(payload)
        if values.get("uid") and any(item.get("uid") == values["uid"] for item in state.setdefault("note_scripts", [])):
            values["uid"] = None
        return dict(_new_script(state, values))


@router.post("/note-scripts/import")
def import_scripts(payload: NoteScriptImport) -> dict[str, Any]:
    """Add shared scripts; a script already present (same uid) is updated in place."""
    created = updated = 0
    result = []
    with store.transaction() as state:
        library = state.setdefault("note_scripts", [])
        for values in json_values(payload)["scripts"]:
            existing = next((item for item in library if values.get("uid") and item.get("uid") == values["uid"]), None)
            if existing:
                existing.update(values, updated_at=now())
                updated += 1
                result.append(dict(existing))
            else:
                created += 1
                result.append(dict(_new_script(state, values)))
    return {"created": created, "updated": updated, "scripts": result}


@router.patch("/note-scripts/{script_id}")
def update_script(script_id: int, payload: NoteScriptUpdate) -> dict[str, Any]:
    values = json_values(payload, exclude_unset=True)
    if any(value is None for value in values.values()):
        raise HTTPException(422, "Script properties cannot be null")
    with store.transaction() as state:
        script = next((item for item in state.setdefault("note_scripts", []) if item["id"] == script_id), None)
        if not script:
            raise HTTPException(404, "Script not found")
        script.setdefault("uid", uuid.uuid4().hex)
        script.update(values, updated_at=now())
        return dict(script)


@router.delete("/note-scripts/{script_id}", status_code=204)
def delete_script(script_id: int) -> Response:
    with store.transaction() as state:
        scripts = state.setdefault("note_scripts", [])
        if not any(item["id"] == script_id for item in scripts):
            raise HTTPException(404, "Script not found")
        state["note_scripts"] = [item for item in scripts if item["id"] != script_id]
    return Response(status_code=204)


@router.get("/note-scripts/network/approvals")
def network_approvals() -> list[dict[str, Any]]:
    return script_network.approvals()


@router.post("/note-scripts/network/approvals", status_code=201)
def approve_network_url(payload: NoteScriptNetworkApproval) -> dict[str, Any]:
    try:
        return script_network.approve(payload.url, payload.script)
    except script_network.ScriptNetworkError as error:
        raise HTTPException(422, str(error)) from error


@router.delete("/note-scripts/network/approvals", status_code=204)
def revoke_network_url(url: str) -> Response:
    try:
        script_network.revoke(url)
    except script_network.ScriptNetworkError as error:
        raise HTTPException(422, str(error)) from error
    return Response(status_code=204)


@router.post("/note-scripts/network/fetch")
def network_fetch(payload: NoteScriptFetch) -> dict[str, Any]:
    """Proxy for kavot.fetch: only approved URLs, never local or private addresses."""
    try:
        return script_network.fetch(payload.url, payload.method, payload.headers, payload.body)
    except script_network.ScriptNetworkError as error:
        raise HTTPException(422, str(error)) from error

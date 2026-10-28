from __future__ import annotations

from typing import Any
import mimetypes

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse
from app.models.documents import DatabaseCreate, DatabaseFolderCreate, DatabaseRecordCreate, DatabaseRecordUpdate, DatabaseAppearanceUpdate
from app.core.records import databases
from app.core.records.repository import json_values


router = APIRouter(prefix="/databases", tags=["databases"])


@router.get("/resources/files/{filename}")
def resource_file(filename: str) -> FileResponse:
    root = (databases.path("resources").parent / "files").resolve()
    target = (root / filename).resolve()
    if target.parent != root or not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    inline = target.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf", ".mp4", ".webm", ".mp3", ".wav", ".ogg"}
    return FileResponse(target, filename=filename.split("-", 1)[-1], media_type=mime, content_disposition_type="inline" if inline else "attachment", headers={"X-Content-Type-Options": "nosniff"})


def _not_found(error: Exception) -> HTTPException:
    return HTTPException(status_code=404, detail="Database not found")


@router.get("")
def catalog() -> list[dict[str, Any]]:
    return databases.list_databases()


@router.get("/removed")
def removed_catalog() -> list[dict[str, Any]]:
    return databases.list_databases(removed=True)


@router.post("", status_code=201)
def create_database(payload: DatabaseCreate) -> dict[str, Any]:
    try:
        return databases.create(json_values(payload))
    except FileExistsError as error:
        raise HTTPException(status_code=409, detail="This database already exists") from error


@router.get("/{database_id}")
def get_database(database_id: str) -> dict[str, Any]:
    try:
        return databases.load(database_id)
    except FileNotFoundError as error:
        raise _not_found(error) from error


@router.patch("/{database_id}")
def update_database(database_id: str, payload: DatabaseAppearanceUpdate) -> dict[str, Any]:
    try:
        return databases.update(database_id, json_values(payload, exclude_unset=True))
    except FileNotFoundError as error:
        raise _not_found(error) from error


@router.delete("/{database_id}", status_code=204)
def delete_database(database_id: str) -> Response:
    try:
        databases.delete(database_id)
    except FileNotFoundError as error:
        raise _not_found(error) from error
    return Response(status_code=204)


@router.post("/{database_id}/restore")
def restore_database(database_id: str) -> dict[str, Any]:
    try:
        return databases.restore(database_id)
    except FileNotFoundError as error:
        raise _not_found(error) from error


@router.post("/{database_id}/folders", status_code=201)
def create_folder(database_id: str, payload: DatabaseFolderCreate) -> dict[str, Any]:
    try:
        return databases.add_folder(database_id, json_values(payload))
    except FileNotFoundError as error:
        raise _not_found(error) from error


@router.get("/{database_id}/records")
def records(database_id: str, folder_id: str | None = None) -> list[dict[str, Any]]:
    try:
        return databases.records(database_id, folder_id)
    except FileNotFoundError as error:
        raise _not_found(error) from error


@router.post("/{database_id}/records", status_code=201)
def create_record(database_id: str, payload: DatabaseRecordCreate) -> dict[str, Any]:
    return databases.save_record(database_id, json_values(payload))


@router.patch("/{database_id}/records/{record_id}")
def update_record(database_id: str, record_id: str, payload: DatabaseRecordUpdate) -> dict[str, Any]:
    return databases.save_record(database_id, json_values(payload, exclude_unset=True), record_id)


@router.delete("/{database_id}/records/{record_id}", status_code=204)
def delete_record(database_id: str, record_id: str) -> Response:
    databases.delete_record(database_id, record_id)
    return Response(status_code=204)

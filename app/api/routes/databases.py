from __future__ import annotations

from typing import Any
import mimetypes

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from app.core.records import databases


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


@router.get("")
def catalog() -> list[dict[str, Any]]:
    return databases.list_databases()

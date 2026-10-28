"""Generic reads over every collection, search, links, history and plugins."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field

from app.core import journal, links, search
from app.core.kernel import plugins
from app.core.records import api as records

router = APIRouter(tags=["records"])


def _checked(call, *args, **kwargs):
    try:
        return call(*args, **kwargs)
    except (ValueError, FileNotFoundError) as error:
        raise HTTPException(404, str(error)) from None


@router.get("/records")
def catalog() -> list[dict[str, Any]]:
    return records.catalog()


@router.get("/records/{collection}")
def list_items(collection: str, offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=500),
               fields: list[str] | None = Query(None)) -> dict[str, Any]:
    rows = _checked(records.items, collection)
    return {"total": len(rows), "items": [records.project(row, fields) for row in rows[offset:offset + limit]],
            "next_offset": offset + limit if offset + limit < len(rows) else None}


@router.get("/records/{collection}/{item_id}")
def get_item(collection: str, item_id: str) -> dict[str, Any]:
    return _checked(records.get, collection, item_id)


@router.get("/search")
def search_workspace(q: str = Query(..., min_length=1, max_length=500), collections: list[str] | None = Query(None),
                     project_id: int | None = None, mode: Literal["auto", "lexical", "semantic"] = "auto",
                     limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0)) -> dict[str, Any]:
    return search.search(q, collections=collections, project_id=project_id, mode=mode, limit=limit, offset=offset)


@router.get("/search/status")
def search_status() -> dict[str, Any]:
    return search.status()


@router.post("/search/reindex")
def reindex() -> dict[str, Any]:
    return search.ensure_fresh(force=True).stats()


@router.get("/links")
def item_links(ref: str, relation: str | None = None, direction: Literal["both", "in", "out"] = "both",
               limit: int = Query(100, ge=1, le=1000)) -> dict[str, Any]:
    return _checked(links.neighbors, ref, relation, direction, limit)


@router.get("/links/types")
def link_types() -> dict[str, Any]:
    return links.types()


@router.get("/history")
def history(ref: str | None = None, collection: str | None = None, author: str | None = None,
            limit: int = Query(50, ge=1, le=500)) -> list[dict[str, Any]]:
    return journal.history(ref, collection, author, limit=limit)


@router.get("/plugins")
def list_plugins() -> list[dict[str, Any]]:
    return plugins.public()


@router.get("/explore")
def explore(ref: str | None = None, depth: int = Query(1, ge=1, le=2), collections: list[str] | None = Query(None),
            offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=100)) -> dict[str, Any]:
    from app.core import digest
    return _checked(digest.explore, ref, depth=depth, offset=offset, limit=limit, collections=collections)


class DigestInput(BaseModel):
    ref: str = Field(min_length=10, max_length=300)
    summary: str = Field(min_length=20, max_length=1500)
    sections: dict[str, str] | None = None
    keywords: list[str] | None = Field(default=None, max_length=12)


@router.get("/digests")
def list_digests() -> list[dict[str, Any]]:
    from app.core.digest import store
    return store.list_all()


@router.get("/digests/item")
def get_digest(ref: str) -> dict[str, Any]:
    from app.core.digest import store
    found = _checked(store.get, ref)
    if not found:
        raise HTTPException(404, "No summary for this item.")
    return found


@router.put("/digests")
def save_digest(payload: DigestInput) -> dict[str, Any]:
    """A summary written or corrected by the user."""
    from app.core.digest import store
    try:
        return store.save(payload.ref, payload.summary, sections=payload.sections, keywords=payload.keywords,
                          author={"kind": "user"})
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


@router.delete("/digests", status_code=204)
def delete_digest(ref: str) -> Response:
    from app.core.digest import store
    if not _checked(store.delete, ref):
        raise HTTPException(404, "No summary for this item.")
    return Response(status_code=204)

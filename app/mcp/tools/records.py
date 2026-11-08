"""Organization (folders, projects) and collection items."""
from __future__ import annotations

from typing import Annotated, Any

from pydantic import Field

from app.mcp import actions, collections


def install(ctx) -> None:
    @ctx.tool(annotations=ctx.read_only)
    def get_organization() -> dict[str, Any]:
        """Folders, projects, collections and IDs, for organizing; call again after a creation for its ID."""
        run = ctx.run
        snapshot = actions.organization.capture(run["context"])
        run["baseline"]["organization"] = snapshot
        return {"organization": actions.organization.public(snapshot)}

    @ctx.tool(annotations=ctx.read_only)
    def list_collections() -> dict[str, Any]:
        """Collections with their field ids, item count and action names (get_collection for full fields)."""
        return {"collections": [{k: v for k, v in c.items() if k not in {"fields", "icon", "views", "record_kind"}}
                                for c in collections.catalog(ctx.run)]}

    @ctx.tool(annotations=ctx.read_only)
    def get_collection(collection_id: str) -> dict[str, Any]:
        """One collection's full definition: fields, options, defaults, folders and content template."""
        return collections.collection(ctx.run, collection_id)

    @ctx.tool(annotations=ctx.read_only)
    def list_records(collection_id: str, query: str = "", folder_id: str | None = None,
                     fields: list[str] | None = None, offset: Annotated[int, Field(ge=0)] = 0,
                     limit: Annotated[int, Field(ge=1, le=100)] = 30) -> dict[str, Any]:
        """List items of a collection (substring filter, folder); fields=[...] keeps only those fields.

        For finding items by meaning or words, search is cheaper.
        """
        from app.core.records.api import project
        result = collections.records(ctx.run, collection_id, query, folder_id, offset, limit)
        if fields:
            result["items"] = [project(item, fields) | {"title": item.get("title")} for item in result["items"]]
        result.pop("note", None)
        return result

    @ctx.tool(annotations=ctx.read_only)
    def get_record(collection_id: str, record_id: str, fields: list[str] | None = None) -> dict[str, Any]:
        """One complete item of a collection; fields=[...] keeps only those fields."""
        from app.core.records.api import project
        result = collections.record(ctx.run, collection_id, record_id)
        if fields:
            result["record"] = project(result["record"], fields)
            result.pop("fields", None)
        return result

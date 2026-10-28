"""MCP tools of the Papers plugin: the active graph's pack, watches and scholarly search."""
from __future__ import annotations

import copy
from typing import Annotated, Any, Literal

from pydantic import Field

LOOKUP_LIMIT = 30


def install(ctx) -> None:
    from app.plugins.papers import literature

    @ctx.tool(annotations=ctx.read_only)
    def get_article_pack(offset: Annotated[int, Field(ge=0)] = 0,
                         limit: Annotated[int, Field(ge=1, le=30)] = 30) -> dict[str, Any]:
        """Read the active graph's article pack, including all pages, evidence and provider warnings."""
        with ctx.lock:
            ctx.active()
            ctx.emit(ctx.run, "tool", "Graph articles read", "MCP · Kavot")
            return literature.pack(ctx.run, offset, limit)

    @ctx.tool(annotations=ctx.read_only)
    def get_watch_research_context() -> dict[str, Any]:
        """Read the selected watch draft and abstracts from its article folders.

        Use this before suggesting a watch description, topics or search keywords.
        """
        from app.plugins.papers import article_watch
        from app.core.records.repository import store
        with ctx.lock:
            ctx.active()
            draft = ctx.run["context"].get("watch_draft")
            if not isinstance(draft, dict):
                raise ValueError("No watch is being configured.")
            folder_ids = draft.get("folder_ids") or []
            if not isinstance(folder_ids, list) or len(folder_ids) > 12 or any(type(value) is not int for value in folder_ids):
                raise ValueError("Invalid watch folders.")
            state = store.read()
            known = {folder["id"] for folder in state["paper_folders"]}
            if any(value not in known for value in folder_ids):
                raise ValueError("A watch folder was not found.")
            papers = article_watch._context_papers({"folder_ids": folder_ids}, state)
            ctx.emit(ctx.run, "tool", "Watch context read", f"{len(papers)} articles")
            return {"draft": copy.deepcopy(draft), "paper_count": len(papers),
                    "papers": [{"id": p["id"], "title": p.get("title"), "doi": p.get("doi"),
                                "tags": p.get("tags") or [], "abstract": str(p.get("abstract") or "")[:1800]}
                               for p in papers[:12]]}

    def reserve_lookup(count=1):
        ctx.active()
        used = ctx.run.get("literature_lookups", 0)
        if used + count > LOOKUP_LIMIT:
            raise ValueError(f"At most {LOOKUP_LIMIT} searches or enrichments per request. Continue in a new message.")
        ctx.run["literature_lookups"] = used + count

    @ctx.tool(annotations=ctx.network_read)
    def search_articles(query: Annotated[str, Field(min_length=1, max_length=1000)],
                        limit: Annotated[int, Field(ge=1, le=30)] = 12) -> dict[str, Any]:
        """Search scholarly articles online (OpenAlex) with concise keywords; imports nothing.

        For the user's own library, use search(collections=["articles"]) instead.
        """
        with ctx.lock:
            reserve_lookup()
            ctx.emit(ctx.run, "tool", "Article search", query)
        result = literature.search(query, limit)
        with ctx.lock:
            ctx.active()
            result["articles"] = literature.register(ctx.run, result["articles"])
            return result

    @ctx.tool(annotations=ctx.network_read)
    def get_related_articles(reference_id: str | None = None,
                             direction: Literal["all", "reference", "citation"] = "all",
                             limit: Annotated[int, Field(ge=1, le=30)] = 12) -> dict[str, Any]:
        """Articles cited by (reference) or citing (citation) a catalog ID, DOI or OpenAlex ID; defaults to the selection."""
        with ctx.lock:
            ctx.active()
            node = literature.reference(ctx.run, reference_id)
            reserve_lookup()
            ctx.emit(ctx.run, "tool", "Looking for related articles", node.get("title") or reference_id or "Selected article")
        result = literature.related(node, limit, direction)
        with ctx.lock:
            ctx.active()
            result["articles"] = literature.register(ctx.run, result["articles"])
            focus = literature.register(ctx.run, [result["focus"]] if result.get("focus") else [])
            result["focus"] = focus[0] if focus else None
            allowed = {n["id"] for n in [*result["articles"], *focus]}
            result["edges"] = [e for e in result["edges"] if str(e.get("source")) in allowed and str(e.get("target")) in allowed]
            return result

    @ctx.tool(annotations=ctx.network_read)
    def get_article_details(article_ids: Annotated[list[str], Field(min_length=1, max_length=8)]) -> dict[str, Any]:
        """Abstracts and metadata for up to eight IDs from get_article_pack, DOIs or OpenAlex IDs.

        Errors are returned per article. Full text must still be read from local sources.
        """
        from concurrent.futures import ThreadPoolExecutor
        with ctx.lock:
            ctx.active()
            identifiers = list(dict.fromkeys(article_ids))
            nodes, resolved_ids, errors = [], [], []
            for identifier in identifiers:
                try:
                    nodes.append(literature.reference(ctx.run, identifier))
                    resolved_ids.append(identifier)
                except ValueError as error:
                    errors.append({"article_id": identifier, "message": str(error), "retry_tool": "get_article_pack"})
            if not nodes:
                raise ValueError(" ".join(error["message"] for error in errors))
            reserve_lookup(len(nodes))
            ctx.emit(ctx.run, "tool", "Reading abstracts", f"{len(nodes)} articles")
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(literature.details, nodes))
        with ctx.lock:
            ctx.active()
            return {"articles": literature.register(ctx.run, [
                {**result, "id": node.get("id") or result.get("openalex_id") or identifier}
                for identifier, node, result in zip(resolved_ids, nodes, results)]), "errors": errors}

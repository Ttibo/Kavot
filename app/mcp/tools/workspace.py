"""Find and read across the workspace: shared items, search, addresses, links, history, summaries."""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import Field

from app.core.kernel.config import settings
from app.core.kernel.plugins import load as load_plugins
from app.mcp import collections
from app.mcp.context_view import compact_context
from app.mcp.instructions import GUIDES
from app.mcp.schemas import NAMED_ACTIONS
from app.mcp.session import base_ref, visible_refs


def digest_hint(run: dict, note_ref: str, result: dict) -> dict:
    """Ask once per session for a summary of a note read in full that has no current one."""
    from app.core.digest import levels
    hinted = run.setdefault("digest_hints", set())
    if note_ref not in hinted and levels.needs_digest(note_ref):
        hinted.add(note_ref)
        result["digest"] = levels.SAVE_HINT
    return result


def install(ctx) -> None:
    guides = {**GUIDES, **load_plugins().agent_guides}

    @ctx.tool(annotations=ctx.read_only)
    def get_context() -> dict[str, Any]:
        """What the user is looking at in Kavot: view, project, target note, selection, canvas, graph, picked sources.

        Source text is read with read_source; items with read or get_note.
        """
        run = ctx.run
        today = datetime.now().astimezone().strftime("%A %Y-%m-%d %H:%M (UTC%z)")
        if not run["context"]:
            return {"workspace": str(settings.storage_path.resolve()), "today": today,
                    "view": "No view: a terminal agent works on the whole workspace (search, explore, read)."}
        return {"mode": run["mode"], "today": today, "context": compact_context(run["context"])}

    @ctx.tool(annotations=ctx.read_only)
    def read_source(source_id: str, offset: Annotated[int, Field(ge=0)] = 0,
                    limit: Annotated[int, Field(ge=1, le=8000)] = 6000,
                    page: Annotated[int, Field(ge=1)] | None = None) -> dict[str, Any]:
        """Read a source picked in the conversation by its id, in chunks; for a PDF pass a page (omit it to list pages)."""
        run = ctx.run
        source = next((s for s in run["context"].get("sources", []) if s["id"] == source_id), None)
        if source is None:
            raise ValueError("Source missing from the context. Use search and read for other items.")
        text, truncated = source.get("text", ""), source.get("truncated", False)
        if "pages" in source:
            if page is None:
                return {"source_id": source_id, "pages": [p["page"] for p in source["pages"]],
                        "evidence": source.get("evidence"), "warnings": source.get("warnings", [])}
            selected = next((p for p in source["pages"] if p["page"] == page), None)
            if selected is None:
                raise ValueError("Page not in the available extraction.")
            text, truncated = selected["text"], selected.get("truncated", False)
        elif page is not None:
            raise ValueError("This source has no pages.")
        elif source.get("note_id"):
            baseline = run["baseline"]["notes"].get(str(source["note_id"]))
            if baseline:
                text, truncated = baseline["text"], False
        end = min(offset + limit, len(text))
        result = {"source_id": source_id, "text": text[offset:end], "page": page,
                  "next_offset": end if end < len(text) else None, "source_truncated": truncated,
                  "evidence": source.get("evidence"), "href": source.get("href"), "warnings": source.get("warnings", [])}
        if source.get("note_id") and end >= len(text):
            return digest_hint(run, f"kavot://notes/{source['note_id']}", result)
        return result

    @ctx.tool(annotations=ctx.read_only)
    def workspace_overview() -> dict[str, Any]:
        """Collections with item counts, projects, recent changes, guide topics and search status, in one call."""
        from app.core import journal
        from app.core.search import status
        run = ctx.run
        catalog = collections.catalog(run)
        snap = run["baseline"]["organization"]
        history = journal.history(limit=8)
        return {"collections": [{"id": c["id"], "name": c["name"], "count": c.get("record_count"), "builtin": c["builtin"]} for c in catalog],
                "projects": [{"id": p["id"], "name": p.get("name")} for p in snap.get("projects", [])][:50],
                "recent_changes": [{"at": e["at"], "by": e["author"].get("kind"), "op": e["op"], "ref": e["ref"], "title": e.get("title")} for e in history],
                "guides": sorted(guides), "search": {k: v for k, v in status().items() if k in {"documents", "vectors"}},
                "write_tools": list(NAMED_ACTIONS)}

    @ctx.tool(annotations=ctx.read_only)
    def get_guide(topic: str) -> dict[str, Any]:
        """Detailed rules for one kind of task; read once per conversation before doing it."""
        if topic not in guides:
            raise ValueError(f"Unknown topic. Topics: {', '.join(sorted(guides))}.")
        return {"topic": topic, "guide": guides[topic]}

    @ctx.tool(annotations=ctx.read_only)
    def search(query: Annotated[str, Field(min_length=1, max_length=500)],
               collections: list[str] | None = None,
               project_id: int | None = None, mode: Literal["auto", "lexical", "semantic"] = "auto",
               limit: Annotated[int, Field(ge=1, le=30)] = 8, offset: Annotated[int, Field(ge=0)] = 0) -> dict[str, Any]:
        """Search everything: notes (by passage), articles (metadata and PDF pages), tasks, collection items.

        Stages: words (accents ignored), then partial-word matching, then meaning when local
        embeddings are on. Returns snippets with kavot:// refs; open one with read(ref).
        `more` counts other matching passages of the same item.
        """
        from app.core.search import search as run_search
        allowed = visible_refs(ctx.run)
        window = (offset + limit) * 3 + 20
        result = run_search(query, collections=collections, project_id=project_id, mode=mode, limit=window, offset=0)
        hits = [hit for hit in result["hits"] if base_ref(hit["ref"]) in allowed]
        page = hits[offset:offset + limit]
        if not page:
            return {"hits": 0, "hint": "No match. Try other or fewer words, mode=semantic, or remove filters."}
        return {"stages": result["stages"], "hits": page,
                "next_offset": offset + limit if offset + limit < len(hits) else None}

    @ctx.tool(annotations=ctx.read_only)
    def read(ref: Annotated[str, Field(min_length=10, max_length=300)], fields: list[str] | None = None,
             offset: Annotated[int, Field(ge=0)] = 0,
             limit: Annotated[int, Field(ge=200, le=6000)] = 3000) -> dict[str, Any]:
        """Open a kavot:// address (from search, get_links, get_context or pasted by the user).

        Notes return text passages from the given block (#block-id) with `next`; articles
        return metadata, or one PDF page with #page-<n>; other items return their fields
        (fields=[...] keeps only some). To edit a note, use read_note.
        """
        from app.core.records import api as records
        run = ctx.run
        if base_ref(ref) not in visible_refs(run):
            raise ValueError("Unknown address. Use search to find addresses.")
        result = records.read(ref, offset=offset, limit=limit, fields=fields)
        if ref.startswith("kavot://notes/") and "#" not in ref and not result.get("next"):
            return digest_hint(run, base_ref(ref), result)
        return result

    @ctx.tool(annotations=ctx.read_only)
    def explore(ref: Annotated[str | None, Field(max_length=300)] = None,
                depth: Annotated[int, Field(ge=1, le=2)] = 1, collections: list[str] | None = None,
                offset: Annotated[int, Field(ge=0)] = 0, limit: Annotated[int, Field(ge=1, le=50)] = 20) -> dict[str, Any]:
        """Workspace map with the token cost of each child. No ref: collections, projects, themes.

        kavot://projects/<id>, kavot://collections/<id>: profile, themes, items. An item: facts,
        summary, outline (sections, pages). depth=2: children's outlines, item links.
        """
        from app.core import digest
        return digest.explore(ref, depth=depth, offset=offset, limit=limit, collections=collections,
                              allowed=visible_refs(ctx.run))

    @ctx.tool(annotations=ctx.annotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
    def save_digest(ref: Annotated[str, Field(min_length=10, max_length=300)],
                    summary: Annotated[str, Field(min_length=20, max_length=1500)],
                    sections: dict[str, Annotated[str, Field(max_length=400)]] | None = None,
                    keywords: Annotated[list[str], Field(max_length=12)] | None = None) -> dict[str, Any]:
        """Keep your summary of an item read in full; later conversations use it instead of the source.

        sections: anchor (block id, page-<n>) -> one sentence. Only what the source says.
        """
        from app.core.digest import store
        base = base_ref(ref)
        if base not in visible_refs(ctx.run):
            raise ValueError("Unknown address.")
        saved = store.save(base, summary, sections=sections, keywords=keywords, author={"kind": "agent"})
        return {"ref": saved["ref"], "saved": True, "sections": len(saved["sections"])}

    @ctx.tool(annotations=ctx.read_only)
    def get_links(ref: Annotated[str, Field(min_length=10, max_length=300)], relation: str | None = None,
                  direction: Literal["both", "in", "out"] = "both",
                  limit: Annotated[int, Field(ge=1, le=100)] = 30) -> dict[str, Any]:
        """Items linked to an address (project membership, citations, reading notes, canvas arrows…), with provenance."""
        from app.core import links
        allowed = visible_refs(ctx.run)
        if base_ref(ref) not in allowed:
            raise ValueError("Unknown address.")
        result = links.neighbors(ref, relation, direction, limit=500)
        result["links"] = [link for link in result["links"] if link["ref"] in allowed][:limit]
        result["total"] = len(result["links"])
        return result

    @ctx.tool(annotations=ctx.read_only)
    def get_history(ref: str | None = None, collection: str | None = None,
                    author: Literal["user", "agent", "workflow", "watcher", "sync", "system"] | None = None,
                    limit: Annotated[int, Field(ge=1, le=50)] = 15) -> dict[str, Any]:
        """Recent changes (latest first) of an item or a collection, with who made them."""
        from app.core import journal
        entries = journal.history(ref, collection, author, limit=limit)
        return {"entries": [{"at": e["at"], "by": e["author"], "op": e["op"], "ref": e["ref"], "title": e.get("title")} for e in entries]}

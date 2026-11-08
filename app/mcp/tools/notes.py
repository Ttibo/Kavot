"""Notes, canvases and the note script library."""
from __future__ import annotations

import copy
from typing import Annotated, Any, Literal

from pydantic import Field

from app.mcp import actions, collections
from app.mcp.session import visible_refs
from app.mcp.tools.workspace import digest_hint


def install(ctx) -> None:
    @ctx.tool(annotations=ctx.read_only)
    def list_notes(query: str = "", project_id: int | None = None, folder_id: int | None = None,
                   offset: Annotated[int, Field(ge=0)] = 0,
                   limit: Annotated[int, Field(ge=1, le=200)] = 50) -> dict[str, Any]:
        """Notes by title or tag, project or folder: IDs, a one-line gist, full size in tokens, and note folders."""
        from app.core.digest import levels
        result = collections.notes(ctx.run, query, project_id, folder_id, offset, limit)
        result["notes"] = [{**note, **levels.gist(note["id"])} for note in result["notes"]]
        return result

    @ctx.tool(annotations=ctx.read_only)
    def get_note(note_id: int, level: Literal[1, 2, 3] = 1, section: str | None = None,
                 limit: Annotated[int, Field(ge=500, le=12000)] = 6000) -> dict[str, Any]:
        """A note at the depth the request needs: 1 brief (place, relations, gist, cost of deeper levels),
        2 summary and outline with a gist per section, 3 text window by window (section=<block id> for one part).
        """
        from app.core.digest import levels
        run = ctx.run
        address = levels.ref(note_id)
        allowed = visible_refs(run)
        if address not in allowed:
            raise ValueError("Unknown note. Use list_notes or search.")
        if level == 1:
            return levels.brief(note_id, allowed)
        if level == 2:
            return levels.detail(note_id, allowed)
        result = levels.content(note_id, section, limit)
        return digest_hint(run, address, result) if not section and not result.get("next") else result

    @ctx.tool(annotations=ctx.read_only)
    def read_note(note_id: int, offset: Annotated[int, Field(ge=0)] = 0,
                  limit: Annotated[int, Field(ge=1, le=20000)] = 10000) -> dict[str, Any]:
        """A note's HTML body with stable block ids, in chunks; needed before editing the note."""
        run = ctx.run
        note = actions.load_note(run, note_id)
        text = note["text"]
        end = min(offset + limit, len(text))
        result = {"note_id": note_id, "title": note.get("title"), "path": note["path"],
                  "html": text[offset:end], "next_offset": end if end < len(text) else None,
                  "properties": note.get("metadata", {}).get("properties", {}),
                  "presentation": note.get("metadata", {}).get("presentation", {})}
        return digest_hint(run, f"kavot://notes/{note_id}", result) if end >= len(text) else result

    @ctx.tool(annotations=ctx.read_only)
    def get_canvas(project_id: int) -> dict[str, Any]:
        """A project canvas: cards (note_id, title), positions and relations; its path is what canvas_edit expects."""
        from app.core.projects import canvas as agent_canvas
        run = ctx.run
        if not any(p["id"] == project_id for p in run["baseline"]["organization"].get("projects", [])):
            raise ValueError("Unknown project; see get_organization.")
        relative = agent_canvas.project_canvas(project_id)
        content = agent_canvas.read(relative)
        run["baseline"]["canvases"][relative] = content  # Later edits compare against what the agent saw.
        return agent_canvas.public(content, relative)

    @ctx.tool(annotations=ctx.read_only)
    def get_note_format_guide() -> dict[str, Any]:
        """Everything the note editor keeps: text styles, layouts, embeds, scripts and note settings."""
        from app.core.workspace import note_format
        return note_format.guide()

    @ctx.tool(annotations=ctx.read_only)
    def list_scripts(query: str = "") -> dict[str, Any]:
        """The note script library (id, name, description, tags); get_script returns the code."""
        from app.core.records.repository import store
        needle = query.casefold().strip()
        scripts = [s for s in store.list("note_scripts") if not needle or needle in
                   " ".join([str(s.get("name")), str(s.get("description")), *map(str, s.get("tags") or [])]).casefold()]
        return {"scripts": [{k: s.get(k) for k in ("id", "name", "description", "author", "tags", "updated_at")} for s in scripts]}

    @ctx.tool(annotations=ctx.read_only)
    def get_script(script_id: int) -> dict[str, Any]:
        """One library script with its HTML, CSS and JavaScript."""
        from app.core.records.repository import store
        script = next((s for s in store.list("note_scripts") if s["id"] == script_id), None)
        if script is None:
            raise ValueError("Library script not found. Use list_scripts.")
        return copy.deepcopy(script)

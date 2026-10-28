"""MCP tools of the Planning plugin, installed on each agent run's server."""
from __future__ import annotations

from datetime import date
from typing import Annotated, Any, Literal

from pydantic import Field


def install(ctx) -> None:
    from app.core.agents import collections
    from app.core.records.repository import store
    from app.plugins.planning import calendar

    @ctx.tool(annotations=ctx.read_only)
    def list_tasks(project_id: int | None = None, status: Literal["todo", "doing", "done"] | None = None,
                   query: str = "", offset: Annotated[int, Field(ge=0)] = 0,
                   limit: Annotated[int, Field(ge=1, le=200)] = 50) -> dict[str, Any]:
        """Tasks in scope (status, dates, column) and the board columns."""
        with ctx.lock:
            ctx.active()
            tasks = [t for t in collections.snapshot(ctx.run)["tasks"] if not t.get("archived_at")]
            if project_id is not None:
                tasks = [t for t in tasks if t.get("project_id") == project_id]
            if status:
                tasks = [t for t in tasks if t.get("status") == status]
            if query.strip():
                tasks = [t for t in tasks if query.casefold().strip() in (str(t.get("title")) + " " + str(t.get("description"))).casefold()]
            tasks.sort(key=lambda t: (t.get("due_date") or "9999", t.get("title") or ""))
            page = tasks[offset:offset + limit]
            ctx.emit(ctx.run, "tool", "Tasks listed", query or "MCP · Kavot")
            return ctx.compact({"total": len(tasks), "next_offset": offset + limit if offset + limit < len(tasks) else None,
                    "tasks": [{k: t.get(k) for k in ("id", "title", "status", "priority", "column_id", "project_id",
                               "start_date", "due_date", "labels")} | {"description": str(t.get("description") or "")[:200]}
                              for t in page],
                    "columns": [{k: c.get(k) for k in ("id", "name", "is_done")} for c in store.list("task_columns")]})

    @ctx.tool(annotations=ctx.read_only)
    def list_events(start: str, end: str, project_id: int | None = None) -> dict[str, Any]:
        """Calendar between two ISO dates: manual events, task dates and dated items of other collections.

        source=manual entries are editable with event_update (entity_id is their id).
        """
        with ctx.lock:
            ctx.active()
            try:
                first, last = date.fromisoformat(start[:10]), date.fromisoformat(end[:10])
            except ValueError:
                raise ValueError("Use ISO dates, e.g. 2026-10-01.") from None
            if last < first or (last - first).days > 400:
                raise ValueError("Choose a period of at most 400 days, end after start.")
            scoped = ctx.run["context"].get("project_id")
            if scoped and project_id not in (None, scoped):
                raise ValueError("Project outside this request's scope.")
            events = calendar.list_events(first.isoformat(), last.isoformat(), project_id or scoped)
            ctx.emit(ctx.run, "tool", "Calendar read", f"{first} → {last}")
            return ctx.compact({"start": first.isoformat(), "end": last.isoformat(), "today": date.today().isoformat(),
                    "events": [{k: e.get(k) for k in ("source", "entity_id", "title", "starts_at", "ends_at", "all_day",
                                "location", "project_id")} for e in events][:300]})

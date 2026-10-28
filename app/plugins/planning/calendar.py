"""Calendar: manual events plus the dated items every plugin contributes."""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from app.core.kernel.registry import registry
from app.core.records.repository import json_values, store


def manual_events(state: dict[str, Any], project_id: int | None) -> list[dict[str, Any]]:
    projects = {item["id"]: item for item in state["projects"]}
    events = []
    for event in state["calendar_events"]:
        if project_id is not None and event.get("project_id") != project_id:
            continue
        events.append({**event, "source": "manual", "entity_id": event["id"], "color": projects.get(event.get("project_id"), {}).get("color", "#0d8178")})
    return events


def task_events(state: dict[str, Any], project_id: int | None) -> list[dict[str, Any]]:
    projects = {item["id"]: item for item in state["projects"]}
    events = []
    for task in state["tasks"]:
        if task.get("archived_at") or (project_id is not None and task.get("project_id") != project_id):
            continue
        for field, source in (("start_date", "task_start"), ("due_date", "task_due")):
            if task.get(field):
                events.append({"id": f"{source}:{task['id']}", "entity_id": task["id"], "source": source, "title": task["title"], "description": task.get("description", ""), "starts_at": task[field], "ends_at": None, "all_day": True, "project_id": task.get("project_id"), "color": projects.get(task.get("project_id"), {}).get("color", "#8c8c85")})
    return events


def list_events(start: str, end: str, project_id: int | None = None) -> list[dict[str, Any]]:
    state = store.read()
    events = [event for source in registry.calendar_sources for event in source(state, project_id)]
    return sorted([item for item in events if str(item["starts_at"])[:10] <= end and str(item.get("ends_at") or item["starts_at"])[:10] >= start], key=lambda value: str(value["starts_at"]))


def save_event(payload: Any, event_id: int | None = None) -> dict[str, Any]:
    values = json_values(payload)
    if values.get("ends_at") and values["ends_at"] < values["starts_at"]:
        raise HTTPException(status_code=422, detail="The event end is before its start")
    item = store.update("calendar_events", event_id, values, "Event") if event_id else store.create("calendar_events", values)
    return {**item, "source": "manual", "entity_id": item["id"], "color": "#0d8178"}

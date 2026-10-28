from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from app.core.records.repository import json_values, store


def _project_refs(state: dict[str, Any], ids: list[int]) -> list[dict[str, Any]]:
    return [item for item in state["projects"] if item["id"] in ids]


def enrich_dataset(item: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    conferences = [value for value in state["conferences"] if value["id"] in item.get("conference_ids", [])]
    return {**item, "projects": _project_refs(state, item.get("project_ids", [])), "conferences": conferences}


def enrich_conference(item: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    datasets = [value for value in state["datasets"] if value["id"] in item.get("dataset_ids", [])]
    return {**item, "datasets": datasets}


def list_datasets(project_id: int | None = None, include_archived: bool = False) -> list[dict[str, Any]]:
    state = store.read()
    items = [item for item in state["datasets"] if include_archived or item.get("access_status") != "archived"]
    if project_id is not None:
        items = [item for item in items if project_id in item.get("project_ids", [])]
    return [enrich_dataset(item, state) for item in sorted(items, key=lambda value: value["name"].casefold())]


def list_conferences(project_id: int | None = None, include_archived: bool = False) -> list[dict[str, Any]]:
    state = store.read()
    items = [item for item in state["conferences"] if include_archived or item.get("status") != "archived"]
    if project_id is not None:
        items = [item for item in items if project_id in item.get("project_ids", [])]
    return [enrich_conference(item, state) for item in sorted(items, key=lambda value: (min((entry["due_at"] for entry in value.get("deadlines", [])), default=value.get("starts_at") or "9999"), value["name"].casefold()))]


def save_research(collection: str, payload: Any, record_id: int | None = None) -> dict[str, Any]:
    values = json_values(payload)
    if collection == "conferences" and values.get("starts_at") and values.get("ends_at") and values["ends_at"] < values["starts_at"]:
        raise HTTPException(status_code=422, detail="The conference end date is before its start date")
    if collection == "conferences":
        for index, deadline in enumerate(values.get("deadlines", []), 1):
            deadline["id"] = deadline.get("id") or index
    item = store.update(collection, record_id, values, collection[:-1].title()) if record_id else store.create(collection, values)
    state = store.read()
    return enrich_conference(item, state) if collection == "conferences" else enrich_dataset(item, state)


def delete_research(collection: str, record_id: int) -> None:
    store.delete(collection, record_id, collection[:-1].title())
    with store.transaction() as state:
        if collection == "datasets":
            for conference in state["conferences"]:
                conference["dataset_ids"] = [value for value in conference.get("dataset_ids", []) if value != record_id]
        else:
            for dataset in state["datasets"]:
                dataset["conference_ids"] = [value for value in dataset.get("conference_ids", []) if value != record_id]


def calendar_events(state: dict[str, Any], project_id: int | None) -> list[dict[str, Any]]:
    """Conference dates and deadlines, for the calendar."""
    events = []
    for conference in state["conferences"]:
        if project_id is not None and project_id not in conference.get("project_ids", []):
            continue
        if conference.get("starts_at"):
            events.append({"id": f"conference:{conference['id']}", "entity_id": conference["id"], "source": "conference", "title": conference.get("acronym") or conference["name"], "starts_at": conference["starts_at"], "ends_at": conference.get("ends_at"), "all_day": True, "project_id": conference.get("project_ids", [None])[0] if conference.get("project_ids") else None, "color": "#087e86"})
        for deadline in conference.get("deadlines", []):
            events.append({"id": f"conference_deadline:{conference['id']}:{deadline['id']}", "entity_id": conference["id"], "source": "conference_deadline", "title": deadline["label"], "starts_at": deadline["due_at"], "ends_at": None, "all_day": False, "project_id": conference.get("project_ids", [None])[0] if conference.get("project_ids") else None, "color": "#c87d18"})
    return events

from __future__ import annotations

from datetime import date
from typing import Any

from app.core.records.repository import json_values, now, store


def project_map(state: dict[str, Any]) -> dict[int, dict[str, Any]]:
    return {item["id"]: item for item in state["projects"]}


def columns(state: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    state = state or store.read()
    counts = {item["id"]: 0 for item in state["task_columns"]}
    for task in state["tasks"]:
        if not task.get("archived_at") and task.get("column_id") in counts:
            counts[task["column_id"]] += 1
    return [{**item, "task_count": counts[item["id"]]} for item in sorted(state["task_columns"], key=lambda value: (value["position"], value["id"]))]


def column_for(state: dict[str, Any], column_id: int | None, status: str | None = None) -> dict[str, Any]:
    if column_id is not None:
        return next(item for item in state["task_columns"] if item["id"] == column_id)
    target = {"todo": "To do", "doing": "In progress", "done": "Done"}.get(status or "todo", "To do")
    return next((item for item in state["task_columns"] if item["name"] == target), state["task_columns"][0])


def task_status(column: dict[str, Any]) -> str:
    if column.get("is_done"):
        return "done"
    return "doing" if "progress" in column["name"].lower() else "todo"


def enrich_task(task: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    project = project_map(state).get(task.get("project_id"))
    column = next((item for item in state["task_columns"] if item["id"] == task.get("column_id")), None)
    return {
        **task,
        "project_name": project.get("name") if project else None,
        "project_color": project.get("color") if project else None,
        "column_name": column.get("name") if column else None,
        "column_color": column.get("color") if column else None,
        "column_position": column.get("position") if column else 0,
        "column_is_done": column.get("is_done") if column else False,
    }


def list_tasks(project_id: int | None = None, task_status_filter: str | None = None, archived: bool = False) -> list[dict[str, Any]]:
    state = store.read()
    items = [item for item in state["tasks"] if bool(item.get("archived_at")) == archived]
    if project_id is not None:
        items = [item for item in items if item.get("project_id") == project_id]
    if task_status_filter:
        items = [item for item in items if item.get("status") == task_status_filter]
    priority = {"high": 0, "medium": 1, "low": 2}
    return [enrich_task(item, state) for item in sorted(items, key=lambda value: (next((column["position"] for column in state["task_columns"] if column["id"] == value.get("column_id")), 99), priority.get(value.get("priority"), 1), value.get("due_date") or "9999"))]


def create_task(payload: Any) -> dict[str, Any]:
    values = json_values(payload)
    with store.transaction() as state:
        column = column_for(state, values.pop("column_id", None), values.get("status"))
        timestamp = now()
        task = {"id": store.next_id(state, "tasks"), **values, "column_id": column["id"], "status": task_status(column), "start_date": values.get("start_date") or date.today().isoformat(), "archived_at": None, "created_at": timestamp, "updated_at": timestamp}
        state["tasks"].append(task)
        return enrich_task(task, state)


def update_task(task_id: int, payload: Any) -> dict[str, Any]:
    values = json_values(payload, exclude_unset=True)
    with store.transaction() as state:
        task = next(item for item in state["tasks"] if item["id"] == task_id)
        if "column_id" in values or "status" in values:
            column = column_for(state, values.get("column_id"), values.get("status", task["status"]))
            values.update({"column_id": column["id"], "status": task_status(column)})
        task.update(values)
        task["updated_at"] = now()
        return enrich_task(task, state)

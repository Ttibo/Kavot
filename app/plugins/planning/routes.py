from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response

from app.plugins.planning.models import TaskColumnCreate, TaskColumnReorder, TaskColumnUpdate, TaskCreate, TaskUpdate
from app.plugins.planning import service as work
from app.core.records.repository import json_values, now, store


router = APIRouter(tags=["tasks"])


@router.get("/tasks")
def list_tasks(project_id: int | None = None, task_status: str | None = Query(default=None, alias="status"), archived: bool = False) -> list[dict[str, Any]]:
    return work.list_tasks(project_id, task_status, archived)


@router.post("/tasks", status_code=201)
def create_task(payload: TaskCreate) -> dict[str, Any]:
    return work.create_task(payload)


@router.patch("/tasks/{task_id}")
def update_task(task_id: int, payload: TaskUpdate) -> dict[str, Any]:
    store.find("tasks", task_id, "Task")
    try:
        return work.update_task(task_id, payload)
    except StopIteration as error:
        raise HTTPException(status_code=422, detail="Unknown task column") from error


@router.post("/tasks/{task_id}/archive")
def archive_task(task_id: int) -> dict[str, Any]:
    return store.update("tasks", task_id, {"archived_at": now()}, "Task")


@router.post("/tasks/{task_id}/restore")
def restore_task(task_id: int) -> dict[str, Any]:
    return store.update("tasks", task_id, {"archived_at": None}, "Task")


@router.delete("/tasks/{task_id}", status_code=204)
def delete_task(task_id: int) -> Response:
    store.delete("tasks", task_id, "Task")
    return Response(status_code=204)


@router.get("/task-columns")
def list_columns() -> list[dict[str, Any]]:
    return work.columns()


@router.post("/task-columns", status_code=201)
def create_column(payload: TaskColumnCreate) -> dict[str, Any]:
    values = json_values(payload)
    values.update({"position": len(store.list("task_columns")), "is_done": False})
    return store.create("task_columns", values)


@router.patch("/task-columns/{column_id}")
def update_column(column_id: int, payload: TaskColumnUpdate) -> dict[str, Any]:
    return store.update("task_columns", column_id, json_values(payload, exclude_unset=True), "Task column")


@router.delete("/task-columns/{column_id}", status_code=204)
def delete_column(column_id: int, move_to: int) -> Response:
    if column_id == move_to:
        raise HTTPException(status_code=422, detail="Choose a different destination column")
    store.find("task_columns", move_to, "Destination column")
    with store.transaction() as state:
        if len(state["task_columns"]) <= 1:
            raise HTTPException(status_code=422, detail="At least one task column is required")
        state["task_columns"] = [item for item in state["task_columns"] if item["id"] != column_id]
        for task in state["tasks"]:
            if task.get("column_id") == column_id:
                task["column_id"] = move_to
                task["status"] = work.task_status(next(column for column in state["task_columns"] if column["id"] == move_to))
    return Response(status_code=204)


@router.put("/task-columns/reorder")
def reorder_columns(payload: TaskColumnReorder) -> list[dict[str, Any]]:
    with store.transaction() as state:
        current = {item["id"] for item in state["task_columns"]}
        if set(payload.ordered_ids) != current:
            raise HTTPException(status_code=422, detail="The order must contain every task column")
        position = {column_id: index for index, column_id in enumerate(payload.ordered_ids)}
        for item in state["task_columns"]:
            item["position"] = position[item["id"]]
    return work.columns()

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class TaskCreate(BaseModel):
    project_id: int | None = None
    column_id: int | None = None
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(default="", max_length=4000)
    status: Literal["todo", "doing", "done"] = "todo"
    priority: Literal["low", "medium", "high"] = "medium"
    labels: list[str] = Field(default_factory=list)
    checklist: list[dict[str, Any]] = Field(default_factory=list)
    start_date: date | None = None
    due_date: date | None = None


class TaskUpdate(BaseModel):
    project_id: int | None = None
    column_id: int | None = None
    title: str | None = Field(default=None, min_length=1, max_length=240)
    description: str | None = Field(default=None, max_length=4000)
    status: Literal["todo", "doing", "done"] | None = None
    priority: Literal["low", "medium", "high"] | None = None
    labels: list[str] | None = None
    checklist: list[dict[str, Any]] | None = None
    start_date: date | None = None
    due_date: date | None = None


class TaskColumnCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    color: str = Field(default="#8c8c85", pattern=r"^#[0-9a-fA-F]{6}$")


class TaskColumnUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


class TaskColumnReorder(BaseModel):
    ordered_ids: list[int] = Field(min_length=1)


class CalendarEventInput(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(default="", max_length=10000)
    location: str = Field(default="", max_length=240)
    starts_at: datetime
    ends_at: datetime | None = None
    all_day: bool = True
    project_id: int | None = None

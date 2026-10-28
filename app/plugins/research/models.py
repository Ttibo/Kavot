from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field


class DeadlineInput(BaseModel):
    id: int | None = None
    kind: str = Field(default="submission", max_length=80)
    label: str = Field(min_length=1, max_length=160)
    due_at: datetime
    timezone: str = Field(default="Europe/Paris", max_length=80)
    notes: str = Field(default="", max_length=2000)


class ConferenceInput(BaseModel):
    name: str = Field(min_length=1, max_length=240)
    acronym: str = Field(default="", max_length=40)
    edition: str = Field(default="", max_length=80)
    url: str = Field(default="", max_length=1000)
    location: str = Field(default="", max_length=240)
    starts_at: date | None = None
    ends_at: date | None = None
    status: Literal["watching", "planned", "submitted", "accepted", "rejected", "archived"] = "watching"
    notes: str = Field(default="", max_length=10000)
    project_ids: list[int] = Field(default_factory=list)
    dataset_ids: list[int] = Field(default_factory=list)
    deadlines: list[DeadlineInput] = Field(default_factory=list)


class DatasetInput(BaseModel):
    name: str = Field(min_length=1, max_length=240)
    description: str = Field(default="", max_length=10000)
    url: str = Field(default="", max_length=1000)
    license: str = Field(default="", max_length=120)
    version: str = Field(default="", max_length=120)
    local_path: str = Field(default="", max_length=1000)
    access_status: Literal["available", "requested", "restricted", "archived"] = "available"
    notes: str = Field(default="", max_length=10000)
    project_ids: list[int] = Field(default_factory=list)
    conference_ids: list[int] = Field(default_factory=list)

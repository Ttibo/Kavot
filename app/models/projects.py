from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    color: str = Field(default="#087e86", pattern=r"^#[0-9a-fA-F]{6}$")
    repository_path: str = Field(default="", max_length=2000)
    repository_context_enabled: bool = False


class ProjectUpdate(BaseModel):
    repository_path: str | None = Field(default=None, max_length=2000)
    repository_context_enabled: bool | None = None
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    status: Literal["active", "paused", "archived"] | None = None


class ProjectResourceLink(BaseModel):
    resource_type: Literal["paper", "task", "conference", "dataset", "record"]
    resource_id: int | str
    database_id: str | None = None


class ProjectExternalResourceCreate(BaseModel):
    """A user-owned reference that belongs to a project, but not to Kavot data."""

    resource_type: Literal["url", "github", "overleaf", "local_path"]
    target: str = Field(min_length=1, max_length=2000)
    title: str = Field(default="", max_length=240)

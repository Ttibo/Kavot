from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field


class NoteCreate(BaseModel):
    properties: dict[str, Any] = Field(default_factory=dict)
    presentation: dict[str, Any] = Field(default_factory=dict)
    project_id: int | None = None
    paper_id: int | None = None
    folder_id: int | None = None
    template_id: int | None = None
    template_context_project_id: int | None = None
    title: str = Field(min_length=1, max_length=240)
    content: str = ""
    drawing: dict[str, Any] | None = None
    drawing_preview: str | None = Field(default=None, max_length=12_000_000)
    source_image_path: str | None = Field(default=None, max_length=4000)


class NoteUpdate(BaseModel):
    expected_hash: str | None = None
    properties: dict[str, Any] | None = None
    presentation: dict[str, Any] | None = None
    title: str | None = Field(default=None, min_length=1, max_length=240)
    content: str | None = None
    drawing: dict[str, Any] | None = None
    drawing_preview: str | None = Field(default=None, max_length=12_000_000)
    folder_id: int | None = None
    project_id: int | None = None


class NoteFolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    project_id: int | None = None
    parent_id: int | None = None
    color: str = Field(default="#b17a22", pattern=r"^#[0-9a-fA-F]{6}$")


class NoteFolderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    parent_id: int | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


class NotePlacementUpdate(BaseModel):
    project_id: int
    folder_id: int | None = None


TemplateIcon = Literal["note", "bulb", "chart", "flask", "calendar", "check", "question", "file", "task", "database", "link"]


class NoteTemplateCreate(BaseModel):
    icon: TemplateIcon = "note"
    name: str = Field(min_length=1, max_length=120)
    title_template: str = Field(min_length=1, max_length=240)
    content_template: str = Field(default="", max_length=50000)
    auto_create: bool = False
    is_article_default: bool = False
    color: str = Field(default="#087e86", pattern=r"^#[0-9a-fA-F]{6}$")


class NoteTemplateUpdate(BaseModel):
    icon: TemplateIcon | None = None
    archived: bool | None = None
    name: str | None = Field(default=None, min_length=1, max_length=120)
    title_template: str | None = Field(default=None, min_length=1, max_length=240)
    content_template: str | None = Field(default=None, max_length=50000)
    auto_create: bool | None = None
    is_article_default: bool | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


ScriptTag = Annotated[str, Field(min_length=1, max_length=40)]


class NoteScriptSource(BaseModel):
    """Where a library script comes from; "online" is reserved for a shared catalogue."""
    kind: Literal["local", "file", "example", "online"] = "local"
    url: str | None = Field(default=None, max_length=2048)
    remote_id: str | None = Field(default=None, max_length=200)


class NoteScriptCreate(BaseModel):
    uid: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{8,64}$")
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)
    author: str = Field(default="", max_length=120)
    tags: list[ScriptTag] = Field(default_factory=list, max_length=20)
    source: NoteScriptSource = Field(default_factory=NoteScriptSource)
    html: str = Field(default="", max_length=100000)
    css: str = Field(default="", max_length=100000)
    js: str = Field(default="", max_length=200000)


class NoteScriptUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    author: str | None = Field(default=None, max_length=120)
    tags: list[ScriptTag] | None = Field(default=None, max_length=20)
    source: NoteScriptSource | None = None
    html: str | None = Field(default=None, max_length=100000)
    css: str | None = Field(default=None, max_length=100000)
    js: str | None = Field(default=None, max_length=200000)


class NoteScriptImport(BaseModel):
    scripts: list[NoteScriptCreate] = Field(min_length=1, max_length=200)


class NoteScriptNetworkApproval(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    script: str = Field(default="", max_length=120)


class NoteScriptFetch(BaseModel):
    url: str = Field(min_length=1, max_length=8192)
    method: str = Field(default="GET", max_length=10)
    headers: dict[str, str] = Field(default_factory=dict, max_length=50)
    # Base64, at most 1 MB once decoded.
    body: str | None = Field(default=None, max_length=1_400_000)


class NoteTemplatePreview(BaseModel):
    title_template: str = Field(default="", max_length=240)
    content_template: str = Field(default="", max_length=50000)
    project_id: int | None = None
    paper_id: int | None = None


class NoteTemplateApply(BaseModel):
    mode: Literal["replace", "insert"] = "replace"
    cursor: int = Field(default=0, ge=0)



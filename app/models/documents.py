from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, model_validator


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


DatabaseView = Literal["table", "folders", "kanban", "calendar", "gallery", "graph", "canvas", "timeline"]
FieldKind = Literal["text", "markdown", "number", "boolean", "date", "datetime", "url", "email", "select", "tags", "file", "relation", "json", "list"]
ListColumnKind = Literal["text", "number", "boolean", "date", "url", "email", "select"]
CollectionIcon = Literal["database", "folder", "notes", "papers", "tasks", "calendar", "canvas", "conferences", "link", "local", "sparkle", "archive"]


class ListColumnDefinition(BaseModel):
    """One column of a list field: every row of the list has a value for it."""
    id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    name: str = Field(min_length=1, max_length=120)
    type: ListColumnKind = "text"
    options: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def check_options(self):
        self.name = self.name.strip()
        self.options = [option.strip() for option in self.options]
        if not self.name:
            raise ValueError("Column names are required.")
        if self.type == "select" and (not self.options or not all(self.options) or len(set(self.options)) != len(self.options)):
            raise ValueError(f"The {self.name} column needs unique, non-empty choices.")
        if self.type != "select":
            self.options = []
        return self


class DatabaseFieldDefinition(BaseModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    name: str = Field(min_length=1, max_length=120)
    type: FieldKind = "text"
    required: bool = False
    options: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(default_factory=list, max_length=50)
    default: Any = None
    columns: list[ListColumnDefinition] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def check_options_and_default(self):
        from app.core.records.schema import field_value_error
        self.options = [option.strip() for option in self.options]
        if self.type == "list":
            if not self.columns:
                raise ValueError(f"The {self.name} list needs at least one column.")
            if len({column.id for column in self.columns}) != len(self.columns):
                raise ValueError(f"The columns of {self.name} must be unique.")
        elif self.columns:
            raise ValueError(f"Only list fields can have columns ({self.name}).")
        if self.type == "select":
            if not self.options or not all(self.options):
                raise ValueError(f"The {self.name} field needs at least one choice.")
            if len(set(self.options)) != len(self.options):
                raise ValueError(f"The choices of {self.name} must be unique.")
        elif self.options:
            raise ValueError(f"Only choice fields can have options ({self.name}).")
        if self.default == "" or self.default == []:
            self.default = None
        if self.default is not None and (error := field_value_error(self.model_dump(), self.default)):
            raise ValueError(f"Invalid default value: {error}")
        return self


def _check_fields(fields: list[DatabaseFieldDefinition]) -> None:
    keys = [field.id for field in fields]
    if len(keys) != len(set(keys)):
        raise ValueError("Chaque champ doit avoir un identifiant unique.")
    if any(not field.name.strip() for field in fields):
        raise ValueError("The collection and field names are required.")
    if any(key in {"title", "content", "project_ids", "note_id", "note_path", "note_trashed", "linked_note_ids"} for key in keys):
        raise ValueError("This field ID is reserved.")


class DatabaseAppearanceUpdate(BaseModel):
    icon: CollectionIcon | None = None
    name: str | None = Field(default=None, min_length=1, max_length=120)
    fields: list[DatabaseFieldDefinition] | None = Field(default=None, max_length=100)
    content_template: str | None = Field(default=None, max_length=100_000)

    @model_validator(mode="after")
    def valid_schema(self):
        if self.name is not None and not self.name.strip():
            raise ValueError("The collection name is required.")
        if self.fields is not None:
            _check_fields(self.fields)
        return self


class DatabaseCreate(BaseModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_-]{1,63}$")
    name: str = Field(min_length=1, max_length=120)
    icon: CollectionIcon = "database"
    record_kind: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    views: list[DatabaseView] = Field(default_factory=lambda: ["table", "folders"])
    tools: list[str] = Field(default_factory=list)
    fields: list[DatabaseFieldDefinition] = Field(default_factory=list, max_length=100)
    content_template: str = Field(default="", max_length=100_000)

    @model_validator(mode="after")
    def unique_fields(self):
        if not self.name.strip():
            raise ValueError("The collection and field names are required.")
        _check_fields(self.fields)
        return self


class DatabaseFolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    parent_id: str | None = None
    color: str = Field(default="#087e86", pattern=r"^#[0-9a-fA-F]{6}$")


class DatabaseRecordCreate(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)
    folder_id: str | None = None


class DatabaseRecordUpdate(BaseModel):
    values: dict[str, Any] | None = None
    folder_id: str | None = None

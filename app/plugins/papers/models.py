from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class PaperUpdate(BaseModel):
    favorite: bool | None = None
    title: str | None = Field(default=None, min_length=1, max_length=1000)
    authors: list[str] | None = None
    abstract: str | None = None
    publication: str | None = None
    published_at: str | None = None
    doi: str | None = None
    url: str | None = None
    status: Literal["to_read", "reading", "read", "key"] | None = None
    tags: list[str] | None = None
    metadata: dict[str, Any] | None = None
    folder_id: int | None = None
    zotero_key: str | None = None
    origin: Literal["manual", "zotero", "crossref", "arxiv", "openalex", "semantic_scholar", "open_citations", "europe_pmc", "url"] | None = None
    openalex_id: str | None = None


class PaperProjectsUpdate(BaseModel):
    project_ids: list[int] = Field(default_factory=list)



class PaperFolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    parent_id: int | None = None


class PaperFolderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    parent_id: int | None = None


class ZoteroSettingsUpdate(BaseModel):
    api_key: str = Field(min_length=1, max_length=200)



class ScholarlySourceUpdate(BaseModel):
    id: Literal["openalex", "crossref", "semantic_scholar", "open_citations", "europe_pmc", "arxiv"]
    enabled: bool | None = None
    endpoint: str | None = Field(default=None, min_length=1, max_length=2000)
    auth_mode: Literal["none", "bearer", "header", "query"] | None = None
    auth_name: str | None = Field(default=None, max_length=100)
    api_key: str | None = Field(default=None, max_length=1000)
    clear_api_key: bool = False


class ScholarlySourcesUpdate(BaseModel):
    sources: list[ScholarlySourceUpdate] = Field(min_length=1, max_length=6)


class IdentifierImportRequest(BaseModel):
    identifier: str = Field(min_length=1, max_length=2000)


class PaperImportConfirm(BaseModel):
    title: str = Field(min_length=1, max_length=1000)
    authors: list[str] = Field(default_factory=list)
    abstract: str = ""
    publication: str = ""
    published_at: str = ""
    doi: str = ""
    url: str = ""
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    origin: Literal["manual", "zotero", "crossref", "arxiv", "openalex", "semantic_scholar", "open_citations", "europe_pmc", "url"] = "manual"
    zotero_key: str | None = None
    openalex_id: str | None = None
    folder_id: int | None = None
    project_ids: list[int] = Field(default_factory=list)
    relation: Literal["focus", "reference", "citation"] | None = None
    pdf_url: str | None = Field(default=None, max_length=4000)


class CitationGraphExpandRequest(BaseModel):
    title: str = Field(min_length=1, max_length=1000)
    year: int | None = None
    authors: list[str] = Field(default_factory=list)
    abstract: str = ""
    publication: str = ""
    published_at: str = ""
    doi: str = ""
    url: str = ""
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    openalex_id: str | None = None
    origin: str = "external"


class CitationNodeDetailsRequest(CitationGraphExpandRequest):
    pdf_url: str | None = Field(default=None, max_length=4000)

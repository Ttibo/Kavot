from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict, Field

from app.core.automation import collection_watchers, watchers

router = APIRouter(prefix="/watchers", tags=["watchers"])


class Source(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    type: Literal["scholarly", "web_search", "url"]
    url: str = Field(default="", max_length=2000)
    label: str = Field(default="", max_length=120)


class Target(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["collection", "note"]
    collection_id: str | None = Field(default=None, max_length=64)
    note_id: int | None = None
    position: Literal["append", "prepend"] = "append"


class WatcherInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    enabled: bool = True
    description: str = Field(default="", max_length=3000)
    instructions: str = Field(default="", max_length=8000)
    keywords: list[str] = Field(default_factory=list, max_length=20)
    topics: list[str] = Field(default_factory=list, max_length=12)
    folder_ids: list[int] = Field(default_factory=list, max_length=12)
    semantic_enabled: bool = True
    sources: list[Source] = Field(min_length=1, max_length=20)
    target: Target
    apply_mode: Literal["review", "auto"] = "review"
    allow_updates: bool = False
    max_items: int = Field(default=10, ge=1, le=50)
    interval_hours: int = Field(default=24, ge=0, le=24 * 30)
    engine: Literal["codex", "claude", "opencode"] = "claude"
    model: str = Field(default="", max_length=200)
    effort: str = Field(default="", max_length=60)
    preset: str = Field(default="", max_length=40)
    timeout_minutes: int = Field(default=20, ge=5, le=120)


@router.get("/presets")
def presets():
    return collection_watchers.PRESETS


@router.get("")
def list_watchers(collection_id: str | None = None):
    return watchers.list_watchers(collection_id)


@router.post("", status_code=201)
def create_watcher(payload: WatcherInput):
    return watchers.save(payload.model_dump())


@router.get("/{watcher_id}")
def get_watcher(watcher_id: int):
    return watchers.get(watcher_id)


@router.put("/{watcher_id}")
def update_watcher(watcher_id: int, payload: WatcherInput):
    return watchers.save(payload.model_dump(), watcher_id)


@router.delete("/{watcher_id}", status_code=204)
def delete_watcher(watcher_id: int):
    watchers.delete(watcher_id)
    return Response(status_code=204)


@router.post("/{watcher_id}/run", status_code=202)
def run_watcher(watcher_id: int):
    return watchers.run(watcher_id)


@router.post("/{watcher_id}/cancel")
def cancel_watcher(watcher_id: int):
    return watchers.cancel(watcher_id)


class SuggestionDecision(BaseModel):
    suggestion_id: str = Field(min_length=1, max_length=400)
    decision: Literal["saved", "dismissed"]


@router.post("/{watcher_id}/suggestions/decide")
def decide_suggestion(watcher_id: int, payload: SuggestionDecision):
    return watchers.decide_suggestion(watcher_id, payload.suggestion_id, payload.decision)


class ChangeDecision(BaseModel):
    run_id: str = Field(min_length=1, max_length=64)
    proposal_id: str = Field(min_length=1, max_length=64)
    decision: Literal["apply", "dismiss"]


@router.post("/{watcher_id}/changes/decide")
def decide_change(watcher_id: int, payload: ChangeDecision):
    return watchers.decide_change(watcher_id, payload.run_id, payload.proposal_id, payload.decision)


class AssistRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    engine: Literal["codex", "claude", "opencode"]
    request: str = Field(min_length=1, max_length=4000)
    collection_id: str = Field(min_length=1, max_length=64)
    draft: dict = Field(default_factory=dict)
    session_id: str | None = Field(default=None, max_length=64)


@router.post("/assist", status_code=202)
def assist(payload: AssistRequest):
    return collection_watchers.assist(payload.engine, payload.request, payload.collection_id, payload.draft, payload.session_id)

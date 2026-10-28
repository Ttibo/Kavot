from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict, Field

from app.core.automation import collection_watchers

router = APIRouter(prefix="/collection-watchers", tags=["collections"])


class WatcherSource(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    url: str = Field(min_length=8, max_length=2000)
    label: str = Field(default="", max_length=120)


class WatcherInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    collection_id: str = Field(min_length=1, max_length=64)
    engine: Literal["codex", "claude", "opencode"]
    model: str = Field(default="", max_length=200)
    effort: str = Field(default="", max_length=60)
    preset: str = Field(default="", max_length=40)
    task: str = Field(min_length=1, max_length=8000)
    sources: list[WatcherSource] = Field(default_factory=list, max_length=20)
    queries: list[str] = Field(default_factory=list, max_length=20)
    apply_mode: Literal["review", "auto"] = "review"
    allow_updates: bool = False
    max_items: int = Field(default=10, ge=1, le=50)
    interval_hours: int = Field(default=24, ge=1, le=24 * 30)
    timeout_minutes: int = Field(default=20, ge=5, le=120)
    enabled: bool = True


@router.get("/presets")
def presets():
    return collection_watchers.PRESETS


@router.get("")
def list_watchers(collection_id: str | None = None):
    return collection_watchers.list_watchers(collection_id)


@router.post("", status_code=201)
def create_watcher(payload: WatcherInput):
    return collection_watchers.save(payload.model_dump())


@router.get("/{watcher_id}")
def get_watcher(watcher_id: int):
    return collection_watchers.get(watcher_id)


@router.put("/{watcher_id}")
def update_watcher(watcher_id: int, payload: WatcherInput):
    return collection_watchers.save(payload.model_dump(), watcher_id)


@router.delete("/{watcher_id}", status_code=204)
def delete_watcher(watcher_id: int):
    collection_watchers.delete(watcher_id)
    return Response(status_code=204)


@router.post("/{watcher_id}/run", status_code=202)
def run_watcher(watcher_id: int):
    return collection_watchers.run(watcher_id)


class ChangeDecision(BaseModel):
    run_id: str = Field(min_length=1, max_length=64)
    proposal_id: str = Field(min_length=1, max_length=64)
    decision: Literal["apply", "dismiss"]


@router.post("/{watcher_id}/changes/decide")
def decide_change(watcher_id: int, payload: ChangeDecision):
    return collection_watchers.decide(watcher_id, payload.run_id, payload.proposal_id, payload.decision)


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

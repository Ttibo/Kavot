from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, Field

from app.plugins.papers import article_watch

router = APIRouter(prefix="/article-watches", tags=["library"])


class WatchInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=3000)
    topics: list[str] = Field(default_factory=list, max_length=12)
    keywords: list[str] = Field(default_factory=list, max_length=20)
    folder_ids: list[int] = Field(default_factory=list, max_length=12)
    semantic_enabled: bool = True
    enabled: bool = True
    max_suggestions: int = Field(default=10, ge=1, le=30)


@router.get("")
def list_watches():
    return article_watch.list_watches()


@router.post("", status_code=201)
def create_watch(payload: WatchInput):
    return article_watch.save(payload.model_dump())


@router.put("/{watch_id}")
def update_watch(watch_id: int, payload: WatchInput):
    return article_watch.save(payload.model_dump(), watch_id)


@router.delete("/{watch_id}", status_code=204)
def delete_watch(watch_id: int):
    article_watch.delete(watch_id)
    return Response(status_code=204)


@router.post("/{watch_id}/run")
def run_watch(watch_id: int):
    return article_watch.run(watch_id)


class DecisionInput(BaseModel):
    suggestion_id: str
    decision: Literal["saved", "dismissed"]


@router.post("/{watch_id}/suggestions/decide")
def decide(watch_id: int, payload: DecisionInput):
    return article_watch.decide(watch_id, payload.suggestion_id, payload.decision)

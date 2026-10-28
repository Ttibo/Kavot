from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, Field

from app.core.records.repository import store


router = APIRouter(prefix="/discovery/explorations", tags=["library"])


class ExplorationTabInput(BaseModel):
    direction: Literal["all", "reference", "citation"] = "all"
    seed: dict[str, Any] | None = None


class ExplorationInput(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    kind: Literal["library", "external"]
    paper_id: int | None = None
    seed: dict[str, Any] | None = None
    tabs: list[ExplorationTabInput] = Field(default_factory=list)


class ExplorationUpdate(BaseModel):
    tabs: list[ExplorationTabInput] | None = None


@router.get("")
def list_explorations() -> list[dict[str, Any]]:
    explorations = store.list("discovery_explorations")
    return sorted(explorations, key=lambda item: str(item.get("created_at", "")), reverse=True)


@router.post("", status_code=201)
def create_exploration(payload: ExplorationInput) -> dict[str, Any]:
    return store.create("discovery_explorations", payload.model_dump())


@router.put("/{exploration_id}")
def update_exploration(exploration_id: int, payload: ExplorationUpdate) -> dict[str, Any]:
    return store.update("discovery_explorations", exploration_id, payload.model_dump(exclude_unset=True), "Exploration")


@router.delete("/{exploration_id}", status_code=204)
def delete_exploration(exploration_id: int) -> Response:
    store.delete("discovery_explorations", exploration_id, "Exploration")
    return Response(status_code=204)
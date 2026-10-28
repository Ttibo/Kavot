"""Workspace search shared by the interface, the agents and workflows."""
from __future__ import annotations

from typing import Any

from app.core.search import embeddings
from app.core.search.index import ensure_fresh, mark_dirty


def search(query: str, **options: Any) -> dict[str, Any]:
    return ensure_fresh().search(query, **options)


def status() -> dict[str, Any]:
    return {**ensure_fresh().stats(), "semantic": embeddings.status()}


__all__ = ["ensure_fresh", "mark_dirty", "search", "status"]

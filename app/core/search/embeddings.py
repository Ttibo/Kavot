"""Optional local embeddings for the semantic stage of search.

Semantic search is off unless the user enables it (preference
``semantic_search``) and the optional ``fastembed`` package is installed
(``pip install "kavot[semantic]"``). Enabling it downloads a small multilingual
model once; after that, everything runs on this computer.
"""
from __future__ import annotations

import math
import threading
from array import array
from typing import Protocol

MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


class Provider(Protocol):
    name: str

    def embed(self, texts: list[str]) -> list[list[float]]: ...


class FastEmbedProvider:
    def __init__(self, model: str = MODEL):
        from fastembed import TextEmbedding
        self.name = model
        self._model = TextEmbedding(model_name=model)

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [list(map(float, vector)) for vector in self._model.embed(texts)]


_lock = threading.Lock()
_override: Provider | None = None
_cached: Provider | None = None
_failed: str | None = None


def configure(provider: Provider | None) -> None:
    """Use this provider instead of the configured one (tests, other runtimes)."""
    global _override
    _override = provider


def available() -> bool:
    try:
        import fastembed  # noqa: F401
        return True
    except ImportError:
        return False


def enabled() -> bool:
    from app.core.kernel.user_settings import load_preferences
    return bool(load_preferences().get("semantic_search"))


def provider() -> Provider | None:
    global _cached, _failed
    if _override is not None:
        return _override
    if not enabled() or not available():
        return None
    with _lock:
        if _cached is None and _failed is None:
            try:
                _cached = FastEmbedProvider()
            except Exception as error:  # A missing model download must not break lexical search.
                _failed = str(error)
        return _cached


def status() -> dict:
    return {"enabled": enabled(), "installed": available(), "model": MODEL, "error": _failed,
            "active": provider() is not None}


def pack(vector: list[float]) -> bytes:
    norm = math.sqrt(sum(value * value for value in vector)) or 1.0
    return array("f", (value / norm for value in vector)).tobytes()


def unpack(blob: bytes) -> array:
    values = array("f")
    values.frombytes(blob)
    return values


def cosine(query: array, vector: array) -> float:
    """Both vectors are stored normalized, so the dot product is the cosine."""
    return sum(a * b for a, b in zip(query, vector))

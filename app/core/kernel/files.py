"""Small, dependency-free helpers for Kavot's file-native formats."""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
import unicodedata
from pathlib import Path
from typing import Any, Dict, Optional


def atomic_write_json(path: Path, payload: Dict[str, Any]) -> None:
    """Write a JSON object without exposing a partially-written file."""
    atomic_write_text(path, json.dumps(payload, ensure_ascii=False, indent=2, default=str) + "\n")


def read_json_object(path: Path) -> Optional[Dict[str, Any]]:
    """Return a JSON object, or ``None`` for a missing/invalid document."""
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def atomic_write_text(path: Path, content: str, newline: Optional[str] = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", newline=newline, dir=path.parent, delete=False
        ) as handle:
            temporary = Path(handle.name)
            handle.write(content)
        for attempt in range(6):
            try:
                temporary.replace(path)
                return
            except OSError as error:
                # Windows readers/scanners can briefly prevent atomic replacement.
                # Keep the original intact; genuine permission errors still surface.
                if getattr(error, "winerror", None) not in {5, 32, 33} or attempt == 5:
                    raise
                time.sleep(0.01 * 2 ** attempt)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


_listings: Dict[str, Any] = {}


def prefixed_entry(root: Path, identifier: Any) -> Optional[Path]:
    """First ``<identifier>-*`` entry of ``root``, like a sorted glob.

    Listings are reused while the directory's mtime is unchanged. Recent
    mtimes are rescanned so coarse filesystem clocks cannot hide a change.
    """
    try:
        stamp = root.stat().st_mtime_ns
    except OSError:
        return None
    key = str(root)
    cached = _listings.get(key)
    if cached and cached[0] == stamp:
        index = cached[1]
    else:
        index: Dict[str, list] = {}
        for name in sorted(os.listdir(root), key=lambda value: value.casefold() if os.name == "nt" else value):
            head, separator, _ = name.partition("-")
            if separator:
                index.setdefault(head, []).append(name)
        if time.time_ns() - stamp > 2_000_000_000:
            _listings[key] = (stamp, index)
    names = index.get(str(identifier))
    return root / names[0] if names else None


def safe_name(value: str, fallback: str = "item") -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    normalized = re.sub(r"[^a-zA-Z0-9._-]+", "-", ascii_value.strip()).strip("-.")
    return (normalized[:100] or fallback).lower()


def resolve_inside(root: Path, relative: str) -> Path:
    target = (root / relative).resolve()
    if not target.is_relative_to(root.resolve()):
        raise ValueError("Invalid workspace path")
    return target

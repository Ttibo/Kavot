"""Cards of the workspace map: a few tokens that say what an item is and what descending would cost.

Levels: the workspace → a project or a collection → an item → its sections or
pages → raw text (``read``). Every card is built from data Kavot already has
(the search index, note headings, PDF extractions, collection items, file
profiles); an agent's digest, when fresh, replaces the extracted summary.
"""
from __future__ import annotations

import re
import threading
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote

from app.core.digest import profile, store, themes
from app.core.search.text import first_sentences, tokens

GIST_CHARS = 160
CHILD_GIST_CHARS = 110
OUTLINE_LIMIT = 25
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
_cache: dict[Any, dict] = {}
_lock = threading.Lock()


def _short(value: Any, limit: int = 60) -> Any:
    if isinstance(value, str):
        value = " ".join(value.split())
        return value if len(value) <= limit else value[:limit - 1] + "…"
    if isinstance(value, list):
        shown = [_short(v, 30) for v in value[:5]]
        return shown + ([f"+{len(value) - 5}"] if len(value) > 5 else [])
    return value


def file_path(item_id: str) -> Path:
    from app.core.kernel.config import settings
    from app.core.kernel.files import resolve_inside
    return resolve_inside(settings.storage_path, unquote(item_id))


def file_kind(name: str) -> str:
    suffix = PurePosixPath(name).suffix.lower()
    return ("pdf" if suffix == ".pdf" else "image" if suffix in IMAGE_SUFFIXES else
            "data" if suffix in {".csv", ".tsv", ".json"} else "text")


NUMBERED = re.compile(r"^\d+(?:\.\d+)*\.?\s+[A-ZÀ-Ý]")


def is_heading(title: str) -> bool:
    """Short, and numbered with a capital ("2.1 Methods") or a named section ("Abstract")."""
    if len(title) > 60 or len(title.split()) > 8:
        return False
    return bool(NUMBERED.match(title)) or not title[0].isdigit()


def pdf_outline(path: Path | None, base: str) -> tuple[list[dict], int]:
    """One entry per extracted page: its section headings (or first words) and its cost; and the page count."""
    from app.core.workspace import asset_metadata
    from app.core.workspace.pdf_extraction import HEADING
    if not path:
        return [], 0
    try:
        extraction = asset_metadata.read(path) or {}
    except (OSError, ValueError):
        return [], 0
    headings: dict[int, list[str]] = {}
    for section in extraction.get("sections", []):
        title = " ".join(str(section.get("title", "")).split())[:80]
        # Font-size guesses also catch title lines; numbered or named headings are reliable.
        if title and HEADING.match(title) and is_heading(title):
            headings.setdefault(section["page"], []).append(title)
    outline = []
    for page in extraction.get("pages", []):
        text = str(page.get("text", ""))
        if not text.strip():
            continue
        titles = headings.get(page["page"])
        outline.append({"ref": f"{base}#page-{page['page']}", "title": " · ".join(titles[:5]) if titles else first_sentences(text, 60),
                        "cost": tokens(len(text))})
    return outline, len(extraction.get("pages", []))


def _row(collection: str, item_id: str) -> dict | None:
    from app.core.records import api
    try:
        return api.get(collection, item_id)
    except (ValueError, FileNotFoundError):
        return None


def _facts(row: dict) -> dict[str, Any]:
    """The short fields of a record, for its card."""
    values = row.get("values") if isinstance(row.get("values"), dict) else row
    facts = {}
    for key, value in values.items():
        if key in profile.SKIP or key in {"title", "name", "description", "abstract", "notes", "project_ids", "folder_id",
                                          "folder_ids", "file_path", "trashed_at", "archived_at", "checklist"}:
            continue
        if value in (None, "", [], {}) or isinstance(value, dict):
            continue
        if isinstance(value, str) and len(value) > 120:
            continue
        facts[key] = _short(value)
        if len(facts) >= 8:
            break
    return facts


def _overlay(card: dict) -> dict:
    """Use a fresh agent digest as the card's summary; flag a stale one."""
    digest = store.get(card["ref"])
    if not digest:
        return card
    if not digest["fresh"]:
        card["stale_digest"] = True
        return card
    card["summary"] = digest["summary"]
    card["summary_by"] = {k: v for k, v in digest.get("author", {}).items() if k in {"kind", "engine", "model"}} | {"at": digest["updated_at"]}
    sections = digest.get("sections") or {}
    for entry in card.get("outline", []):
        anchor = entry["ref"].split("#", 1)[1] if "#" in entry["ref"] else ""
        if anchor in sections:
            entry["gist"] = sections[anchor]
    if digest.get("keywords"):
        card["keywords"] = digest["keywords"]
    return card


def item_card(collection: str, item_id: str, index) -> dict[str, Any]:
    """Card of one item (level 2), with its outline (level 3)."""
    from app.core.kernel.plugins import load
    item = index.item(collection, item_id)
    key = (collection, item_id, index.generation())
    with _lock:
        cached = _cache.get(key)
    if cached is not None:
        return _overlay({**cached, "outline": [dict(e) for e in cached.get("outline", [])]})
    ref = f"kavot://{collection}/{item_id}"
    passages = item["passages"] if item else []
    text = " ".join(p["text"] for p in passages)
    card: dict[str, Any] = {"ref": ref, "kind": collection, "title": item["title"] if item else item_id,
                            "cost": tokens(len(text))}
    if item and item["project_ids"]:
        card["project_ids"] = item["project_ids"]
    if collection == "notes":
        card["kind"] = "note"
        _note_outline(card, item_id)
    elif collection == "files":
        _file_card(card, item_id, passages)
    elif collection == "projects":
        card["kind"] = "project"
    else:
        row = _row(collection, item_id)
        if row:
            card["facts"] = _facts(row)
        if len(passages) > 1:
            card["outline"] = [{"ref": p["ref"], "title": first_sentences(p["text"], 60), "cost": tokens(len(p["text"]))}
                               for p in passages[1:OUTLINE_LIMIT + 1]]
    builder = load().card_builders.get(collection)
    if builder:
        builder(card, _row(collection, item_id) or {}, index)
    card.setdefault("gist", first_sentences(text, GIST_CHARS) if text else "")
    card["keywords"] = themes.keywords([text], index, limit=6) if text else []
    outline = card.get("outline") or []
    if len(outline) > OUTLINE_LIMIT:
        card["outline_more"] = len(outline) - OUTLINE_LIMIT
        card["outline"] = outline[:OUTLINE_LIMIT]
    with _lock:
        if len(_cache) > 4000:
            _cache.clear()
        _cache[key] = card
    return _overlay({**card, "outline": [dict(e) for e in card.get("outline", [])]})


def _note_outline(card: dict, item_id: str) -> None:
    from app.core.records import api
    from app.core.search.documents import html_sections
    from app.core.workspace import documents, html_documents
    from app.core.records.repository import store as state_store
    try:
        note, passages = api.note_text(item_id)
    except ValueError:
        return
    state = state_store.read()
    path = documents.note_path(note, state)
    body = html_documents.read(path.read_text(encoding="utf-8", errors="replace"), path) if path.suffix == ".html" and path.is_file() else ""
    sections = html_sections(body)
    if sections:
        card["outline"] = [{"ref": f"{card['ref']}#{s['anchor']}" if s["anchor"] else card["ref"], "title": s["title"],
                            "level": s["level"], "gist": s["lead"], "cost": tokens(s["chars"] + len(s["title"]))} for s in sections]
    elif len(passages) > 1:
        card["outline"] = [{"ref": f"{card['ref']}#{p['anchor']}", "title": first_sentences(p["text"], 60),
                            "cost": tokens(len(p["text"]))} for p in passages]
    first = next((p["text"] for p in passages if p["text"]), "")
    card["gist"] = first_sentences(first, GIST_CHARS)
    facts = {k: note.get(k) for k in ("updated_at", "paper_id") if note.get(k)}
    tags = (note.get("properties") or {}).get("tags") if isinstance(note.get("properties"), dict) else None
    if tags:
        facts["tags"] = _short(tags)
    card["facts"] = facts


def _file_card(card: dict, item_id: str, passages: list[dict]) -> None:
    name = card["title"]
    kind = file_kind(name)
    card["kind"] = kind
    try:
        path = file_path(item_id)
        stat = path.stat()
    except (OSError, ValueError):
        return
    card["facts"] = {"path": unquote(item_id), "size_kb": round(stat.st_size / 1024, 1)}
    if kind == "data":
        try:
            card["profile"] = profile.csv_file(path) if path.suffix.lower() in {".csv", ".tsv"} else profile.json_file(path)
        except (OSError, UnicodeError, ValueError) as error:
            card["profile"] = {"error": str(error)[:120]}
    elif kind == "pdf":
        outline, pages = pdf_outline(path, card["ref"])
        card["facts"]["pages"] = pages
        card["outline"] = outline
    elif kind == "image":
        from app.core.workspace import asset_metadata
        try:
            data = asset_metadata.read(path) or {}
        except (OSError, ValueError):
            data = {}
        card["facts"].update({k: data[k] for k in ("width", "height", "format") if data.get(k)})
        if not any(p["text"] for p in passages):
            card["gist"] = "Image without extracted text."
    elif len(passages) > 1:
        card["outline"] = [{"ref": p["ref"], "title": first_sentences(p["text"], 60), "cost": tokens(len(p["text"]))}
                           for p in passages]


def child(entry: dict, depth: int, index) -> dict[str, Any]:
    """One line per child of a container; with depth 2, the child's outline titles too."""
    ref = f"kavot://{entry['collection']}/{entry['item_id']}"
    line = {"ref": ref, "title": entry["title"], "cost": tokens(entry["chars"])}
    digest = store.get(ref)
    if digest and digest["fresh"]:
        line["gist"], line["by"] = first_sentences(digest["summary"], CHILD_GIST_CHARS), "agent"
    elif entry["lead"]:
        line["gist"] = first_sentences(entry["lead"], CHILD_GIST_CHARS)
    if entry["collection"] == "files":
        line["kind"] = file_kind(entry["title"])
    if depth >= 2:
        card = item_card(entry["collection"], entry["item_id"], index)
        if card.get("outline"):
            line["outline"] = [e["title"] for e in card["outline"][:8]]
        if card.get("keywords"):
            line["keywords"] = card["keywords"][:4]
    return line

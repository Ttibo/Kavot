"""One read API for every collection, built-in or custom, addressed by kavot:// refs.

Built-in collections keep their storage (kavot.state.json, note files, PDF
extractions); custom collections live in databases/<id>/items/. Callers do not
need to know which: they ask for a collection id and an item id.
"""
from __future__ import annotations

from typing import Any

from app.core.records import databases
from app.core.records.repository import store

TEXT_LIMIT = 6000


def catalog(with_counts: bool = True) -> list[dict[str, Any]]:
    state = store.read() if with_counts else {}
    declared = {d["id"]: d for d in databases.declared()}
    result = []
    for definition in databases.list_databases():
        item = declared.get(definition["id"], {})
        entry = {"id": definition["id"], "name": definition["name"], "builtin": bool(item),
                 "plugin": item.get("plugin", "core" if item else None), "title_field": item.get("title_field", "title")}
        if with_counts:
            key = item.get("state_key")
            entry["count"] = (sum(1 for row in state.get(key, []) if not row.get("trashed_at")) if key
                              else len(databases.records(definition["id"])))
        if definition.get("fields"):
            entry["fields"] = [{k: f[k] for k in ("id", "name", "type", "required", "options") if k in f} for f in definition["fields"]]
        result.append(entry)
    return result


def _state_key(collection: str) -> str | None:
    if collection == "projects":
        return "projects"
    return next((d["state_key"] for d in databases.declared() if d["id"] == collection and d.get("state_key")), None)


def items(collection: str) -> list[dict[str, Any]]:
    key = _state_key(collection)
    if key:
        return [row for row in store.read().get(key, []) if not row.get("trashed_at")]
    return databases.records(collection)


def get(collection: str, item_id: Any) -> dict[str, Any]:
    for row in items(collection):
        if str(row.get("id")) == str(item_id):
            return row
    raise ValueError(f"No item {item_id} in {collection}. Use search or list_records to find IDs.")


def project(row: dict[str, Any], fields: list[str] | None) -> dict[str, Any]:
    """Keep only the requested fields (and the id); custom records keep the shape of their values."""
    if not fields:
        return row
    if "values" in row and isinstance(row["values"], dict):
        return {"id": row["id"], "values": {k: v for k, v in row["values"].items() if k in fields},
                **{k: row[k] for k in fields if k in row and k != "values"}}
    return {"id": row.get("id"), **{k: row[k] for k in fields if k in row}}


def note_text(note_id: Any) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """A note's metadata and its text passages (anchors are block ids usable by note_block_* tools)."""
    from app.core.search.documents import html_passages
    from app.core.workspace import documents, html_documents
    state = store.read()
    note = next((n for n in state.get("notes", []) if str(n["id"]) == str(note_id) and not n.get("trashed_at")), None)
    if note is None:
        raise ValueError(f"No note {note_id}.")
    path = documents.note_path(note, state)
    source = path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""
    body = html_documents.read(source, path) if path.suffix == ".html" else "".join(f"<p>{line}</p>" for line in source.splitlines())
    return note, [{"anchor": anchor, "text": text, "blocks": blocks} for anchor, text, blocks in html_passages(body, with_blocks=True)]


def read(ref: str, *, offset: int = 0, limit: int = TEXT_LIMIT, fields: list[str] | None = None) -> dict[str, Any]:
    """Text-first reading of any address, window by window.

    - kavot://notes/<id>[#block] → passages of the note (from that block on);
    - kavot://articles/<id>#page-<n> → that PDF page; kavot://articles/<id> → metadata;
    - any other item → its fields (optionally only ``fields``).
    """
    from app.core.links import parse
    parts = parse(ref)
    collection, item_id, anchor = parts["collection"], parts["id"], parts.get("anchor", "")
    if collection == "notes":
        note, passages = note_text(item_id)
        # Any block id works: reading starts at the passage that contains it.
        start = next((i for i, p in enumerate(passages) if anchor == p["anchor"] or anchor in p["blocks"]), 0) if anchor else 0
        text, used, chosen = "", 0, []
        for passage in passages[start:]:
            if used and used + len(passage["text"]) > limit:
                break
            chosen.append({"anchor": passage["anchor"], "text": passage["text"]})
            used += len(passage["text"])
        following = passages[start + len(chosen)] if start + len(chosen) < len(passages) else None
        return {"ref": ref, "title": note.get("title"), "project_id": note.get("project_id"),
                "passages": chosen, "next": f"kavot://notes/{item_id}#{following['anchor']}" if following and following["anchor"] else None,
                "remaining_passages": len(passages) - start - len(chosen)}
    if collection == "files":
        from app.core.search.index import ensure_fresh
        item = ensure_fresh().item("files", item_id)
        if item is None:
            raise ValueError("Unknown file address. Use search or explore to find files.")
        passages = item["passages"]
        start = next((i for i, p in enumerate(passages) if p["anchor"] == anchor), 0) if anchor else 0
        chosen, used = [], 0
        for passage in passages[start:]:
            if used and used + len(passage["text"]) > limit:
                break
            chosen.append({"anchor": passage["anchor"], "text": passage["text"][:limit]})
            used += len(passage["text"])
        following = passages[start + len(chosen)] if start + len(chosen) < len(passages) else None
        return {"ref": ref, "title": item["title"], "passages": chosen,
                "next": following["ref"] if following else None, "remaining_passages": len(passages) - start - len(chosen)}
    if collection == "articles" and anchor.startswith("page-"):
        from app.core.search.index import ensure_fresh
        page = next((p for p in ensure_fresh().passages("articles", item_id) if p["anchor"] == anchor), None)
        if page is None:
            raise ValueError("Page not extracted. Read the PDF from the request's sources, or check the page number.")
        text = page["text"]
        return {"ref": ref, "text": text[offset:offset + limit],
                "next_offset": offset + limit if offset + limit < len(text) else None}
    row = get(collection, item_id)
    shown = project(row, fields)
    result = {"ref": f"kavot://{collection}/{item_id}", "item": {k: v for k, v in shown.items() if v not in (None, "", [], {})}}
    if collection == "articles":
        from app.core.search.index import ensure_fresh
        pages = [p["anchor"] for p in ensure_fresh().passages("articles", item_id) if p["anchor"].startswith("page-")]
        if pages:
            result["pdf_pages"] = f"{len(pages)} extracted pages: read kavot://articles/{item_id}#page-<n>"
    return result


__all__ = ["catalog", "get", "items", "note_text", "project", "read"]

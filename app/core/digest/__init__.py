"""Workspace map: explore from the whole workspace down to a passage, paying only for what is opened.

``explore(ref)`` answers with the card of ``ref`` and short lines for its
children, each with the token cost of opening it:

- ``kavot://workspace`` (or no ref): collections, projects, themes, recent changes;
- ``kavot://projects/<id>`` and ``kavot://collections/<id>``: summary, counts,
  data profile, themes and one line per item;
- an item (``kavot://notes/12``, ``kavot://articles/5``, ``kavot://files/…``):
  its card and outline (sections, PDF pages); ``read`` then opens raw text.
"""
from __future__ import annotations

from typing import Any

from app.core.digest import cards, profile, store, themes
from app.core.search.text import first_sentences, tokens

CHILD_LIMIT = 20


def _index():
    from app.core.search.index import ensure_fresh
    return ensure_fresh()


def _visible(entries: list[dict], allowed: set[str] | None) -> list[dict]:
    if allowed is None:
        return entries
    return [e for e in entries if f"kavot://{e['collection']}/{e['item_id']}" in allowed]


def _recent(allowed: set[str] | None, limit: int = 6, **filters) -> list[dict]:
    from app.core import journal
    entries = journal.history(limit=limit * 6, **filters)
    if allowed is not None:
        entries = [e for e in entries if e.get("ref") in allowed]
    return [{"at": e["at"][:16], "by": e["author"].get("kind"), "op": e["op"], "ref": e["ref"], "title": e.get("title")}
            for e in entries[:limit]]


def _children(entries: list[dict], depth: int, offset: int, limit: int, index) -> dict[str, Any]:
    page = entries[offset:offset + limit]
    result = {"children": [cards.child(e, depth, index) for e in page]}
    if offset + limit < len(entries):
        result["next_offset"] = offset + limit
    return result


def _themes(index, entries: list[dict], allowed, **scope) -> dict[str, Any]:
    texts = [f"{e['title']} {e['lead']}" for e in entries[:400]]
    result: dict[str, Any] = {"keywords": themes.keywords(texts, index, limit=10)}
    groups = themes.clusters(index, allowed=allowed, **scope)
    if groups:
        result["themes"] = groups
    return result


def workspace(depth: int, allowed: set[str] | None) -> dict[str, Any]:
    from app.core.records import api
    from app.core.records.repository import store as state_store
    index = _index()
    entries = _visible(index.items(), allowed)
    counts: dict[str, int] = {}
    chars: dict[str, int] = {}
    for e in entries:
        counts[e["collection"]] = counts.get(e["collection"], 0) + 1
        chars[e["collection"]] = chars.get(e["collection"], 0) + e["chars"]
    names = {c["id"]: c["name"] for c in api.catalog(with_counts=False)}
    names.update(files="Files", projects="Projects")
    state = state_store.read()
    projects = []
    for project in state.get("projects", []):
        ref = f"kavot://projects/{project['id']}"
        if allowed is not None and ref not in allowed:
            continue
        members = [e for e in _visible(index.items(project_id=project["id"]), allowed) if e["collection"] != "projects"]
        projects.append({"ref": ref, "title": project.get("name"), "items": len(members),
                         **({"gist": first_sentences(project["description"], cards.CHILD_GIST_CHARS)} if project.get("description") else {})})
    result = {"ref": "kavot://workspace", "kind": "workspace",
              "collections": [{"ref": f"kavot://collections/{c}", "title": names.get(c, c), "items": n, "cost": tokens(chars[c])}
                              for c, n in sorted(counts.items(), key=lambda kv: -kv[1]) if c != "projects"],
              "projects": projects, "recent": _recent(allowed)}
    result.update(_themes(index, entries, allowed))
    if depth >= 2:
        result["latest"] = [cards.child(e, 1, index) for e in entries[:8]]
    return result


def project(project_id: int, depth: int, offset: int, limit: int, collections: list[str] | None,
            allowed: set[str] | None) -> dict[str, Any]:
    from app.core.records.repository import store as state_store
    index = _index()
    project = next((p for p in state_store.read().get("projects", []) if p["id"] == project_id), None)
    if project is None:
        raise ValueError("Unknown project. Use explore() to list projects.")
    entries = [e for e in _visible(index.items(project_id=project_id), allowed) if e["collection"] != "projects"]
    counts: dict[str, int] = {}
    for e in entries:
        counts[e["collection"]] = counts.get(e["collection"], 0) + 1
    if collections:
        entries = [e for e in entries if e["collection"] in collections]
    result = {"ref": f"kavot://projects/{project_id}", "kind": "project", "title": project.get("name"),
              "gist": first_sentences(project.get("description") or "", cards.GIST_CHARS), "counts": counts,
              "cost": tokens(sum(e["chars"] for e in entries)), "recent": _recent(allowed)}
    result.update(_themes(index, entries, allowed, project_id=project_id))
    result.update(_children(entries, depth, offset, limit, index))
    return result


def collection(collection_id: str, depth: int, offset: int, limit: int, allowed: set[str] | None) -> dict[str, Any]:
    from app.core.records import api, databases
    index = _index()
    if collection_id == "files":
        title, rows, fields = "Files", [], None
    else:
        try:
            definition = databases.load(collection_id)
        except FileNotFoundError:
            raise ValueError("Unknown collection. Use explore() to list collections.") from None
        title, fields = definition["name"], definition.get("fields")
        rows = api.items(collection_id)
        if allowed is not None:
            rows = [r for r in rows if f"kavot://{collection_id}/{r.get('id')}" in allowed]
    entries = _visible(index.items(collection=collection_id), allowed)
    result: dict[str, Any] = {"ref": f"kavot://collections/{collection_id}", "kind": "collection", "title": title,
                              "items": len(entries), "cost": tokens(sum(e["chars"] for e in entries))}
    if fields:
        result["fields"] = {f["id"]: f.get("type", "text") for f in fields}
    if rows:
        values = [r.get("values") if isinstance(r.get("values"), dict) else r for r in rows]
        result["profile"] = profile.rows(values)
    if collection_id == "files":
        kinds: dict[str, int] = {}
        for e in entries:
            kind = cards.file_kind(e["title"])
            kinds[kind] = kinds.get(kind, 0) + 1
        result["kinds"] = kinds
    result.update(_themes(index, entries, allowed, collection=collection_id))
    result.update(_children(entries, depth, offset, limit, index))
    return result


def explore(ref: str | None = None, *, depth: int = 1, offset: int = 0, limit: int = CHILD_LIMIT,
            collections: list[str] | None = None, allowed: set[str] | None = None) -> dict[str, Any]:
    from app.core.links import parse
    depth = max(1, min(depth, 2))
    if not ref or ref.strip() in {"kavot://workspace", "kavot://"}:
        return workspace(depth, allowed)
    if ref.startswith("kavot://collections/"):
        return collection(ref.removeprefix("kavot://collections/").strip("/"), depth, offset, limit, allowed)
    parts = parse(ref)
    if allowed is not None and f"kavot://{parts['collection']}/{parts['id']}" not in allowed:
        raise ValueError("Address outside this request's scope.")
    if parts["collection"] == "projects":
        return project(int(parts["id"]), depth, offset, limit, collections, allowed)
    card = cards.item_card(parts["collection"], parts["id"], _index())
    if depth >= 2:
        from app.core import links
        try:
            neighbours = links.neighbors(ref, limit=200, allowed=None)["links"]
        except ValueError:
            neighbours = []
        if allowed is not None:
            neighbours = [n for n in neighbours if n["ref"] in allowed]
        card["links"] = [{k: n[k] for k in ("relation", "ref", "direction") if k in n} for n in neighbours[:15]]
    return card


__all__ = ["explore", "store"]

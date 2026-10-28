"""Typed links between workspace items, addressed as ``kavot://<collection>/<id>``.

For now the links are derived from the relations the workspace already stores
(project membership, fields declared as link types by plugins, citations,
canvas arrows) instead of a separate table that every feature would have to
write. Each link keeps its provenance, so a later links table can be filled
from exactly this view.
"""
from __future__ import annotations

import re
import threading
from typing import Any, Iterator

ADDRESS = re.compile(r"^kavot://(?P<collection>[a-z][a-z0-9_-]*)/(?P<id>[^#/]+)(?:/(?P<sub>[a-z]+))?(?:#(?P<anchor>.+))?$")
_cache: dict[str, Any] = {"key": None, "links": []}
_lock = threading.Lock()


def parse(address: str) -> dict[str, str]:
    match = ADDRESS.match(address.strip())
    if not match:
        raise ValueError("Use an address like kavot://notes/12, kavot://articles/5#page-3 or kavot://tasks/4.")
    return {k: v for k, v in match.groupdict().items() if v}


def address(collection: str, item_id: Any) -> str:
    return f"kavot://{collection}/{item_id}"


def _declared_collections() -> list[dict[str, Any]]:
    from app.core.records import databases
    return databases.declared()


def _state_key_to_collection() -> dict[str, str]:
    return {c["state_key"]: c["id"] for c in _declared_collections() if c.get("state_key")}


def _canvas_target(node: dict[str, Any]) -> str | None:
    if node.get("noteId") is not None:
        return address("notes", node["noteId"])
    if node.get("paperId") is not None:
        return address("articles", node["paperId"])
    if node.get("recordId") is not None:
        collection = node.get("databaseId") or ("tasks" if node.get("type") == "task" else node.get("collectionType"))
        return address(collection, node["recordId"]) if collection else None
    return None


def _derive(state: dict[str, Any]) -> Iterator[dict[str, Any]]:
    from app.core.kernel.files import read_json_object
    from app.core.kernel.plugins import load
    from app.core.projects import projects
    names = _state_key_to_collection()
    # Project membership of every built-in item.
    for key, collection in names.items():
        for item in state.get(key, []):
            if item.get("trashed_at"):
                continue
            ids = list(item.get("project_ids") or []) + ([item["project_id"]] if item.get("project_id") is not None else [])
            for project_id in dict.fromkeys(ids):
                yield {"source": address(collection, item["id"]), "relation": "in_project",
                       "target": address("projects", project_id), "provenance": f"field:{collection}.project"}
    # Fields that plugins declared as link types.
    by_id = {c["id"]: c for c in _declared_collections()}
    for link in load().link_types.values():
        field, source = link.get("field"), by_id.get(link["from"])
        if not field or not source or not source.get("state_key"):
            continue
        for item in state.get(source["state_key"], []):
            if item.get("trashed_at"):
                continue
            values = item.get(field)
            for value in values if isinstance(values, list) else ([values] if values is not None else []):
                yield {"source": address(link["from"], item["id"]), "relation": link["id"], "target": address(link["to"], value),
                       "label": link.get("label", link["id"]), "provenance": f"field:{link['from']}.{field}"}
    # Relations that plugins store in their own shape (e.g. citations).
    for source in load().link_sources:
        yield from source(state)
    # Arrows drawn on project canvases.
    for project in state.get("projects", []):
        try:
            canvas = read_json_object(projects.paths(project)["canvas"]) or {}
        except (OSError, ValueError):
            continue
        targets = {node.get("id"): _canvas_target(node) for node in canvas.get("nodes", []) if isinstance(node, dict)}
        for edge in canvas.get("edges", []):
            if not isinstance(edge, dict):
                continue
            source, target = targets.get(edge.get("fromNode")), targets.get(edge.get("toNode"))
            if source and target:
                yield {"source": source, "relation": "canvas", "target": target, "label": edge.get("label", ""),
                       "provenance": f"canvas:projects/{project['id']}"}


def all_links() -> list[dict[str, Any]]:
    from app.core.kernel.config import settings
    from app.core.records.repository import store
    state = store.read()
    try:
        stamp = settings.state_path.stat().st_mtime_ns
    except OSError:
        stamp = None
    canvases = []
    for project in state.get("projects", []):
        from app.core.projects import projects
        try:
            canvases.append(projects.paths(project)["canvas"].stat().st_mtime_ns)
        except OSError:
            pass
    key = (str(settings.state_path), stamp, tuple(canvases))
    with _lock:
        if _cache["key"] != key:
            _cache["links"], _cache["key"] = list(_derive(state)), key
        return _cache["links"]


def neighbors(ref: str, relation: str | None = None, direction: str = "both", limit: int = 50,
              allowed: set[str] | None = None) -> dict[str, Any]:
    """Links of one item, outgoing and incoming, optionally limited to some collections."""
    parts = parse(ref)
    base = address(parts["collection"], parts["id"])
    found = []
    for link in all_links():
        if relation and link["relation"] != relation:
            continue
        if direction in {"both", "out"} and link["source"] == base:
            other, way = link["target"], "out"
        elif direction in {"both", "in"} and link["target"] == base:
            other, way = link["source"], "in"
        else:
            continue
        if allowed is not None and parse(other)["collection"] not in allowed:
            continue
        found.append({"direction": way, "relation": link["relation"], "ref": other,
                      **({"label": link["label"]} if link.get("label") else {}), "provenance": link["provenance"]})
    return {"ref": base, "total": len(found), "links": found[:limit],
            "relations": sorted({link["relation"] for link in found})}


def types() -> dict[str, Any]:
    from app.core.kernel.plugins import load
    core = {"in_project": {"from": "*", "to": "projects", "label": "in project"},
            "canvas": {"from": "*", "to": "*", "label": "arrow on a project canvas"}}
    return {**core, **{key: {k: v for k, v in value.items() if k != "plugin"} for key, value in load().link_types.items()}}


__all__ = ["address", "all_links", "neighbors", "parse", "types"]

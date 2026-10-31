"""Incremental project-canvas edits for agents: place note cards and connect them.

Agents describe what to add (notes, relations, moves) instead of rewriting the
whole canvas; positions are chosen here so cards never overlap.
"""
from __future__ import annotations

import copy
import uuid

from pydantic import BaseModel, Field

from app.core.kernel.config import settings
from app.core.kernel.files import read_json_object
from app.core.projects import projects
from app.core.records.repository import store

NOTE_SIZE = (360, 240)
GAP = 80
COLOR = "#087e86"
EDGE_COLOR = "#77746d"


class CardPlacement(BaseModel):
    note_id: int
    x: float | None = None
    y: float | None = None
    near: str | None = Field(default=None, description="Place next to this card (node id or note:<id>).")
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


class Relation(BaseModel):
    source: str = Field(description="Card the arrow starts from: card id, or note:<id> for a note card.")
    target: str = Field(description="Card the arrow points to: card id, or note:<id>.")
    label: str = Field(default="", max_length=120)
    note: str = Field(default="", max_length=1000, description="Optional comment on the relation.")


class TaskPlacement(BaseModel):
    task_id: int
    x: float | None = None
    y: float | None = None
    near: str | None = Field(default=None, description="Place next to this card (node id, note:<id> or task:<id>).")


class CardMove(BaseModel):
    node: str = Field(description="Card id, or note:<id>.")
    x: float
    y: float


class CanvasEdit(BaseModel):
    add_notes: list[CardPlacement] = Field(default_factory=list, max_length=50)
    add_tasks: list[TaskPlacement] = Field(default_factory=list, max_length=50)
    connect: list[Relation] = Field(default_factory=list, max_length=100)
    move: list[CardMove] = Field(default_factory=list, max_length=100)
    remove_edges: list[str] = Field(default_factory=list, max_length=100)


class NoteCanvasPlacement(BaseModel):
    """Put a new note or task on its project's canvas and optionally link it."""
    connect_to: list[str] = Field(default_factory=list, max_length=20, description="Cards to link: card id or note:<id>.")
    label: str = Field(default="", max_length=120, description="Label of the new relations.")
    direction: str = Field(default="from_new", pattern="^(from_new|to_new)$",
                           description="from_new: new note → target; to_new: target → new note.")
    x: float | None = None
    y: float | None = None


def project_canvas(project_id: int) -> str:
    project = store.find("projects", project_id, "Project")
    path = projects.paths(project)["canvas"]
    return path.relative_to(settings.storage_path).as_posix()


def read(relative: str) -> dict:
    content = read_json_object(settings.storage_path / relative)
    if not isinstance(content, dict):
        raise ValueError("Canvas not found.")
    content.setdefault("nodes", [])
    content.setdefault("edges", [])
    return content


def public(content: dict, relative: str) -> dict:
    """What an agent needs to reason about the layout, without rendering details."""
    titles = {n["id"]: n.get("title") for n in store.read().get("notes", [])}
    nodes = [{"id": n["id"], "type": n.get("type"), "note_id": n.get("noteId"),
              "task_id": n.get("recordId") if n.get("type") == "task" else None,
              "title": titles.get(n.get("noteId")) or n.get("title") or n.get("text", "")[:80],
              "x": n.get("x"), "y": n.get("y"), "width": n.get("width"), "height": n.get("height")}
             for n in content["nodes"]]
    edges = [{"id": e["id"], "from": e.get("fromNode"), "to": e.get("toNode"), "label": e.get("label", ""),
              "note": e.get("note", "")} for e in content["edges"]]
    return {"path": relative, "nodes": nodes, "edges": edges,
            "hint": "Refer to a card by its id, as note:<note_id> or as task:<task_id>."}


def _resolve(nodes: list[dict], reference: str) -> dict:
    reference = str(reference)
    if reference.startswith("note:"):
        note_id = reference[5:]
        node = next((n for n in nodes if n.get("type") in {"note", "drawing"} and str(n.get("noteId")) == note_id), None)
    elif reference.startswith("task:"):
        task_id = reference[5:]
        node = next((n for n in nodes if n.get("type") == "task" and str(n.get("recordId")) == task_id), None)
    else:
        node = next((n for n in nodes if n["id"] == reference), None)
    if node is None:
        raise ValueError(f"Card {reference} is not on the canvas. Add the note first or use get_canvas.")
    return node


def _size(node: dict) -> tuple[float, float]:
    return float(node.get("width") or NOTE_SIZE[0]), float(node.get("height") or NOTE_SIZE[1])


def _free_spot(nodes: list[dict], near: dict | None) -> tuple[float, float]:
    """Right of the anchor card (or of everything), then downwards until nothing overlaps."""
    width, height = NOTE_SIZE
    if near is not None:
        near_width, _ = _size(near)
        x, y = float(near.get("x") or 0) + near_width + GAP, float(near.get("y") or 0)
    elif nodes:
        x = max(float(n.get("x") or 0) + _size(n)[0] for n in nodes) + GAP
        y = min(float(n.get("y") or 0) for n in nodes)
    else:
        x, y = 0.0, 0.0

    def overlaps(px: float, py: float) -> bool:
        return any(px < float(n.get("x") or 0) + _size(n)[0] + 20 and float(n.get("x") or 0) < px + width + 20
                   and py < float(n.get("y") or 0) + _size(n)[1] + 20 and float(n.get("y") or 0) < py + height + 20
                   for n in nodes if n.get("type") != "zone")
    for _ in range(200):
        if not overlaps(x, y):
            break
        y += height + 40
    return round(x), round(y)


def _note_card(note: dict, x: float, y: float, color: str | None = None) -> dict:
    return {"id": f"note-{uuid.uuid4().hex[:12]}", "type": "note", "noteId": note["id"], "title": note.get("title", ""),
            "color": color or COLOR, "x": x, "y": y, "width": NOTE_SIZE[0], "height": NOTE_SIZE[1]}


def _task_card(task: dict, x: float, y: float) -> dict:
    """Same shape as a task dragged from the Tasks collection onto a canvas."""
    return {"id": f"task-{uuid.uuid4().hex[:12]}", "type": "task", "collectionType": "task", "databaseId": "tasks",
            "recordId": task["id"], "title": task.get("title", ""), "detail": str(task.get("description") or "")[:200],
            "status": task.get("status", ""), "projectIds": [task["project_id"]] if task.get("project_id") else [],
            "url": "", "x": x, "y": y, "width": NOTE_SIZE[0], "height": NOTE_SIZE[1]}


def _edge(source: dict, target: dict, label: str = "", note: str = "") -> dict:
    return {"id": f"edge-{uuid.uuid4().hex[:12]}", "fromNode": source["id"], "toNode": target["id"],
            "toEnd": "arrow", "label": label, "note": note, "color": EDGE_COLOR}


def edit(content: dict, values: dict, notes: list[dict], tasks: list[dict] | None = None) -> dict:
    """Return the canvas after the edit; raises ValueError on unknown references."""
    result = copy.deepcopy(content)
    nodes, edges = result["nodes"], result["edges"]
    by_id = {n["id"]: n for n in notes}
    for card in values.get("add_notes", []):
        note = by_id.get(card["note_id"])
        if note is None or note.get("trashed_at"):
            raise ValueError(f"Note {card['note_id']} is not in this project. Use list_notes.")
        if any(n.get("type") in {"note", "drawing"} and n.get("noteId") == note["id"] for n in nodes):
            continue  # Already on the canvas: connections can still target it.
        near = _resolve(nodes, card["near"]) if card.get("near") else None
        x, y = (card["x"], card["y"]) if card.get("x") is not None and card.get("y") is not None else _free_spot(nodes, near)
        nodes.append(_note_card(note, x, y, card.get("color")))
    tasks_by_id = {t["id"]: t for t in tasks or []}
    for card in values.get("add_tasks", []):
        task = tasks_by_id.get(card["task_id"])
        if task is None or task.get("archived_at"):
            raise ValueError(f"Task {card['task_id']} is not in this project. Use list_tasks.")
        if any(n.get("type") == "task" and n.get("recordId") == task["id"] for n in nodes):
            continue
        near = _resolve(nodes, card["near"]) if card.get("near") else None
        x, y = (card["x"], card["y"]) if card.get("x") is not None and card.get("y") is not None else _free_spot(nodes, near)
        nodes.append(_task_card(task, x, y))
    for move in values.get("move", []):
        node = _resolve(nodes, move["node"])
        node["x"], node["y"] = round(move["x"]), round(move["y"])
    removed = set(values.get("remove_edges", []))
    if removed - {e["id"] for e in edges}:
        raise ValueError("Unknown relation id in remove_edges. Use get_canvas.")
    result["edges"] = edges = [e for e in edges if e["id"] not in removed]
    for relation in values.get("connect", []):
        source, target = _resolve(nodes, relation["source"]), _resolve(nodes, relation["target"])
        if source["id"] == target["id"]:
            raise ValueError("A relation needs two different cards.")
        if any(e.get("fromNode") == source["id"] and e.get("toNode") == target["id"] and e.get("label", "") == relation.get("label", "") for e in edges):
            continue
        edges.append(_edge(source, target, relation.get("label", ""), relation.get("note", "")))
    return result


def changes(before: dict, after: dict, relative: str) -> dict:
    """What an edit added, moved or removed: the agent's confirmation, so it needs no get_canvas to check."""
    def card(n: dict) -> dict:
        return {k: n.get(k) for k in ("id", "noteId", "recordId", "x", "y", "width", "height") if n.get(k) is not None}

    def arrow(e: dict) -> dict:
        return {"id": e["id"], "from": e.get("fromNode"), "to": e.get("toNode"), "label": e.get("label") or None}
    old_nodes = {n["id"]: n for n in before.get("nodes", [])}
    old_edges = {e["id"] for e in before.get("edges", [])}
    new_edges = {e["id"] for e in after.get("edges", [])}
    result = {"path": relative,
              "added_cards": [card(n) for n in after.get("nodes", []) if n["id"] not in old_nodes],
              "moved_cards": [card(n) for n in after.get("nodes", []) if n["id"] in old_nodes and
                              (n.get("x"), n.get("y")) != (old_nodes[n["id"]].get("x"), old_nodes[n["id"]].get("y"))],
              "added_edges": [arrow(e) for e in after.get("edges", []) if e["id"] not in old_edges],
              "removed_edges": sorted(old_edges - new_edges)}
    return {key: value for key, value in result.items() if value}


def place_new_note(note: dict, placement: dict, kind: str = "note") -> dict | None:
    """After a note or task is created, add it to its project canvas and link it. Returns what was added."""
    if not note.get("project_id"):
        return None
    from app.core.projects import canvas_store as canvas_tasks
    relative = project_canvas(note["project_id"])
    content = read(relative)
    targets = [_resolve(content["nodes"], reference) for reference in placement.get("connect_to", [])]
    if placement.get("x") is not None and placement.get("y") is not None:
        x, y = placement["x"], placement["y"]
    else:
        x, y = _free_spot(content["nodes"], targets[0] if targets else None)
    card = _task_card(note, x, y) if kind == "task" else _note_card(note, x, y)
    before = {"nodes": list(content["nodes"]), "edges": list(content["edges"])}
    content["nodes"].append(card)
    for target in targets:
        source, end = (card, target) if placement.get("direction", "from_new") == "from_new" else (target, card)
        content["edges"].append(_edge(source, end, placement.get("label", "")))
    canvas_tasks.save(settings.storage_path / relative, content)
    return changes(before, content, relative)

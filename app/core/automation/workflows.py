"""Visual workflows: a graph of steps run in dependency order.

Steps are modular blocks in three families:
- sources: start, a watcher, a collection (with filters), a note, a project,
  an article folder, a local folder;
- agent blocks: summarize, filter and sort, extract fields, compare, build,
  or a free agent task, each with its own instruction;
- outputs: write to a collection, update a note, create a note, create tasks,
  file articles in a folder, propose changes to a local folder.

Each step receives the merged output of its incoming edges: a list of items
(articles, suggestions, collection records, notes, files) and an optional text
produced by an agent. Agent steps run through an external agent session; the
other steps call the workspace services directly. Changes an agent proposes in
review mode are copied into the run so they can be applied after a restart.
"""
from __future__ import annotations

import copy
import fnmatch
import json
import os
import re
import threading
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from bs4 import BeautifulSoup
from fastapi import HTTPException

from app.core import journal
from app.models.documents import NoteCreate, NoteUpdate
from app.plugins.planning.models import TaskCreate
from app.core.records import databases
from app.core.workspace import documents
from app.core.agents import sessions as external_agents
from app.plugins.papers import library
from app.core.projects import code as project_code
from app.core.automation import watchers
from app.plugins.planning import service as work
from app.core.workspace import html_documents as html_docs
from app.core.agents.collections import builtin_rows
from app.core.records.repository import now, store

COLLECTION = "workflows"
RUN_LIMIT = 20
CHECK_EVERY = 60
MAX_ITEMS = 50
LOG_LIMIT = 400
AGENT_EVENTS = 80
SOURCES = {"start", "watcher", "collection_read", "note_read", "project", "paper_folder", "local_folder"}
AGENT_BLOCKS = {"summarize", "filter_sort", "extract", "compare", "build", "agent_task"}
OUTPUTS = {"collection_write", "note_update", "note_create", "task", "paper_folder_file", "local_changes"}
NODE_TYPES = SOURCES | AGENT_BLOCKS | OUTPUTS
# Step types of the first version, renamed when a workflow is saved or run.
LEGACY_TYPES = {"article_watch": "watcher", "note": "note_create", "global_note": "note_update", "collection": "collection_write"}
WORKFLOW_RULES = ("\nThis request is one step of a Kavot workflow, not typed in the chat. "
                  "Work only from the inputs given here and reply with the result itself, "
                  "in Markdown, without preamble or follow-up questions.")
JSON_RULES = ("\nReply ONLY with the JSON described above: no Markdown fence, no comment before or after.")
TEXT_FILES = {".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".md", ".txt", ".csv", ".tsv", ".yaml", ".yml", ".toml",
              ".html", ".css", ".r", ".jl", ".m", ".java", ".c", ".h", ".cpp", ".rs", ".go", ".sh", ".sql", ".tex",
              ".bib", ".ipynb", ".xml", ".ini", ".cfg"}

_start_lock = threading.Lock()
_active: dict[int, dict] = {}   # workflow id -> {"run_id", "cancel": Event, "agent_run": str | None}
_stop = threading.Event()
_wake = threading.Event()
_worker: threading.Thread | None = None


# ---------------------------------------------------------------- definition

def _clean_node(node: dict) -> dict:
    kind = LEGACY_TYPES.get(node.get("type"), node.get("type"))
    if kind not in NODE_TYPES:
        raise HTTPException(422, f"Unknown step type: {kind}")
    config = copy.deepcopy(node.get("config")) if isinstance(node.get("config"), dict) else {}
    if node.get("type") == "article_watch" and config.get("watch_id") and not config.get("watcher_id"):
        legacy = next((w for w in store.list("watchers") if w.get("legacy") == {"kind": "article_watch", "id": config["watch_id"]}), None)
        config["watcher_id"] = legacy["id"] if legacy else None
    if kind == "local_folder" and config.get("path"):
        config["path"] = str(project_code.folder(str(config["path"])))
    return {"id": str(node.get("id") or uuid.uuid4().hex[:10])[:40], "type": kind,
            "x": round(float(node.get("x") or 0)), "y": round(float(node.get("y") or 0)),
            "label": str(node.get("label") or "")[:120], "config": config}


def _order(nodes: list[dict], edges: list[dict]) -> list[dict]:
    """Topological order; rejects cycles so a run always terminates."""
    by_id = {node["id"]: node for node in nodes}
    indegree = {node_id: 0 for node_id in by_id}
    outgoing = defaultdict(list)
    for edge in edges:
        outgoing[edge["source"]].append(edge["target"])
        indegree[edge["target"]] += 1
    ready = sorted((n for n in by_id if not indegree[n]), key=lambda n: (by_id[n]["y"], by_id[n]["x"]))
    order = []
    while ready:
        current = ready.pop(0)
        order.append(by_id[current])
        for target in outgoing[current]:
            indegree[target] -= 1
            if not indegree[target]:
                ready.append(target)
    if len(order) != len(by_id):
        raise HTTPException(422, "The workflow contains a loop. Remove one of the connections in the cycle.")
    return order


def _clean(values: dict) -> dict:
    nodes = [_clean_node(node) for node in values.get("nodes") or []]
    ids = {node["id"] for node in nodes}
    if len(ids) != len(nodes):
        raise HTTPException(422, "Two steps share the same identifier.")
    edges, seen = [], set()
    for edge in values.get("edges") or []:
        source, target = str(edge.get("source")), str(edge.get("target"))
        if source not in ids or target not in ids or source == target or (source, target) in seen:
            continue
        seen.add((source, target))
        edges.append({"id": str(edge.get("id") or f"{source}->{target}")[:90], "source": source, "target": target})
    _order(nodes, edges)
    project_id = (values.get("scope") or {}).get("project_id")
    if project_id and not any(p["id"] == project_id for p in store.list("projects")):
        raise HTTPException(422, "The workflow's project no longer exists.")
    return {"name": values["name"].strip(), "description": (values.get("description") or "").strip(),
            "scope": {"project_id": project_id or None},
            "engine": values.get("engine") or "claude", "model": values.get("model") or "",
            "interval_hours": int(values.get("interval_hours") or 0), "enabled": bool(values.get("enabled", True)),
            "timeout_minutes": int(values.get("timeout_minutes") or 20), "nodes": nodes, "edges": edges}


def _public(workflow: dict) -> dict:
    result = dict(workflow)
    result["running"] = workflow["id"] in _active
    interval = workflow.get("interval_hours") or 0
    result["next_run_at"] = None
    if interval and workflow.get("enabled"):
        last = workflow.get("last_run_at")
        result["next_run_at"] = ((datetime.fromisoformat(last) + timedelta(hours=interval)).isoformat()
                                 if last else now())
    return result


def list_workflows() -> list[dict]:
    return [_public(item) for item in store.list(COLLECTION)]


def get(workflow_id: int) -> dict:
    return _public(store.find(COLLECTION, workflow_id, "Workflow"))


def save(values: dict, workflow_id: int | None = None) -> dict:
    data = _clean(values)
    if workflow_id is None:
        result = store.create(COLLECTION, {**data, "runs": [], "last_run_at": None, "last_error": None,
                                           "session_id": None})
    else:
        if workflow_id in _active:
            raise HTTPException(409, "Wait for the current run to finish before changing the workflow.")
        result = store.update(COLLECTION, workflow_id, data, "Workflow")
    _wake.set()
    return _public(result)


def delete(workflow_id: int) -> None:
    if workflow_id in _active:
        raise HTTPException(409, "Stop the current run before deleting the workflow.")
    store.delete(COLLECTION, workflow_id, "Workflow")


# ------------------------------------------------------------------ payloads

def _key(item: dict) -> str:
    return f"{item['kind']}:{item['id']}"


def _paper_item(paper: dict) -> dict:
    return {"kind": "paper", "id": paper["id"], "title": paper.get("title") or "Untitled",
            "authors": paper.get("authors") or [], "doi": paper.get("doi") or "",
            "published_at": paper.get("published_at") or "", "abstract": paper.get("abstract") or ""}


def _plain(html: str) -> str:
    return BeautifulSoup(html or "", "html.parser").get_text("\n").strip()


def _merge(payloads: list[dict]) -> dict:
    items, seen, texts, folders = [], {}, [], []
    for payload in payloads:
        for item in payload.get("items", []):
            key = _key(item)
            if key in seen:
                # Keep every per-item result produced by parallel branches.
                previous = items[seen[key]]
                if item.get("text") and item["text"] not in (previous.get("text") or ""):
                    previous["text"] = "\n\n".join(filter(None, [previous.get("text"), item["text"]]))
                previous.setdefault("values", {}).update(item.get("values") or {})
                continue
            seen[key] = len(items)
            items.append(copy.deepcopy(item))
        if payload.get("text") and payload["text"] not in texts:
            texts.append(payload["text"])
        folders.extend(f for f in payload.get("local_folders", []) if f not in folders)
    return {"items": items, "text": "\n\n".join(texts), "local_folders": folders}


def _describe(items: list[dict]) -> str:
    lines = []
    for item in items:
        kind = item["kind"]
        where = {"paper": f"library article id={item['id']}", "suggestion": "watch suggestion (not in the library)",
                 "record": f"item {item['id']} of collection {item.get('collection_id')}",
                 "note": f"note id={item['id']}", "file": f"file {item.get('path', item['id'])}",
                 "change": "change made by a watcher"}.get(kind, kind)
        authors = ", ".join(item.get("authors", [])[:4])
        lines.append(f"- [key={_key(item)}] [{where}] {item['title']}" + (f" — {authors}" if authors else "") +
                     (f" ({str(item['published_at'])[:4]})" if item.get("published_at") else "") +
                     (f" — DOI {item['doi']}" if item.get("doi") else ""))
        if item.get("abstract"):
            lines.append("  Abstract: " + item["abstract"][:1500])
        values = {k: v for k, v in (item.get("values") or {}).items() if v not in (None, "", [], {}) and k != "content"}
        if values:
            lines.append("  Fields: " + "; ".join(f"{k}: {str(v)[:300]}" for k, v in list(values.items())[:25]))
        if item.get("excerpt"):
            lines.append("  Content:\n" + item["excerpt"][:4000])
        if item.get("text"):
            lines.append("  Previous step result:\n" + item["text"][:6000])
    return "\n".join(lines)


def _render(template: str, workflow: dict, item: dict | None = None) -> str:
    values = {"date": datetime.now().strftime("%Y-%m-%d"), "workflow": workflow["name"],
              "title": (item or {}).get("title", ""), "doi": (item or {}).get("doi", "")}
    text = template or ""
    for key, value in values.items():
        text = text.replace("{" + key + "}", str(value))
    return text.strip()


def _json(text: str) -> Any:
    """First JSON value of an agent answer, with or without a Markdown fence."""
    block = re.search(r"```(?:json)?\s*([\s\S]*?)```", text or "")
    source = block.group(1) if block else (text or "")
    starts = [i for i in (source.find("["), source.find("{")) if i >= 0]
    if not starts:
        raise ValueError("no JSON in the answer")
    start = min(starts)
    closing = "]" if source[start] == "[" else "}"
    return json.loads(source[start:source.rfind(closing) + 1])


# ----------------------------------------------------------------- execution

class _Cancelled(Exception):
    pass


def _wait(run: dict, finished: threading.Event, cancel: Callable[[], None] | None = None) -> None:
    while not finished.wait(1):
        if run["cancel"].is_set():
            if cancel:
                try:
                    cancel()
                except HTTPException:
                    pass
            finished.wait(10)
            raise _Cancelled()


def _context(workflow: dict, payload: dict, **values) -> dict:
    context = {"area": "dashboard", "project_id": workflow["scope"].get("project_id"), "allow_multiple_notes": True}
    if payload.get("local_folders"):
        context["local_folders"] = payload["local_folders"]
    return {**context, **values}


def _agent(workflow: dict, prompt: str, context: dict, mode: str, run: dict, instructions: str = "") -> dict:
    """Run one agent request in the workflow's session and wait for its result."""
    engine = workflow.get("engine") or "claude"
    session_id = workflow.get("session_id")
    try:
        if not session_id or external_agents.get_session(session_id)["engine"] != engine:
            raise HTTPException(404, "No session yet.")
    except HTTPException:
        session_id = external_agents.create_session(engine, purpose="workflow")["id"]
        workflow["session_id"] = session_id
        store.update(COLLECTION, workflow["id"], {"session_id": session_id}, "Workflow")
    finished = threading.Event()
    box: dict[str, Any] = {}

    def done(result: dict) -> None:
        box["result"] = result
        finished.set()

    timeout = int(workflow.get("timeout_minutes") or 20) * 60
    started = external_agents.start_message(session_id, prompt, context, workflow.get("model") or None, None, mode,
                                            fresh=True, timeout=timeout, on_finish=done,
                                            instructions=WORKFLOW_RULES + instructions)
    node_id = run.get("node_id")
    call = {"run_id": started["id"], "started_at": now(), "status": "running", "mode": mode,
            "prompt": prompt[:12000], "events": [], "response": "", "error": None}
    run.setdefault("agents", {}).setdefault(node_id, []).append(call)
    run["agent_run"] = started["id"]
    _progress(workflow["id"], run, node_id)
    _log(workflow["id"], run, f"Agent request sent ({engine}, {mode})", node_id, detail=prompt[:4000])
    try:
        _wait(run, finished, lambda: external_agents.cancel_run(started["id"]))
    finally:
        run["agent_run"] = None
    result = box["result"]
    call.update(status=result["status"], finished_at=now(), response=(result.get("response") or "")[:12000],
                error=result.get("error"),
                events=_compact(result.get("events") or []))
    _progress(workflow["id"], run, node_id)
    _log(workflow["id"], run, f"Agent {result['status']}: {len(call['events'])} activity event(s)", node_id,
         "info" if result["status"] == "completed" else "error", result.get("error") or "")
    if result["status"] == "cancelled":
        raise _Cancelled()
    if result["status"] != "completed":
        raise RuntimeError(result.get("error") or "The agent did not finish.")
    return result


def _compact(events: list[dict]) -> list[dict]:
    """Agent activity for the journal: streamed text fragments joined, latest events only."""
    merged: list[dict] = []
    for event in events:
        detail = str(event.get("detail") or "")
        if merged and event.get("kind") == "message" and merged[-1]["kind"] == "message" and merged[-1]["label"] == event.get("label"):
            merged[-1]["detail"] += detail
        else:
            merged.append({"kind": event.get("kind"), "label": event.get("label", ""), "detail": detail, "at": event.get("at")})
    return [{**event, "detail": event["detail"][:1500]} for event in merged[-AGENT_EVENTS:]]


def _keep_changes(run: dict, node: dict, result: dict) -> int:
    """Copy the proposals of an agent run into the step, so they survive a restart."""
    proposals = [dict(p) for p in result.get("proposals") or []]
    run.setdefault("changes", {})[node["id"]] = proposals
    return sum(p["status"] == "pending" for p in proposals)


# --- sources

def _start(workflow, node, payload, run):
    return payload, "Started"


def _watcher(workflow, node, payload, run):
    config = node["config"]
    watcher_id = int(config.get("watcher_id") or 0)
    if not watcher_id:
        raise ValueError("Choose the watcher to run.")
    finished = threading.Event()
    box: dict[str, Any] = {}
    watchers.run(watcher_id, on_finish=lambda result: (box.update(result=result), finished.set()))
    record = store.find("watchers", watcher_id, "Watcher")
    _wait(run, finished, lambda: watchers.cancel(watcher_id) if not watchers._direct_path(record) else None)
    result = box["result"]
    if result["status"] == "cancelled":
        raise _Cancelled()
    if result["status"] != "completed":
        raise RuntimeError(result.get("error") or "The watcher did not finish.")
    record = store.find("watchers", watcher_id, "Watcher")
    items = []
    if "suggestion_ids" in result:
        wanted = set(result["suggestion_ids"])
        minimum = int(config.get("min_rating") or 0)
        for suggestion in record.get("suggestions", []):
            if suggestion["id"] not in wanted or int(suggestion.get("interest_rating") or 0) < minimum:
                continue
            if config.get("auto_import"):
                decided = watchers.decide_suggestion(watcher_id, suggestion["id"], "saved")
                paper = (decided.get("import_result") or {}).get("paper")
                if paper:
                    items.append(_paper_item(paper))
                    continue
            items.append({"kind": "suggestion", "id": suggestion["id"], "title": suggestion.get("title") or "Untitled",
                          "authors": suggestion.get("authors") or [], "doi": suggestion.get("doi") or "",
                          "published_at": suggestion.get("published_at") or "", "abstract": suggestion.get("abstract") or ""})
        imported = sum(item["kind"] == "paper" for item in items)
        return _merge([payload, {"items": items}]), (f"{len(items)} new article(s)" + (f", {imported} imported" if imported else ""))
    for proposal in result.get("proposals") or []:
        values = (proposal.get("action") or {}).get("values") or {}
        values = values.get("values", values) if isinstance(values, dict) else {}
        items.append({"kind": "change", "id": proposal["proposal_id"], "title": str(values.get("title") or values.get("name") or proposal.get("label") or "Change"),
                      "values": {k: v for k, v in values.items() if not isinstance(v, (dict, list))}, "status": proposal["status"]})
    text = result.get("response") or ""
    return _merge([payload, {"items": items, "text": text}]), f"{len(items)} finding(s)"


def _records(collection_id: str) -> list[dict]:
    """Items of any collection as workflow items, built-in or custom."""
    if collection_id in builtin_rows():
        rows = [r for r in store.list(builtin_rows()[collection_id]) if not r.get("trashed_at") and not r.get("archived_at")]
        if collection_id == "articles":
            return [{**_paper_item(r), "values": {k: r.get(k) for k in ("status", "tags", "publication", "folder_ids") if r.get(k)},
                     "created_at": r.get("created_at"), "updated_at": r.get("updated_at"), "folder_ids": library.paper_folder_ids(r)} for r in rows]
        if collection_id == "notes":
            return [{"kind": "note", "id": r["id"], "title": r.get("title") or "Note", "excerpt": _plain(r.get("content", ""))[:4000],
                     "values": {"project_id": r.get("project_id"), "folder_id": r.get("folder_id"), "paper_id": r.get("paper_id")},
                     "created_at": r.get("created_at"), "updated_at": r.get("updated_at")} for r in rows]
        return [{"kind": "record", "id": r["id"], "collection_id": collection_id, "title": str(r.get("title") or r.get("name") or r["id"]),
                 "values": {k: v for k, v in r.items() if k not in {"id", "created_at", "updated_at"} and not isinstance(v, dict)},
                 "created_at": r.get("created_at"), "updated_at": r.get("updated_at")} for r in rows]
    try:
        definition = databases.load(collection_id)
    except FileNotFoundError:
        raise ValueError("Choose an existing collection.") from None
    title_field = next((f["id"] for f in definition.get("fields", []) if f.get("type") in {"title", "text"}), None)
    result = []
    for record in databases.records(collection_id):
        values = record.get("values") or {}
        result.append({"kind": "record", "id": record["id"], "collection_id": collection_id,
                       "title": str(record.get("title") or values.get("title") or values.get(title_field or "") or values.get("name") or record["id"]),
                       "values": values, "folder_id": record.get("folder_id"),
                       "excerpt": _plain(str(record.get("content") or values.get("content") or ""))[:3000],
                       "created_at": record.get("created_at"), "updated_at": record.get("updated_at")})
    return result


def _matches(item: dict, condition: dict) -> bool:
    field, op, expected = condition.get("field"), condition.get("op") or "contains", str(condition.get("value") or "")
    value = item.get(field) if field in {"title", "abstract", "doi"} else (item.get("values") or {}).get(field)
    text = " ".join(map(str, value)) if isinstance(value, list) else "" if value is None else str(value)
    if op == "empty":
        return not text.strip()
    if op == "not_empty":
        return bool(text.strip())
    if op == "equals":
        return text.casefold() == expected.casefold()
    if op == "not_equals":
        return text.casefold() != expected.casefold()
    if op in {"gt", "lt"}:
        try:
            left, right = float(text), float(expected)
        except ValueError:
            left, right = text, expected  # ISO dates compare as text
        return left > right if op == "gt" else left < right
    if op == "not_contains":
        return expected.casefold() not in text.casefold()
    return expected.casefold() in text.casefold()


def _last_success(workflow: dict) -> str | None:
    return next((r["started_at"] for r in workflow.get("runs", []) if r.get("status") == "completed"), None)


def _collection_read(workflow, node, payload, run):
    config = node["config"]
    collection_id = config.get("collection_id")
    if not collection_id:
        raise ValueError("Choose the collection to read.")
    items = _records(collection_id)
    if config.get("folder_id"):
        folder = config["folder_id"]
        items = [i for i in items if i.get("folder_id") == folder or folder in (i.get("folder_ids") or [])]
    for condition in config.get("filters") or []:
        if condition.get("field"):
            items = [i for i in items if _matches(i, condition)]
    if config.get("only_new"):
        since = _last_success(workflow)
        if since:
            items = [i for i in items if (i.get("updated_at") or i.get("created_at") or "") > since]
    items.sort(key=lambda i: i.get("updated_at") or i.get("created_at") or "", reverse=True)
    limit = max(1, min(MAX_ITEMS, int(config.get("limit") or 20)))
    return _merge([payload, {"items": items[:limit]}]), f"{min(limit, len(items))} item(s) read"


def _note_read(workflow, node, payload, run):
    note_id = int(node["config"].get("note_id") or 0)
    state = store.read()
    note = next((n for n in state["notes"] if n["id"] == note_id and not n.get("trashed_at")), None)
    if not note:
        raise ValueError("Choose the note to read.")
    path = documents.note_path(note, state)
    content = html_docs.read(path.read_text(encoding="utf-8"), path) if path.is_file() else note.get("content", "")
    item = {"kind": "note", "id": note["id"], "title": note["title"], "excerpt": _plain(content)[:20000]}
    return _merge([payload, {"items": [item]}]), f"Note “{note['title']}” read"


def _project(workflow, node, payload, run):
    config = node["config"]
    project_id = int(config.get("project_id") or workflow["scope"].get("project_id") or 0)
    state = store.read()
    project = next((p for p in state["projects"] if p["id"] == project_id), None)
    if not project:
        raise ValueError("Choose a project.")
    related = lambda item: item.get("project_id") == project_id or project_id in (item.get("project_ids") or [])
    limit = max(1, min(MAX_ITEMS, int(config.get("limit") or 30)))
    items = []
    if config.get("articles", True):
        items += [_paper_item(p) for p in state["papers"] if related(p) and not p.get("trashed_at")][:limit]
    if config.get("notes", True):
        items += [{"kind": "note", "id": n["id"], "title": n["title"], "excerpt": _plain(n.get("content", ""))[:3000]}
                  for n in state["notes"] if n.get("project_id") == project_id and not n.get("trashed_at")][:limit]
    if config.get("tasks"):
        items += [{"kind": "record", "id": t["id"], "collection_id": "tasks", "title": t["title"],
                   "values": {k: t.get(k) for k in ("status", "priority", "due_date", "description")}}
                  for t in state["tasks"] if t.get("project_id") == project_id and not t.get("archived_at")][:limit]
    text = f"Project “{project['name']}”" + (f": {project['description']}" if project.get("description") else "")
    return _merge([payload, {"items": items, "text": text}]), f"{len(items)} item(s) of the project"


def _folder_ids(state: dict, folder_id: int, recursive: bool) -> set[int]:
    ids = {folder_id}
    while recursive:
        children = {f["id"] for f in state["paper_folders"] if f.get("parent_id") in ids} - ids
        if not children:
            break
        ids |= children
    return ids


def _paper_folder(workflow, node, payload, run):
    config = node["config"]
    folder_id = int(config.get("folder_id") or 0)
    if not folder_id:
        raise ValueError("Choose an article folder.")
    state = store.read()
    folders = _folder_ids(state, folder_id, bool(config.get("include_subfolders", True)))
    found = [p for p in state["papers"] if folders.intersection(library.paper_folder_ids(p)) and not p.get("trashed_at")]
    if config.get("only_new"):
        since = _last_success(workflow)
        if since:
            found = [p for p in found if (p.get("created_at") or "") > since]
    found.sort(key=lambda p: p.get("created_at") or "", reverse=True)
    limit = max(1, min(MAX_ITEMS, int(config.get("limit") or 20)))
    items = [_paper_item(p) for p in found[:limit]]
    return _merge([payload, {"items": items}]), f"{len(items)} article(s) from the folder"


def _local_files(base, patterns: list[str], limit: int) -> list[dict]:
    found = []
    for directory, folders, files in os.walk(base):
        folders[:] = sorted(f for f in folders if f.lower() not in project_code.SKIP and not f.startswith("."))
        for name in sorted(files):
            relative = os.path.relpath(os.path.join(directory, name), base).replace(os.sep, "/")
            if patterns and not any(fnmatch.fnmatch(relative, p) or fnmatch.fnmatch(name, p) for p in patterns):
                continue
            found.append(relative)
            if len(found) >= limit:
                return found
    return found


def _local_folder(workflow, node, payload, run):
    config = node["config"]
    base = project_code.folder(str(config.get("path") or ""))
    patterns = [p.strip() for p in str(config.get("patterns") or "").replace(";", ",").split(",") if p.strip()]
    limit = max(1, min(200, int(config.get("limit") or 40)))
    items = []
    for relative in _local_files(base, patterns, limit):
        path = base / relative
        excerpt = ""
        if path.suffix.lower() in TEXT_FILES and path.stat().st_size <= project_code.MAX_FILE:
            try:
                excerpt = path.read_text(encoding="utf-8-sig", errors="replace")[:3000]
            except OSError:
                excerpt = ""
        items.append({"kind": "file", "id": f"{base}::{relative}", "title": relative, "path": relative, "excerpt": excerpt})
    folder = {"path": str(base), "allow_changes": bool(config.get("allow_changes"))}
    text = (f"Local folder {base} ({len(items)} file(s) listed). Read any file with local_read(root, path) and "
            f"list folders with local_tree(root, path), root=\"{base}\".")
    return {**_merge([payload, {"items": items, "text": text}]), "local_folders": [*payload.get("local_folders", []), folder]}, \
        f"{len(items)} file(s) listed"


# --- agent blocks

AGENT_GUIDES = {
    "summarize": "Summarize",
    "compare": "Compare all the inputs. Give a comparison table first, then the agreements, the differences and the open questions.",
    "build": "Build the requested synthesis or structure from all the inputs.",
    "agent_task": "",
}
READING = ("Read the library articles with get_article_pack or get_article_details, notes with read_note and "
           "local files with local_read when the excerpts are not enough.\n")


def _limited(payload: dict, config: dict) -> list[dict]:
    return payload["items"][:max(1, min(MAX_ITEMS, int(config.get("max_items") or 20)))]


def _agent_block(workflow, node, payload, run):
    config = node["config"]
    instruction = (config.get("prompt") or "").strip() or AGENT_GUIDES.get(node["type"], "")
    if not instruction:
        raise ValueError("Describe what the agent must do.")
    context = _context(workflow, payload)
    items = _limited(payload, config)
    if config.get("per_item") and items and node["type"] in {"summarize", "agent_task"}:
        results = []
        for index, item in enumerate(items):
            run["detail"] = f"{index + 1}/{len(items)} — {item['title'][:80]}"
            _progress(workflow["id"], run, node["id"])
            _log(workflow["id"], run, f"Item {run['detail']}", node["id"])
            answer = _agent(workflow, f"{instruction}\n\nInput:\n{_describe([item])}\n\n{READING}", context, "answer", run)
            results.append({**item, "text": answer.get("response") or ""})
        run["detail"] = ""
        return {**payload, "items": results}, f"{len(results)} result(s), one per item"
    body = (f"{instruction}\n\n" + (f"Inputs:\n{_describe(items)}\n\n{READING}" if items else "") +
            (f"Text from the previous steps:\n{payload['text'][:20000]}\n" if payload["text"] else ""))
    answer = _agent(workflow, body, context, "answer", run)
    text = answer.get("response") or ""
    return {**payload, "text": text}, (text.strip().splitlines() or ["Done"])[0][:160]


def _filter_sort(workflow, node, payload, run):
    config = node["config"]
    items = _limited(payload, config)
    if not items:
        return payload, "Nothing to sort"
    criteria = (config.get("prompt") or "").strip() or "Keep the items relevant to the workflow and rank them by relevance."
    body = (f"Sort and filter these inputs. Criteria:\n{criteria}\n\nInputs:\n{_describe(items)}\n\n{READING}"
            'For every input, give its key, whether to keep it, its rank (1 = best) and a one-sentence reason, as '
            'a JSON array: [{"key": "paper:12", "keep": true, "rank": 1, "reason": "…"}].')
    answer = _agent(workflow, body, _context(workflow, payload), "answer", run, JSON_RULES)
    try:
        decisions = {str(d.get("key")): d for d in _json(answer.get("response") or "") if isinstance(d, dict)}
    except (ValueError, TypeError):
        return {**payload, "items": items}, "The agent did not return a usable ranking: every item was kept"
    kept = []
    for item in items:
        decision = decisions.get(_key(item))
        if decision is None or decision.get("keep") is not False:
            reason = str((decision or {}).get("reason") or "")
            kept.append((int((decision or {}).get("rank") or 10_000), {**item, "reason": reason}))
    kept.sort(key=lambda pair: pair[0])
    limit = int(config.get("keep_max") or 0)
    result = [item for _, item in kept][:limit or None]
    return {**payload, "items": result}, f"{len(result)} of {len(items)} item(s) kept"


def _extract(workflow, node, payload, run):
    config = node["config"]
    fields = [f.strip() for f in str(config.get("fields") or "").split(",") if f.strip()]
    if not fields:
        raise ValueError("List the fields to extract.")
    items = _limited(payload, config)
    if not items:
        return payload, "Nothing to extract from"
    guidance = (config.get("prompt") or "").strip()
    body = (f"Extract these fields from every input: {', '.join(fields)}.\n" + (f"{guidance}\n" if guidance else "") +
            f"Write \"not reported\" when the input does not give the information.\n\nInputs:\n{_describe(items)}\n\n{READING}"
            'Answer as a JSON object keyed by input key: {"paper:12": {"field": "value", …}, …}.')
    answer = _agent(workflow, body, _context(workflow, payload), "answer", run, JSON_RULES)
    try:
        extracted = _json(answer.get("response") or "")
        if not isinstance(extracted, dict):
            raise ValueError("not an object")
    except (ValueError, TypeError):
        raise RuntimeError("The agent did not return the extracted fields as JSON.") from None
    result = []
    for item in items:
        values = extracted.get(_key(item)) if isinstance(extracted.get(_key(item)), dict) else {}
        values = {field: values.get(field, "not reported") for field in fields}
        table = "\n".join(f"- **{field}**: {value}" for field, value in values.items())
        result.append({**item, "values": {**(item.get("values") or {}), **values}, "text": table})
    rows = ["| Item | " + " | ".join(fields) + " |", "|" + " --- |" * (len(fields) + 1)]
    rows += [f"| {i['title'][:80]} | " + " | ".join(str(i['values'].get(f, ''))[:120].replace("|", "/") for f in fields) + " |" for i in result]
    return {**payload, "items": result, "text": "\n".join(rows)}, f"{len(fields)} field(s) extracted from {len(result)} item(s)"


# --- outputs

def _collection_write(workflow, node, payload, run):
    config = node["config"]
    collection_id = config.get("collection_id")
    try:
        definition = databases.load(str(collection_id or ""))
    except FileNotFoundError:
        raise ValueError("Choose an existing collection.") from None
    if not payload["items"] and not payload["text"]:
        return payload, "Nothing to add"
    instruction = (config.get("instructions") or "").strip() or "Add one item per input and fill every field you can."
    library_note = (" For the Library, import articles with paper_import (DOI or URL) and organize them with paper_organize."
                    if definition["id"] == "articles" else "")
    body = (f"Update the collection “{definition.get('name', collection_id)}” (id {collection_id}) from the inputs "
            f"below. {instruction}{library_note}\nCall get_collection first for the field schema, and avoid duplicates: "
            "check existing items with list_records.\n\n" +
            (f"Inputs:\n{_describe(payload['items'][:MAX_ITEMS])}\n\n" if payload["items"] else "") +
            (f"Text from the previous steps:\n{payload['text'][:20000]}\n" if payload["text"] else ""))
    context = _context(workflow, payload, area="database", view="database", collection_id=collection_id)
    mode = "auto" if config.get("apply_mode") == "auto" else "propose"
    result = _agent(workflow, body, context, mode, run)
    pending = _keep_changes(run, node, result)
    applied = sum(p["status"] == "applied" for p in result.get("proposals") or [])
    return payload, (f"{applied} change(s) applied" if mode == "auto" else f"{pending} change(s) to review")


def _content(payload: dict) -> str:
    parts = [payload["text"]] + [f"### {i['title']}\n\n{i['text']}" for i in payload["items"] if i.get("text")]
    return "\n\n".join(filter(None, parts))


def _replace_section(html: str, heading: str, addition: str) -> str | None:
    """Replace the section under ``heading`` (up to the next heading of the same or higher level)."""
    soup = BeautifulSoup(html, "html.parser")
    title = next((h for h in soup.find_all(re.compile(r"^h[1-6]$")) if h.get_text(strip=True) == heading.strip()), None)
    if title is None:
        return None
    level = int(title.name[1])
    sibling = title.next_sibling
    while sibling is not None:
        following = sibling.next_sibling
        name = getattr(sibling, "name", None) or ""
        if re.fullmatch(r"h[1-6]", name) and int(name[1]) <= level:
            break
        sibling.extract()
        sibling = following
    title.replace_with(BeautifulSoup(addition, "html.parser"))
    return str(soup)


def _note_update(workflow, node, payload, run):
    config = node["config"]
    note_id = int(config.get("note_id") or 0)
    if not note_id:
        raise ValueError("Choose the note to update.")
    body = _content(payload) or (_describe(payload["items"]) if payload["items"] else "")
    if not body:
        return payload, "Nothing new to add"
    heading = _render(config.get("heading") or "{date} — {workflow}", workflow)
    addition = html_docs.fragment((f"## {heading}\n\n" if heading else "") + body, identify=False, markdown=True)
    state = store.read()
    note = next((n for n in state["notes"] if n["id"] == note_id and not n.get("trashed_at")), None)
    if not note:
        raise ValueError("The note to update no longer exists.")
    path = documents.note_path(note, state)
    current = html_docs.read(path.read_text(encoding="utf-8"), path) if path.is_file() else note.get("content", "")
    position = config.get("position") or "append"
    replaced = _replace_section(current, heading, addition) if position == "replace" and heading else None
    content = replaced if replaced is not None else addition + current if position == "prepend" else current + addition
    documents.update_note(note_id, NoteUpdate(content=content))
    return payload, f"Note “{note['title']}” " + ("section replaced" if replaced is not None else "updated")


def _note_create(workflow, node, payload, run):
    config = node["config"]
    project_id = config.get("project_id") or workflow["scope"].get("project_id") or None
    folder_id = config.get("folder_id") or None
    if not payload["items"] and not payload["text"]:
        return payload, "Nothing to write: no item or result reached this step"
    created = []
    if config.get("per_item") and payload["items"]:
        for item in payload["items"]:
            title = _render(config.get("title") or "{title}", workflow, item) or item["title"]
            body = item.get("text") or payload["text"] or _describe([item])
            note = documents.create_note(NoteCreate(
                title=title[:240], content=f"# {title}\n\n{body}", project_id=project_id, folder_id=folder_id,
                paper_id=item["id"] if item["kind"] == "paper" and config.get("link_article", True) else None))
            created.append(note["id"])
    else:
        title = _render(config.get("title") or "{workflow} — {date}", workflow) or workflow["name"]
        body = _content(payload) or _describe(payload["items"])
        note = documents.create_note(NoteCreate(title=title[:240], content=f"# {title}\n\n{body}",
                                                project_id=project_id, folder_id=folder_id))
        created.append(note["id"])
    return payload, f"{len(created)} note(s) created"


def _task(workflow, node, payload, run):
    config = node["config"]
    project_id = config.get("project_id") or workflow["scope"].get("project_id") or None
    targets = payload["items"] if config.get("per_item") and payload["items"] else [None]
    due = None
    if config.get("due_in_days"):
        due = (datetime.now() + timedelta(days=int(config["due_in_days"]))).date()
    for item in targets:
        title = _render(config.get("title") or ("Review “{title}”" if item else "{workflow}"), workflow, item)
        description = (item or {}).get("text") or payload["text"] or ""
        work.create_task(TaskCreate(title=(title or workflow["name"])[:240], description=description[:4000],
                                    project_id=project_id, column_id=config.get("column_id") or None,
                                    priority=config.get("priority") or "medium", due_date=due))
    return payload, f"{len(targets)} task(s) created"


def _paper_folder_file(workflow, node, payload, run):
    folder_id = int(node["config"].get("folder_id") or 0)
    if not folder_id:
        raise ValueError("Choose the article folder.")
    papers = [item for item in payload["items"] if item["kind"] == "paper"]
    for item in papers:
        paper = store.find("papers", item["id"], "Article")
        folders = list(dict.fromkeys([*library.paper_folder_ids(paper), folder_id]))
        library.update_paper(item["id"], {"folder_ids": folders, "folder_id": paper.get("folder_id") or folder_id})
    return payload, f"{len(papers)} article(s) filed in the folder"


def _local_changes(workflow, node, payload, run):
    config = node["config"]
    folders = [f for f in payload.get("local_folders", []) if f.get("allow_changes")]
    if not folders:
        raise ValueError("Connect a “Local folder” step with “Allow proposing changes” before this step.")
    instruction = (config.get("prompt") or "").strip()
    if not instruction:
        raise ValueError("Describe the changes to make in the folder.")
    roots = ", ".join(f["path"] for f in folders)
    body = (f"{instruction}\n\nAllowed folders: {roots}. Read files with local_tree and local_read, then propose each "
            "change with local_file_patch (exact old_text → new_text, preferred) or local_file_write (whole file). "
            "Kavot shows every change as a diff for the user to approve; nothing is written before.\n\n" +
            (f"Inputs:\n{_describe(payload['items'][:MAX_ITEMS])}\n\n" if payload["items"] else "") +
            (f"Text from the previous steps:\n{payload['text'][:20000]}\n" if payload["text"] else ""))
    # Local files are always reviewed: the workflow never writes them directly.
    result = _agent(workflow, body, _context(workflow, {**payload, "local_folders": folders}), "propose", run)
    pending = _keep_changes(run, node, result)
    return payload, f"{pending} file change(s) to review"


HANDLERS: dict[str, Callable] = {
    "start": _start, "watcher": _watcher, "collection_read": _collection_read, "note_read": _note_read,
    "project": _project, "paper_folder": _paper_folder, "local_folder": _local_folder,
    "summarize": _agent_block, "compare": _agent_block, "build": _agent_block, "agent_task": _agent_block,
    "filter_sort": _filter_sort, "extract": _extract,
    "collection_write": _collection_write, "note_update": _note_update, "note_create": _note_create, "task": _task,
    "paper_folder_file": _paper_folder_file, "local_changes": _local_changes,
}


def _progress(workflow_id: int, run: dict, node_id: str | None = None, **values) -> None:
    with store.transaction() as state:
        workflow = next((w for w in state[COLLECTION] if w["id"] == workflow_id), None)
        if not workflow:
            return
        entry = next((r for r in workflow.get("runs", []) if r["id"] == run["run_id"]), None)
        if not entry:
            return
        if node_id:
            step = entry["steps"].setdefault(node_id, {})
            step.update(values)
            step["detail"] = run.get("detail", "")
            step["agent_run"] = run.get("agent_run")
            if node_id in run.get("changes", {}):
                step["changes"] = run["changes"][node_id]
            if node_id in run.get("agents", {}):
                step["agent_calls"] = copy.deepcopy(run["agents"][node_id])
        workflow["updated_at"] = now()


def _log(workflow_id: int, run: dict, message: str, node_id: str | None = None, level: str = "info", detail: str = "") -> None:
    """Append one timestamped line to the run's journal."""
    with store.transaction() as state:
        workflow = next((w for w in state[COLLECTION] if w["id"] == workflow_id), None)
        entry = next((r for r in (workflow or {}).get("runs", []) if r["id"] == run["run_id"]), None)
        if not entry:
            return
        log = entry.setdefault("log", [])
        log.append({"at": now(), "level": level, "node_id": node_id, "message": message[:300], "detail": detail[:4000]})
        del log[:-LOG_LIMIT]


def _input(payload: dict) -> dict:
    """What a step received, kept for the run journal."""
    return {"item_count": len(payload["items"]), "text": payload["text"][:6000],
            "items": [{"key": _key(i), "title": i["title"][:160]} for i in payload["items"][:MAX_ITEMS]]}


def _seconds(started: str, finished: str) -> str:
    return f"{(datetime.fromisoformat(finished) - datetime.fromisoformat(started)).total_seconds():.1f} s"


def _execute(workflow: dict, run: dict) -> None:
    order = _order(workflow["nodes"], workflow["edges"])
    incoming = defaultdict(list)
    for edge in workflow["edges"]:
        incoming[edge["target"]].append(edge["source"])
    outputs: dict[str, dict] = {}
    blocked: set[str] = set()
    status, error = "completed", None
    _log(workflow["id"], run, f"Run started ({run.get('trigger', 'manual')}): {len(order)} step(s)")
    try:
        for node in order:
            if run["cancel"].is_set():
                raise _Cancelled()
            name = node.get("label") or node["type"]
            run["node_id"] = node["id"]
            if any(source in blocked for source in incoming[node["id"]]):
                blocked.add(node["id"])
                _progress(workflow["id"], run, node["id"], status="skipped", summary="A previous step failed")
                _log(workflow["id"], run, "Skipped: a previous step failed", node["id"], "warning")
                continue
            payload = _merge([outputs[s] for s in incoming[node["id"]] if s in outputs])
            started_at = now()
            _progress(workflow["id"], run, node["id"], status="running", started_at=started_at, input=_input(payload))
            _log(workflow["id"], run, f"Started: {len(payload['items'])} item(s) received", node["id"])
            try:
                result, summary = HANDLERS[node["type"]](workflow, node, payload, run)
            except _Cancelled:
                raise
            except Exception as failure:
                message = str(failure.detail if isinstance(failure, HTTPException) else failure)
                blocked.add(node["id"])
                status, error = "failed", f"{name}: {message}"
                finished_at = now()
                _progress(workflow["id"], run, node["id"], status="failed", error=message, finished_at=finished_at)
                _log(workflow["id"], run, f"Failed after {_seconds(started_at, finished_at)}", node["id"], "error", message)
                continue
            outputs[node["id"]] = result
            preview = result.get("text") or "\n\n".join(i["text"] for i in result.get("items", []) if i.get("text"))
            finished_at = now()
            _progress(workflow["id"], run, node["id"], status="done", summary=summary, finished_at=finished_at,
                      item_count=len(result.get("items", [])), output=preview[:12000],
                      items=[{"key": _key(i), "title": i["title"][:160], **({"reason": i["reason"][:300]} if i.get("reason") else {})}
                             for i in result.get("items", [])[:MAX_ITEMS]])
            _log(workflow["id"], run, f"Done in {_seconds(started_at, finished_at)}: {summary}", node["id"])
    except _Cancelled:
        status, error = "cancelled", None
        _log(workflow["id"], run, "Run stopped on request", run.get("node_id"), "warning")
    finally:
        _log(workflow["id"], run, f"Run {status}" + (f": {error}" if error else ""), None, "error" if status == "failed" else "info")
        with store.transaction() as state:
            record = next((w for w in state[COLLECTION] if w["id"] == workflow["id"]), None)
            if record:
                entry = next((r for r in record.get("runs", []) if r["id"] == run["run_id"]), None)
                if entry:
                    entry.update(status=status, finished_at=now(), error=error)
                    for step in entry["steps"].values():
                        if step.get("status") in {"pending", "running"}:
                            step["status"] = "cancelled" if status == "cancelled" else "skipped"
                record["last_error"] = error
                record["updated_at"] = now()
        # Released only once the final status is stored, so readers never see a stale "running".
        _active.pop(workflow["id"], None)


def run(workflow_id: int, trigger: str = "manual") -> dict:
    with _start_lock:
        workflow = store.find(COLLECTION, workflow_id, "Workflow")
        if workflow_id in _active:
            raise HTTPException(409, "This workflow is already running.")
        if not workflow["nodes"]:
            raise HTTPException(422, "Add at least one step to the workflow.")
        workflow = {**workflow, **_clean(workflow)}  # renames the step types of older workflows
        started_at = now()
        entry = {"id": uuid.uuid4().hex, "trigger": trigger, "status": "running", "started_at": started_at,
                 "finished_at": None, "error": None, "log": [],
                 "steps": {node["id"]: {"status": "pending"} for node in workflow["nodes"]}}
        workflow = store.update(COLLECTION, workflow_id, {
            "nodes": workflow["nodes"], "edges": workflow["edges"], "scope": workflow["scope"],
            "runs": ([entry] + workflow.get("runs", []))[:RUN_LIMIT], "last_run_at": started_at}, "Workflow")
        active = {"run_id": entry["id"], "cancel": threading.Event(), "agent_run": None, "detail": "", "trigger": trigger}
        _active[workflow_id] = active
        threading.Thread(target=_execute, args=(copy.deepcopy(workflow), active), daemon=True,
                         name=f"kavot-workflow-{workflow_id}").start()
        return get(workflow_id)


def cancel(workflow_id: int) -> dict:
    active = _active.get(workflow_id)
    if not active:
        raise HTTPException(409, "This workflow is not running.")
    active["cancel"].set()
    return get(workflow_id)


def delete_runs(workflow_id: int, run_id: str | None = None) -> dict:
    """Delete one run with its journal, or every finished run; the run in progress is kept."""
    store.find(COLLECTION, workflow_id, "Workflow")
    active = _active.get(workflow_id, {}).get("run_id")
    if run_id and run_id == active:
        raise HTTPException(409, "Stop the run before deleting it.")
    with store.transaction() as state:
        record = next(w for w in state[COLLECTION] if w["id"] == workflow_id)
        runs = record.get("runs", [])
        if run_id and not any(r["id"] == run_id for r in runs):
            raise HTTPException(404, "Run not found.")
        record["runs"] = [r for r in runs if (r["id"] != run_id if run_id else r["id"] == active)]
        if not run_id or (runs and runs[0]["id"] == run_id):
            record["last_error"] = None
        record["updated_at"] = now()
    return get(workflow_id)


def decide_change(workflow_id: int, run_id: str, node_id: str, proposal_id: str, decision: str) -> dict:
    from app.core.agents import actions
    workflow = store.find(COLLECTION, workflow_id, "Workflow")
    entry = next((r for r in workflow.get("runs", []) if r["id"] == run_id), None)
    step = (entry or {}).get("steps", {}).get(node_id) or {}
    change = next((c for c in step.get("changes", []) if c["proposal_id"] == proposal_id), None)
    if change is None:
        raise HTTPException(404, "Change not found.")
    if workflow_id in _active and _active[workflow_id]["run_id"] == run_id:
        raise HTTPException(409, "Wait for the run to finish before reviewing its changes.")
    update = {}
    if decision == "apply" and change["status"] == "pending":
        with journal.author("workflow", approved_by="user"):
            update = {"status": "applied", "result": actions.apply(change)}
    elif decision == "dismiss" and change["status"] == "pending":
        update = {"status": "dismissed"}
    if update:
        with store.transaction() as state:
            record = next(w for w in state[COLLECTION] if w["id"] == workflow_id)
            stored = next(r for r in record["runs"] if r["id"] == run_id)["steps"][node_id]
            next(c for c in stored["changes"] if c["proposal_id"] == proposal_id).update(update)
            record["updated_at"] = now()
    return get(workflow_id)


# ----------------------------------------------------------------- scheduler

def _due(workflow: dict) -> bool:
    interval = workflow.get("interval_hours") or 0
    if not interval or not workflow.get("enabled") or workflow["id"] in _active:
        return False
    last = workflow.get("last_run_at")
    return not last or datetime.now(timezone.utc) - datetime.fromisoformat(last) >= timedelta(hours=interval)


def _loop() -> None:
    while not _stop.is_set():
        try:
            # One unattended workflow at a time keeps agents and quotas bounded.
            if not _active:
                due = next((w for w in store.list(COLLECTION) if _due(w)), None)
                if due:
                    try:
                        run(due["id"], "schedule")
                    except HTTPException as error:
                        store.update(COLLECTION, due["id"], {"last_run_at": now(), "last_error": str(error.detail)},
                                     "Workflow")
        except Exception:
            pass
        _wake.wait(CHECK_EVERY)
        _wake.clear()


def recover() -> None:
    """Runs interrupted by a restart cannot resume: close them explicitly."""
    with store.transaction() as state:
        for workflow in state.get(COLLECTION, []):
            for entry in workflow.get("runs", []):
                if entry.get("status") == "running":
                    entry.update(status="interrupted", finished_at=now(), error="Kavot was closed during the run.")
                    entry.setdefault("log", []).append({"at": now(), "level": "error", "node_id": None,
                                                        "message": "Run interrupted: Kavot was closed during the run.", "detail": ""})


def start() -> None:
    global _worker
    if _worker and _worker.is_alive():
        return
    _stop.clear()
    _wake.clear()
    _worker = threading.Thread(target=_loop, name="workflows", daemon=True)
    _worker.start()


def stop() -> None:
    _stop.set()
    _wake.set()
    for active in _active.values():
        active["cancel"].set()
    if _worker:
        _worker.join(timeout=2)

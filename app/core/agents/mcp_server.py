"""Run-scoped MCP adapter over Kavot's context and domain actions.

Each CLI receives a short-lived loopback endpoint. In propose mode, changes
stay proposals that only the UI can apply. In auto mode, the user allowed the
request to apply them directly, through the same validation and conflict checks.

Every tool definition and every result costs the agent tokens on each turn, so
the server is built to stay small:

- instructions are short; detailed guidance is read once with ``get_guide``;
- read tools return compact JSON (no indentation, no empty values) as a
  single text block, never duplicated as structured content;
- ``search`` returns snippets with addresses, and ``read`` opens one address
  window by window, so agents fetch only the passages they need;
- only the write tools that fit the request's area are named tools; every
  other action goes through ``propose_action`` after ``get_action_schema``;
- input schemas are stripped of titles and null unions before they are sent.
"""
from __future__ import annotations

import copy
import json
import os
import secrets
import socket
import sys
import time
from functools import wraps
from contextlib import contextmanager
from dataclasses import dataclass
from threading import Thread
from typing import Annotated, Any, Literal

import uvicorn
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, create_model
from starlette.responses import JSONResponse

from app.core.kernel.config import settings
from app.core.kernel.plugins import load as load_plugins
from app.core.agents import actions
from app.core.agents import collections

TOKEN_ENV = "KAVOT_MCP_TOKEN"
# "full" exposes every action as a named tool, as before the compact tool set.
TOOLSET_ENV = "KAVOT_MCP_TOOLSET"
PROPOSAL_LIMITS = {"propose": 30, "auto": 200}
INSTRUCTIONS = """Kavot workspace tools (MCP). Use them only as far as the request needs:
every call and result is resent on each later call of the conversation.
- Answer from what you already have when it is enough: general knowledge, the briefs in
  the message, earlier results. Many requests need no tool at all.
- Go one level deeper only when the current one does not answer. Notes have three levels:
  get_note(id, level=1) brief (place, relations, gist, cost of the next levels), level=2
  summary and outline with a gist per section, level=3 text (section=<block id> for one part).
  A gist is a summary, not evidence: quote or claim details only from level 3.
- To find things: search(query) gives snippets with kavot:// addresses, list_notes notes
  with a gist, explore() a map of projects and collections; read(ref) opens an address.
  get_context gives the scope and target: call it only when the message lacks them or says they changed.
- Never reread what a tool returned earlier in this conversation (previous messages
  included) unless the message says it changed. Never list or inspect the tool catalogue
  more than once per conversation. Read a guide (get_guide(topic)) only before a kind of
  task you have not done in this conversation.
- After reading a note in full, if the result asks for it, call save_digest(ref, summary,
  sections): allowed in every mode, it stores your summary, not the user's data.
Writes: named write tools when listed, else get_action_schema(kind) then propose_action.
read_note (HTML with block ids) is needed before editing an existing note, not to create one.
In propose mode a write is a proposal the user approves: never present it as applied.
In auto mode status=applied returns the saved object (id, title, size, canvas card):
that is the confirmation, do not read it back. Read it again only to edit it further.
Never change Kavot files directly or produce a kavot-actions block. If MCP fails, report it.
"""
GUIDES = {
    "notes": """Notes are HTML documents. read_note returns the body with stable block ids and makes the
note editable in this request. Use the smallest fitting tool:
- note_block_update replaces one identified block (keep its id);
- note_block_insert adds HTML after a block id (null appends at the end);
- note_block_delete removes blocks by id;
- note_update replaces an exact, unique HTML passage (empty old_text appends);
- note_content_replace rewrites the whole body (HTML or Markdown);
- note_properties_update changes properties or presentation (width, theme);
- note_script_set inserts or replaces a sandboxed script block (HTML, CSS, JS with the
  kavot.* data API).
Call get_note_format_guide once per conversation, only for rich formatting: elements, styles, layouts
(columns, callouts, collapsible, tables, dividers, math, images), live collection views
and the script API. Keep ids, styles and links outside the request. Never put <script>
or <style> in note HTML: use note_script_set. The script library (list_scripts,
get_script, script_create, script_update, script_delete) stores reusable scripts.
note_create creates a note. Give it the same starting markup the editor's New note
button writes — a single H1 with the title, then the content. Leave presentation
unset like a note made by hand: the page then follows the app's light/dark theme.
cream and slate are fixed light backgrounds; set them only when the user asks.""",
    "canvas": """Project canvas: get_canvas shows its cards (note_id, title) and relations. To put a NEW
note or task on the canvas, give note_create/task_create a canvas object
(connect_to: ["note:<id>" or card ids], label, direction): it is placed and linked as
soon as it exists. For existing items, canvas_edit adds note cards (placed next to
`near`, without overlap), connects cards with labelled arrows, moves cards or removes
relations (add_tasks puts tasks on it; refer to cards as note:<id> or task:<id>).
Link only when the relation is meaningful ("supports", "contradicts", "method of",
"next step") and keep the user's existing cards and relations.""",
    "collections": """list_collections gives every collection with its fields, folders and the action names
that create, update or delete its items. get_collection reads one schema in full.
Custom collections use record_create, record_update (values are merged; send only
changed fields), record_organize and record_delete with database_id. Values follow
the field types (select options, ISO dates, lists...). collection_create and
collection_update change the collection itself (fields, content template). Built-in
collections (articles, notes, tasks, conferences, datasets...) use their domain
actions. Check duplicates with search or list_records before creating items.""",
    "organization": """To organize, rename, move or delete data, read get_organization, then each action's
schema. file_* operations only target the selected files; note_organize handles note
titles and filing. project_create (name, description, color) works without an open
project. Deletions show the affected items in the preview. Call get_organization
again after an approved creation to get the real ID.""",
}
TOOL_HINTS = {
    "note_update": "Replace an exact unique HTML passage of a note read with read_note; empty old_text appends.",
    "note_block_update": "Replace one block of a note by its id (from read_note).",
    "note_block_insert": "Insert HTML after a block id of a note; after_block_id null appends at the end.",
    "note_block_delete": "Remove blocks of a note by their ids.",
    "note_content_replace": "Rewrite the whole body of a note with new HTML or Markdown.",
    "note_properties_update": "Change a note's properties or presentation (width, theme).",
    "record_create": "Create an item in a custom collection; values follow get_collection fields.",
    "record_update": "Change fields of a custom collection item; values are merged with the current ones.",
    "collection_update": "Change a custom collection: name, icon, fields (existing field types stay), content_template.",
    "canvas_edit": "Edit a project canvas (path from get_canvas): add_notes, connect (labelled arrows), move, remove_edges.",
    "note_create": "Create a note; start content with '# Title' like the editor's New note, canvas={connect_to, label} also places it on the project canvas.",
    "note_script_set": "Insert or replace a sandboxed script block in a note (raw HTML/CSS/JS; see get_note_format_guide).",
    "script_create": "Add a reusable script (name, description, tags, html, css, js) to the script library.",
    "script_update": "Change a library script; only send the changed fields.",
    "script_delete": "Remove a script from the library; notes keep their own copies.",
    "project_create": "Create a project (name, description, color).",
}
# Write tools exposed by name in every request; the others go through propose_action.
NAMED_ALWAYS = ("note_create", "note_block_update", "note_block_insert", "note_block_delete", "note_update",
                "note_content_replace", "note_properties_update", "record_create", "record_update")
NAMED_BY_AREA = {"canvas": ("canvas_edit",), "project": ("canvas_edit",), "projects": ("project_create",),
                 "dashboard": ("project_create",), "papers": ("paper_organize", "paper_folder_create"),
                 "notes": ("note_organize",), "database": ("record_organize",)}


class Action(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal[tuple([*actions.SCHEMAS, "note_update", "canvas_update"])]
    label: str = Field(min_length=1, max_length=200)
    values: dict
    id: int | str | None = None
    path: str | None = None
    database_id: str | None = None


class NotePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    old_text: str = Field(description="Exact, unique passage; empty to append at the end.")
    new_text: str


class CanvasPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    nodes: list[dict]
    edges: list[dict]


ACTION_MODELS = {**actions.SCHEMAS, "note_update": NotePatch, "canvas_update": CanvasPatch}
LEGACY_PARTIAL = {"event_update", "dataset_update", "conference_update"}


def compact(value: Any) -> Any:
    """Drop empty values (None, "", [], {}) recursively; keep 0 and False."""
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            item = compact(item)
            if item is None or item == "" or item == [] or item == {}:
                continue
            result[key] = item
        return result
    if isinstance(value, list):
        return [compact(item) for item in value]
    return value


def dumps(value: Any) -> str:
    return json.dumps(compact(value), ensure_ascii=False, separators=(",", ":"), default=str)


def compact_schema(schema: Any, in_properties: bool = False) -> Any:
    """Smaller JSON schema with the same constraints: no titles, `type: [X, null]` for optional values."""
    if isinstance(schema, list):
        return [compact_schema(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    if in_properties:
        return {name: compact_schema(value) for name, value in schema.items()}
    result = {}
    for key, value in schema.items():
        if key == "title" and isinstance(value, str):
            continue
        if key == "default" and value is None:
            continue
        result[key] = compact_schema(value, in_properties=key in {"properties", "$defs", "definitions"})
    options = result.get("anyOf")
    if isinstance(options, list) and len(options) == 2 and {"type": "null"} in options:
        other = next(option for option in options if option != {"type": "null"})
        if isinstance(other.get("type"), str) and "$ref" not in other:
            result.pop("anyOf")
            result.update({**other, "type": [other["type"], "null"]})
    return result


def action_summary(kind: str) -> str:
    entry = load_plugins().agent_actions.get(kind, {})
    if entry.get("summary"):
        return entry["summary"]
    if kind in TOOL_HINTS:
        return TOOL_HINTS[kind]
    doc = (ACTION_MODELS[kind].__doc__ or "").strip().splitlines()
    return doc[0] if doc and not doc[0].startswith(("A base class", "Usage docs")) else kind.replace("_", " ")


def _action_request_model(kind: str, model: type[BaseModel]) -> type[BaseModel]:
    """Publish each domain's actual schema, including required target identifiers."""
    optional_fields = {}
    if kind in LEGACY_PARTIAL or load_plugins().agent_actions.get(kind, {}).get("partial"):
        # prepare merges these full-input models with the captured object.
        # Keep constraints for supplied values, but let agents omit unchanged fields.
        for name, field in model.model_fields.items():
            if field.is_required():
                partial = copy.deepcopy(field)
                partial.default = None
                optional_fields[name] = (field.annotation, partial)
    values_model = create_model(kind + "_values", __base__=model,
                                __config__=ConfigDict(extra="forbid"), **optional_fields)
    fields = {
        "label": (str, Field(min_length=1, max_length=200, description="Label of the proposal in the chat.")),
        "values": (values_model, ...),
    }
    domain, operation = kind.rsplit("_", 1)
    if domain in {"record", "collection", "collection_folder"} and kind != "collection_create":
        fields["database_id"] = (str, Field(min_length=1))
    if kind in {"canvas_update", "canvas_edit"} or (domain == "file" and operation != "create"):
        fields["path"] = (str, Field(min_length=1))
    elif operation not in {"create", "import"} and domain != "collection":
        fields["id"] = (str if domain in {"record", "collection_folder"} else int, ...)
    return create_model(kind + "_request", __config__=ConfigDict(extra="forbid"), **fields)


def named_actions(run: dict) -> list[str]:
    """Write tools exposed by name for this request: the common note and record edits, plus the area's own."""
    if os.getenv(TOOLSET_ENV, "").lower() == "full":
        return list(ACTION_MODELS)
    context = run.get("context") or {}
    area = context.get("area") or context.get("view") or "dashboard"
    names = [*NAMED_ALWAYS, *NAMED_BY_AREA.get(area, ())]
    if context.get("canvas_path"):
        names.append("canvas_edit")
    names += [kind for kind, entry in load_plugins().agent_actions.items() if area in entry.get("areas", ())]
    return [name for name in dict.fromkeys(names) if name in ACTION_MODELS]


def _active(run: dict) -> None:
    if run["status"] != "running" or run["workspace"] != str(settings.storage_path.resolve()):
        raise ValueError("This MCP request has ended or belongs to another workspace.")


def _check_scope(action: dict, run: dict) -> None:
    context = run["context"]
    kind = action["kind"]
    if kind in actions.organization.SCHEMAS or kind in actions.SCRIPT_KINDS:
        return  # prepare validates against the scoped organization snapshot / script library.
    organization = run["baseline"].get("organization", {})
    if kind.startswith("record_") and action.get("database_id") not in organization.get("collection_records", {}) and action.get("database_id") != context.get("collection_id"):
        raise ValueError("Collection outside this request’s context.")
    if kind.endswith("_update") and kind not in actions.NOTE_KINDS | {"canvas_update"}:
        collection = "collection" if kind == "record_update" else actions.COLLECTIONS[kind.split("_")[0]]
        records = organization.get(collection, context.get("records", {}).get(collection, []))
        if kind == "record_update":
            records = organization.get("collection_records", {}).get(action.get("database_id"), records)
        if not any(str(item["id"]) == str(action.get("id")) for item in records):
            raise ValueError("Object outside this request’s context.")
    project_id = context.get("project_id")
    values = action["values"]
    if project_id:
        if "project_id" in values and str(values["project_id"]) != str(project_id):
            raise ValueError("Destination project outside the context.")
        if "project_ids" in values and values["project_ids"] != [project_id]:
            raise ValueError("Destination projects outside the context.")


def visible_refs(run: dict) -> set[str]:
    """Addresses this request may read: the same scope as the organization snapshot.

    Cached per organization snapshot: recomputing it rescans the whole workspace
    (state file, every collection item file, search index) on each tool call.
    """
    base = run["baseline"]
    organization = base.get("organization")
    cached = base.get("_refs_cache")
    if cached is not None and cached[0] is organization:
        return cached[1]
    refs = _compute_visible_refs(run)
    base["_refs_cache"] = (organization, refs)
    return refs


def _compute_visible_refs(run: dict) -> set[str]:
    snap = collections.snapshot(run)
    excluded = set(run["context"].get("excluded_resource_ids") or [])
    refs = {f"kavot://projects/{p['id']}" for p in snap.get("projects", [])}
    refs |= {f"kavot://notes/{n['id']}" for n in snap.get("notes", []) if not n.get("trashed_at") and f"note:{n['id']}" not in excluded}
    for definition in snap["collections"]:
        for row in collections._rows(snap, definition):
            if definition["id"] == "notes":
                continue
            if definition["id"] == "articles" and f"paper:{row['id']}" in excluded:
                continue
            refs.add(f"kavot://{definition['id']}/{row['id']}")
    # The user's own files (text, data, PDFs, images), within the project when the request has one.
    from urllib.parse import unquote
    from app.core.search.index import ensure_fresh
    scope = run["context"].get("project_id")
    for entry in ensure_fresh().items(collection="files", project_id=scope):
        if f"file:{unquote(entry['item_id'])}" not in excluded:
            refs.add(f"kavot://files/{entry['item_id']}")
    return refs


def _base(ref: str) -> str:
    return ref.split("#", 1)[0].removesuffix("/pdf")


CONTEXT_ROWS = 25
# Source fields an agent needs; a note's or article's path and link follow from its id (see "links").
SOURCE_FIELDS = {"id", "title", "kind", "evidence", "read_only", "warnings", "extraction_path"}
PLAIN_EVIDENCE = {"texte local", "document HTML local"}
LINKS = {"note": "/?view=notes&note_id=<id>", "paper": "/?view=papers&paper_id=<id>",
         "file": "/api/workspace/file?path=<url-encoded path>"}
PROJECT_FIELDS = {"id", "name", "description", "status", "repository_context_enabled"}


def compact_context(context: dict) -> dict:
    """get_context without the bulk: records become id/title lists, long catalogues are capped,
    and what is listed once (a source, the project) is not repeated under other keys."""
    result = copy.deepcopy(context)
    sources = []
    for source in result.get("sources", []):
        kept = {k: v for k, v in source.items() if k in SOURCE_FIELDS and v not in (None, [], "")}
        if kept.get("evidence") in PLAIN_EVIDENCE:
            kept.pop("evidence")
        if source.get("truncated"):
            kept["truncated"] = True
        if not (source.get("note_id") or source.get("paper_id")):
            kept["path"] = source.get("path")
        sources.append(kept)
    result["sources"] = sources
    if sources:
        result["links"] = LINKS
    listed = {source["id"] for source in sources}
    target = result.get("target_note")
    if isinstance(target, dict) and target.get("id") in listed:
        result["target_note"] = {"id": target["id"], "title": target.get("title")}
    if isinstance(result.get("open_documents"), list):
        result["open_documents"] = [item.get("id") for item in result["open_documents"] if isinstance(item, dict)]
    if isinstance(result.get("project"), dict):
        result["project"] = {k: v for k, v in result["project"].items() if k in PROJECT_FIELDS}
    project_id = result.get("project_id")
    # The catalogue lists the other notes in scope: those in sources are already named there.
    result["note_catalog"] = [{k: v for k, v in note.items() if v is not None and not (k == "project_id" and v == project_id)}
                              for note in result.get("note_catalog") or [] if f"note:{note.get('id')}" not in listed]
    if not result["note_catalog"]:
        result.pop("note_catalog")
    records = result.pop("records", {}) or {}
    summary = {}
    for key, rows in records.items():
        if not isinstance(rows, list):
            continue
        summary[key] = {"count": len(rows), "items": [
            {"id": row.get("id") or row.get("entity_id"), "title": collections._title(row) if row.get("id") else row.get("title")}
            for row in rows[:CONTEXT_ROWS] if isinstance(row, dict)]}
        if len(rows) > CONTEXT_ROWS:
            summary[key]["more"] = f"{len(rows) - CONTEXT_ROWS} more: use search or list_records"
    if summary:
        result["records"] = summary
    catalog = result.get("note_catalog") or []
    if len(catalog) > CONTEXT_ROWS:
        result["note_catalog"] = catalog[:CONTEXT_ROWS]
        result["note_catalog_more"] = f"{len(catalog) - CONTEXT_ROWS} more notes: use search or list_notes"
    # Same values under other keys: the canvas path, the target among the open documents.
    if result.get("resource_path") and result.get("resource_path") == result.get("canvas_path"):
        result.pop("resource_path")
    result.pop("captured_at", None)
    canvas = result.get("canvas")
    if isinstance(canvas, dict):
        canvas["nodes"] = [{k: v for k, v in node.items() if k in {"id", "type", "title", "noteId", "recordId", "paperId", "databaseId"}}
                           for node in canvas.get("nodes", [])]
        canvas["edges"] = [{k: v for k, v in edge.items() if k in {"id", "fromNode", "toNode", "label"}} for edge in canvas.get("edges", [])]
    graph = result.get("citation_graph")
    if isinstance(graph, dict):
        articles = graph.get("articles") or []
        result["citation_graph"] = {k: v for k, v in graph.items() if k not in {"articles", "candidates", "filtered_ids"}}
        result["citation_graph"]["article_count"] = len(articles)
        result["citation_graph"]["read_with"] = "get_article_pack"
    return result


def _sdk():
    """Load either SDK lazily so opening the desktop does not require MCP."""
    try:
        try:
            from mcp.server.mcpserver import MCPServer
        except ModuleNotFoundError as error:
            if error.name != "mcp.server.mcpserver":
                raise
            from mcp.server.fastmcp import FastMCP
            from mcp.types import ToolAnnotations
            return FastMCP, ToolAnnotations, False
        from mcp_types import ToolAnnotations
        return MCPServer, ToolAnnotations, True
    except ModuleNotFoundError as error:
        if error.name and not error.name.startswith("mcp"):
            raise
        raise RuntimeError(
            "The MCP SDK is missing or incomplete "
            "in this Python environment. Install it with the same interpreter:\n"
            f'"{sys.executable}" -m pip install "mcp>=2.3,<3"\n'
            "Puis relancez Kavot."
        ) from error


def _transport_options():
    from mcp.server.transport_security import TransportSecuritySettings
    return {"stateless_http": True, "json_response": True,
            "transport_security": TransportSecuritySettings(allowed_hosts=["127.0.0.1:*"], allowed_origins=[])}


@dataclass
class ToolContext:
    """What a plugin's MCP installer receives to declare tools on a run's server."""
    run: dict
    lock: Any
    emit: Any
    tool: Any
    read_only: Any
    network_read: Any
    annotations: Any

    def active(self) -> None:
        _active(self.run)

    @staticmethod
    def compact(value: Any) -> Any:
        return compact(value)


def _compact_registered_schemas(server) -> None:
    manager = getattr(server, "_tool_manager", None)
    tools = manager.list_tools() if manager is not None and hasattr(manager, "list_tools") else []
    for registered in tools:
        if isinstance(getattr(registered, "parameters", None), dict):
            registered.parameters = compact_schema(registered.parameters)


def create_server(run: dict, lock, emit):
    """Reuse a captured chat context and the same action validation as the UI."""
    Server, ToolAnnotations, v2 = _sdk()
    # v2 moves transport settings from the constructor to the ASGI app factory.
    # The rules are in the conversation's AGENTS.md when the engine repeats them per tool.
    instructions = "Kavot workspace tools; rules in AGENTS.md." if run.get("tool_rules_in_agents") else INSTRUCTIONS
    server = Server("Kavot", instructions=instructions, log_level="WARNING",
                    **({} if v2 else _transport_options()))
    read_only = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)
    network_read = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=True)
    if v2:
        from mcp.server.mcpserver.exceptions import ToolError
    else:
        from mcp.server.fastmcp.exceptions import ToolError

    def tool(**options):
        """Expose expected domain errors to the agent, and return one compact JSON text block."""
        def decorate(function):
            @wraps(function)
            def checked(*args, **kwargs):
                try:
                    result = function(*args, **kwargs)
                except (ValueError, HTTPException, FileNotFoundError) as error:
                    raise ToolError(str(getattr(error, "detail", error))) from None
                return result if isinstance(result, str) else dumps(result)
            try:
                return server.tool(structured_output=False, **options)(checked)
            except TypeError:  # SDKs without structured output keep their default.
                return server.tool(**options)(checked)
        return decorate

    guides = {**GUIDES, **load_plugins().agent_guides}

    @tool(annotations=read_only)
    def get_context() -> dict[str, Any]:
        """This request's project, target, record summaries and selected source catalogue.

        Source text is read with read_source; record details with read or get_record.
        """
        with lock:
            _active(run)
            emit(run, "tool", "Context read", "MCP · Kavot")
            return {"run_id": run["id"], "mode": run["mode"], "context": compact_context(run["context"])}

    @tool(annotations=read_only)
    def workspace_overview() -> dict[str, Any]:
        """Collections with item counts, projects, recent changes, guide topics and search status, in one call."""
        from app.core import journal
        from app.core.search import status
        with lock:
            _active(run)
            catalog = collections.catalog(run)
            snap = run["baseline"]["organization"]
            emit(run, "tool", "Workspace overview", "MCP · Kavot")
            scope = run["context"].get("project_id")
            history = [entry for entry in journal.history(limit=40) if not scope or entry.get("ref") in visible_refs(run)][:8]
            return {"collections": [{"id": c["id"], "name": c["name"], "count": c.get("record_count"), "builtin": c["builtin"]} for c in catalog],
                    "projects": [{"id": p["id"], "name": p.get("name")} for p in snap.get("projects", [])][:50],
                    "recent_changes": [{"at": e["at"], "by": e["author"].get("kind"), "op": e["op"], "ref": e["ref"], "title": e.get("title")} for e in history],
                    "guides": sorted(guides), "search": {k: v for k, v in status().items() if k in {"documents", "vectors"}},
                    "write_tools": named_actions(run) if run["mode"] in PROPOSAL_LIMITS else []}

    @tool(annotations=read_only)
    def get_guide(topic: str) -> dict[str, Any]:
        """Detailed rules for one kind of task; read once per conversation before doing it."""
        with lock:
            _active(run)
            if topic not in guides:
                raise ValueError(f"Unknown topic. Topics: {', '.join(sorted(guides))}.")
            emit(run, "tool", "Guide read", topic)
            return {"topic": topic, "guide": guides[topic]}

    @tool(annotations=read_only)
    def search(query: Annotated[str, Field(min_length=1, max_length=500)],
               collections: list[str] | None = None,
               project_id: int | None = None, mode: Literal["auto", "lexical", "semantic"] = "auto",
               limit: Annotated[int, Field(ge=1, le=30)] = 8, offset: Annotated[int, Field(ge=0)] = 0) -> dict[str, Any]:
        """Search everything in scope: notes (by passage), articles (metadata and PDF pages), tasks, collection items.

        Stages: words (accents ignored), then partial-word matching, then meaning when local
        embeddings are on. Returns snippets with kavot:// refs; open one with read(ref).
        `more` counts other matching passages of the same item.
        """
        from app.core.search import search as run_search
        with lock:
            _active(run)
            allowed = visible_refs(run)
            scope = run["context"].get("project_id")
            if scope and project_id not in (None, scope):
                raise ValueError("Project outside this request's scope.")
            emit(run, "tool", "Workspace search", query)
            window = (offset + limit) * 3 + 20
            result = run_search(query, collections=collections, project_id=project_id or scope,
                                mode=mode, limit=window, offset=0)
            hits = [hit for hit in result["hits"] if _base(hit["ref"]) in allowed]
            page = hits[offset:offset + limit]
            if not page:
                return {"hits": 0, "hint": "No match in scope. Try other or fewer words, mode=semantic, or remove filters."}
            return {"stages": result["stages"], "hits": page,
                    "next_offset": offset + limit if offset + limit < len(hits) else None}

    @tool(annotations=read_only)
    def read(ref: Annotated[str, Field(min_length=10, max_length=300)], fields: list[str] | None = None,
             offset: Annotated[int, Field(ge=0)] = 0,
             limit: Annotated[int, Field(ge=200, le=6000)] = 3000) -> dict[str, Any]:
        """Open a kavot:// address from search, get_links or get_context.

        Notes return text passages from the given block (#block-id) with `next`; articles
        return metadata, or one PDF page with #page-<n>; other items return their fields
        (fields=[...] keeps only some). To edit a note, use read_note.
        """
        from app.core.records import api as records
        with lock:
            _active(run)
            if _base(ref) not in visible_refs(run):
                raise ValueError("Address outside this request's scope or unknown. Use search to find addresses.")
            emit(run, "tool", "Item read", ref)
            result = records.read(ref, offset=offset, limit=limit, fields=fields)
            if ref.startswith("kavot://notes/") and "#" not in ref and not result.get("next"):
                return digest_hint(_base(ref), result)
            return result

    @tool(annotations=read_only)
    def explore(ref: Annotated[str | None, Field(max_length=300)] = None,
                depth: Annotated[int, Field(ge=1, le=2)] = 1, collections: list[str] | None = None,
                offset: Annotated[int, Field(ge=0)] = 0, limit: Annotated[int, Field(ge=1, le=50)] = 20) -> dict[str, Any]:
        """Workspace map with the token cost of each child. No ref: collections, projects, themes.

        kavot://projects/<id>, kavot://collections/<id>: profile, themes, items. An item: facts,
        summary, outline (sections, pages). depth=2: children's outlines, item links.
        """
        from app.core import digest
        with lock:
            _active(run)
            emit(run, "tool", "Workspace map", ref or "workspace")
            return digest.explore(ref, depth=depth, offset=offset, limit=limit, collections=collections,
                                  allowed=visible_refs(run))

    @tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
    def save_digest(ref: Annotated[str, Field(min_length=10, max_length=300)],
                    summary: Annotated[str, Field(min_length=20, max_length=1500)],
                    sections: dict[str, Annotated[str, Field(max_length=400)]] | None = None,
                    keywords: Annotated[list[str], Field(max_length=12)] | None = None) -> dict[str, Any]:
        """Keep your summary of an item read in full; later requests use it instead of the source.

        sections: anchor (block id, page-<n>) -> one sentence. Only what the source says.
        """
        from app.core.digest import store
        with lock:
            _active(run)
            base = _base(ref)
            if base not in visible_refs(run):
                raise ValueError("Address outside this request's scope.")
            emit(run, "tool", "Summary saved", ref)
            saved = store.save(base, summary, sections=sections, keywords=keywords,
                               author={"kind": "agent", "engine": run.get("engine"), "model": run.get("model"), "run": run["id"]})
            return {"ref": saved["ref"], "saved": True, "sections": len(saved["sections"])}

    @tool(annotations=read_only)
    def get_links(ref: Annotated[str, Field(min_length=10, max_length=300)], relation: str | None = None,
                  direction: Literal["both", "in", "out"] = "both",
                  limit: Annotated[int, Field(ge=1, le=100)] = 30) -> dict[str, Any]:
        """Items linked to an address (project membership, citations, reading notes, canvas arrows…), with provenance."""
        from app.core import links
        with lock:
            _active(run)
            allowed = visible_refs(run)
            if _base(ref) not in allowed:
                raise ValueError("Address outside this request's scope.")
            emit(run, "tool", "Links read", ref)
            result = links.neighbors(ref, relation, direction, limit=500)
            result["links"] = [link for link in result["links"] if link["ref"] in allowed][:limit]
            result["total"] = len(result["links"])
            return result

    @tool(annotations=read_only)
    def get_history(ref: str | None = None, collection: str | None = None,
                    author: Literal["user", "agent", "workflow", "watcher", "sync", "system"] | None = None,
                    limit: Annotated[int, Field(ge=1, le=50)] = 15) -> dict[str, Any]:
        """Recent changes (latest first) of an item or a collection, with who made them."""
        from app.core import journal
        with lock:
            _active(run)
            allowed = visible_refs(run)
            entries = [e for e in journal.history(ref, collection, author, limit=limit * 4) if e.get("ref") in allowed][:limit]
            emit(run, "tool", "History read", ref or collection or "workspace")
            return {"entries": [{"at": e["at"], "by": e["author"], "op": e["op"], "ref": e["ref"], "title": e.get("title")} for e in entries]}

    @tool(annotations=read_only)
    def read_source(source_id: str, offset: Annotated[int, Field(ge=0)] = 0,
                    limit: Annotated[int, Field(ge=1, le=8000)] = 6000,
                    page: Annotated[int, Field(ge=1)] | None = None) -> dict[str, Any]:
        """Read a selected source by its catalogue ID, in character chunks; for PDFs pass a page (omit it to list pages)."""
        with lock:
            _active(run)
            source = next((s for s in run["context"].get("sources", []) if s["id"] == source_id), None)
            if source is None:
                raise ValueError("Source missing from the context or excluded from this request.")
            text = source.get("text", "")
            truncated = source.get("truncated", False)
            if "pages" in source:
                if page is None:
                    return {"source_id": source_id, "pages": [p["page"] for p in source["pages"]],
                            "evidence": source.get("evidence"), "warnings": source.get("warnings", [])}
                selected = next((p for p in source["pages"] if p["page"] == page), None)
                if selected is None:
                    raise ValueError("Page absente de l'extraction disponible.")
                text, truncated = selected["text"], selected.get("truncated", False)
            elif page is not None:
                raise ValueError("This source has no paginated extraction.")
            # Notes already have a complete frozen baseline for conflict checks.
            elif source.get("note_id"):
                baseline = run["baseline"]["notes"].get(str(source["note_id"]))
                if baseline:
                    text, truncated = baseline["text"], False
            end = min(offset + limit, len(text))
            emit(run, "tool", "Source read", source["title"])
            result = {"source_id": source_id, "text": text[offset:end], "page": page,
                      "next_offset": end if end < len(text) else None, "source_truncated": truncated,
                      "evidence": source.get("evidence"), "href": source.get("href"),
                      "warnings": source.get("warnings", [])}
            if source.get("note_id") and end >= len(text):
                return digest_hint(f"kavot://notes/{source['note_id']}", result)
            return result

    @tool(annotations=read_only)
    def get_organization() -> dict[str, Any]:
        """Folders, projects, collections and IDs in scope, for organizing; call again after an approved creation."""
        with lock:
            _active(run)
            snapshot = actions.organization.capture(run["context"])
            run["baseline"]["organization"] = snapshot
            emit(run, "tool", "Organization read", "MCP · Kavot")
            return {"organization": actions.organization.public(snapshot)}

    @tool(annotations=read_only)
    def list_collections() -> dict[str, Any]:
        """Collections in scope with their field ids, item count and action names (get_collection for full fields)."""
        with lock:
            _active(run)
            emit(run, "tool", "Collections read", "MCP · Kavot")
            return {"collections": [{k: v for k, v in c.items() if k not in {"fields", "icon", "views", "record_kind"}}
                                    for c in collections.catalog(run)]}

    @tool(annotations=read_only)
    def get_collection(collection_id: str) -> dict[str, Any]:
        """One collection's full definition: fields, options, defaults, folders and content template."""
        with lock:
            _active(run)
            result = collections.collection(run, collection_id)
            emit(run, "tool", "Collection read", result["name"])
            return result

    @tool(annotations=read_only)
    def list_records(collection_id: str, query: str = "", folder_id: str | None = None,
                     fields: list[str] | None = None, offset: Annotated[int, Field(ge=0)] = 0,
                     limit: Annotated[int, Field(ge=1, le=100)] = 30) -> dict[str, Any]:
        """List items of a collection (substring filter, folder); fields=[...] keeps only those fields.

        For finding items by meaning or words, search is cheaper.
        """
        from app.core.records.api import project
        with lock:
            _active(run)
            emit(run, "tool", "Items read", collection_id)
            result = collections.records(run, collection_id, query, folder_id, offset, limit)
            if fields:
                result["items"] = [project(item, fields) | {"title": item.get("title")} for item in result["items"]]
            result.pop("note", None)
            return result

    @tool(annotations=read_only)
    def get_record(collection_id: str, record_id: str, fields: list[str] | None = None) -> dict[str, Any]:
        """One complete item of a collection; fields=[...] keeps only those fields."""
        from app.core.records.api import project
        with lock:
            _active(run)
            emit(run, "tool", "Item read", collection_id)
            result = collections.record(run, collection_id, record_id)
            if fields:
                result["record"] = project(result["record"], fields)
                result.pop("fields", None)
            return result

    @tool(annotations=read_only)
    def list_notes(query: str = "", project_id: int | None = None, folder_id: int | None = None,
                   offset: Annotated[int, Field(ge=0)] = 0,
                   limit: Annotated[int, Field(ge=1, le=200)] = 50) -> dict[str, Any]:
        """Notes in scope by title or tag, project or folder: IDs, a one-line gist, full size in tokens, and note folders."""
        with lock:
            _active(run)
            from app.core.digest import levels
            emit(run, "tool", "Notes listed", query or "MCP · Kavot")
            result = collections.notes(run, query, project_id, folder_id, offset, limit)
            result["notes"] = [{**note, **levels.gist(note["id"])} for note in result["notes"]]
            return result

    def digest_hint(note_ref: str, result: dict) -> dict:
        """Ask once per request for a summary of a note read in full that has no current one.

        With a summary model configured, a light model writes it in the background instead.
        """
        from app.core.agents import digests
        from app.core.digest import levels
        hinted = run.setdefault("digest_hints", set())
        if note_ref not in hinted and levels.needs_digest(note_ref):
            hinted.add(note_ref)
            if not digests.queue(note_ref):
                result["digest"] = levels.SAVE_HINT
        return result

    @tool(annotations=read_only)
    def get_note(note_id: int, level: Literal[1, 2, 3] = 1, section: str | None = None,
                 limit: Annotated[int, Field(ge=500, le=12000)] = 6000) -> dict[str, Any]:
        """A note at the depth the request needs: 1 brief (place, relations, gist, cost of deeper levels),
        2 summary and outline with a gist per section, 3 text window by window (section=<block id> for one part).
        """
        from app.core.digest import levels
        with lock:
            _active(run)
            address = levels.ref(note_id)
            allowed = visible_refs(run)
            if address not in allowed:
                raise ValueError("Note outside this request's scope. Use list_notes or search.")
            emit(run, "tool", f"Note read (level {level})", str(note_id))
            if level == 1:
                return levels.brief(note_id, allowed)
            if level == 2:
                return levels.detail(note_id, allowed)
            result = levels.content(note_id, section, limit)
            return digest_hint(address, result) if not section and not result.get("next") else result

    @tool(annotations=read_only)
    def read_note(note_id: int, offset: Annotated[int, Field(ge=0)] = 0,
                  limit: Annotated[int, Field(ge=1, le=20000)] = 10000) -> dict[str, Any]:
        """A note's HTML body with stable block ids, in chunks; makes the note editable in this request."""
        with lock:
            _active(run)
            note = actions.load_note(run, note_id)
            text = note["text"]
            end = min(offset + limit, len(text))
            emit(run, "tool", "Note read", note.get("title") or str(note_id))
            result = {"note_id": note_id, "title": note.get("title"), "path": note["path"],
                      "html": text[offset:end], "next_offset": end if end < len(text) else None,
                      "properties": note.get("metadata", {}).get("properties", {}),
                      "presentation": note.get("metadata", {}).get("presentation", {})}
            return digest_hint(f"kavot://notes/{note_id}", result) if end >= len(text) else result

    @tool(annotations=read_only)
    def get_canvas(project_id: int | None = None) -> dict[str, Any]:
        """A project canvas: cards (note_id, title), positions and relations; its path is what canvas_edit expects."""
        from app.core.projects import canvas as agent_canvas
        with lock:
            _active(run)
            project_id = project_id or run["context"].get("project_id")
            if not project_id:
                raise ValueError("No project in this request; pass project_id (see get_organization).")
            scope = run["baseline"].get("organization") or {}
            if not any(p["id"] == project_id for p in scope.get("projects", [])):
                raise ValueError("Project outside this request's scope.")
            relative = agent_canvas.project_canvas(project_id)
            content = agent_canvas.read(relative)
            run["baseline"]["canvases"][relative] = content  # Later edits compare against what the agent saw.
            emit(run, "tool", "Canvas read", relative)
            return agent_canvas.public(content, relative)

    @tool(annotations=read_only)
    def get_note_format_guide() -> dict[str, Any]:
        """Everything the note editor keeps: text styles, layouts, embeds, scripts and note settings."""
        from app.core.workspace import note_format
        with lock:
            _active(run)
            emit(run, "tool", "Format guide read", "MCP · Kavot")
            return note_format.guide()

    @tool(annotations=read_only)
    def list_scripts(query: str = "") -> dict[str, Any]:
        """The note script library (id, name, description, tags); get_script returns the code."""
        from app.core.records.repository import store
        with lock:
            _active(run)
            needle = query.casefold().strip()
            scripts = [s for s in store.list("note_scripts") if not needle or needle in
                       " ".join([str(s.get("name")), str(s.get("description")), *map(str, s.get("tags") or [])]).casefold()]
            emit(run, "tool", "Scripts listed", query or "MCP · Kavot")
            return {"scripts": [{k: s.get(k) for k in ("id", "name", "description", "author", "tags", "updated_at")} for s in scripts]}

    @tool(annotations=read_only)
    def get_script(script_id: int) -> dict[str, Any]:
        """One library script with its HTML, CSS and JavaScript."""
        from app.core.records.repository import store
        with lock:
            _active(run)
            script = next((s for s in store.list("note_scripts") if s["id"] == script_id), None)
            if script is None:
                raise ValueError("Library script not found. Use list_scripts.")
            emit(run, "tool", "Script read", script.get("name") or str(script_id))
            return copy.deepcopy(script)

    @tool(annotations=read_only)
    def list_actions() -> dict[str, Any]:
        """Every change kind with a one-line summary; named write tools are marked."""
        with lock:
            _active(run)
            named = set(named_actions(run)) if run["mode"] in PROPOSAL_LIMITS else set()
            return {"actions": {kind: ("[tool] " if kind in named else "") + action_summary(kind) for kind in ACTION_MODELS},
                    "how": "Named tools: call them directly. Others: get_action_schema(kind), then propose_action."}

    @tool(annotations=read_only)
    def get_action_schema(kind: str) -> dict[str, Any]:
        """The request schema (values, id, path, database_id) of one change kind, for propose_action."""
        with lock:
            _active(run)
            model = ACTION_MODELS.get(kind)
            if model is None:
                raise ValueError("Unknown action kind. Use list_actions.")
            return {"kind": kind, "request_schema": compact_schema(_action_request_model(kind, model).model_json_schema()),
                    "rules": ("In auto mode the change is applied immediately. " if run["mode"] == "auto" else
                              "A proposal changes nothing until it is approved in the chat. ") +
                             "Use IDs from the context. Keep fields not mentioned in the request. "
                             f"At most {PROPOSAL_LIMITS.get(run['mode'], 30)} changes per request."}

    plugin_tools = ToolContext(run=run, lock=lock, emit=emit, tool=tool, read_only=read_only,
                               network_read=network_read, annotations=ToolAnnotations)
    for install in load_plugins().mcp_tools:
        install(plugin_tools)

    local_folders = (run.get("context") or {}).get("local_folders") or []
    if local_folders:
        from app.core.workspace import local_files

        @tool(annotations=read_only)
        def local_tree(root: str, path: str = "") -> dict[str, Any]:
            """List a folder of a local folder opened by the workflow (root = its absolute path)."""
            with lock:
                _active(run)
                emit(run, "tool", "Local folder listed", path or root)
                return local_files.tree(run, root, path)

        @tool(annotations=read_only)
        def local_read(root: str, path: str, offset: Annotated[int, Field(ge=0)] = 0,
                       limit: Annotated[int, Field(ge=1, le=60000)] = 40000) -> dict[str, Any]:
            """Read a text file of a local folder opened by the workflow, in character chunks."""
            with lock:
                _active(run)
                emit(run, "tool", "Local file read", path)
                return local_files.read(run, root, path, offset, limit)

        if run["mode"] in PROPOSAL_LIMITS and any(folder.get("allow_changes") for folder in local_folders):
            def propose_file(kind: str, root: str, path: str, **values) -> dict[str, Any]:
                with lock:
                    _active(run)
                    if len(run["proposals"]) >= PROPOSAL_LIMITS["propose"]:
                        raise ValueError(f"At most {PROPOSAL_LIMITS['propose']} changes per request.")
                    proposal = local_files.prepare(run, kind, root, path, **values)
                    # Local files always wait for the user's approval, even in auto mode.
                    run["proposals"].append(proposal)
                    emit(run, "proposal", "Proposed file change", proposal["label"])
                    return {"proposal_id": proposal["proposal_id"], "status": "pending",
                            "message": "The diff waits for the user's approval in Kavot."}

            @tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False))
            def local_file_patch(root: str, path: str, old_text: str, new_text: str) -> dict[str, Any]:
                """Propose replacing one exact, unique passage of a local file; the user reviews the diff."""
                return propose_file("local_file_patch", root, path, old_text=old_text, new_text=new_text)

            @tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False))
            def local_file_write(root: str, path: str, content: str) -> dict[str, Any]:
                """Propose the whole content of a local file (new or rewritten); the user reviews the diff."""
                return propose_file("local_file_write", root, path, content=content)

    if run["mode"] in PROPOSAL_LIMITS:
        automatic = run["mode"] == "auto"

        def submit(action: Action) -> dict[str, Any]:
            with lock:
                _active(run)
                candidate = action.model_dump(exclude_none=True)
                _check_scope(candidate, run)
                proposal = actions.prepare(candidate, run)
                for existing in run["proposals"]:
                    if existing["action"] == proposal["action"]:
                        return {"proposal_id": existing["proposal_id"], "status": existing["status"],
                                **({"result": existing["result"]} if "result" in existing else {})}
                limit = PROPOSAL_LIMITS[run["mode"]]
                if len(run["proposals"]) >= limit:
                    raise ValueError(f"At most {limit} changes per request.")
                if not automatic:
                    run["proposals"].append(proposal)
                    emit(run, "proposal", "Proposed change", proposal["label"] + " — " + proposal["target"])
                    return {"proposal_id": proposal["proposal_id"], "status": "pending",
                            "message": "Proposal shown in the chat, waiting for approval."}
                from app.core import journal
                from app.core.agents.sessions import _artifact_versions
                before_files = _artifact_versions()
                with journal.author("agent", run=run["id"], engine=run.get("engine")):
                    result = actions.apply(proposal)
                after_files = _artifact_versions()
                proposal.update(status="applied", result=result)
                run["proposals"].append(proposal)
                run["modified_files"] = sorted(set(run.get("modified_files", [])) | {
                    path for path in before_files.keys() | after_files.keys() if before_files.get(path) != after_files.get(path)})
                actions.refresh(run)
                from app.core.storage.cloud_sync.routes import notify_local_change
                notify_local_change()
                emit(run, "write", "Change applied", proposal["label"] + " — " + proposal["target"])
                return {"proposal_id": proposal["proposal_id"], "status": "applied", "result": result,
                        "message": "Applied and saved; this result is the confirmation, do not read it back. "
                                   "Read the object again only before another change to it."}

        @tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=automatic,
                                          idempotentHint=True, openWorldHint=False))
        def propose_action(action: Action) -> dict[str, Any]:
            """Prepare any change kind (see list_actions) with the request fields from get_action_schema."""
            try:
                return submit(action)
            except ValueError as error:
                # Invalid values: answer with the schema so the next attempt can be right.
                model = ACTION_MODELS.get(action.kind)
                hint = f" Expected request: {json.dumps(compact_schema(_action_request_model(action.kind, model).model_json_schema()), separators=(',', ':'))}" if model else ""
                raise ValueError(str(error) + hint) from None

        def register_action(kind, model):
            def propose(request):
                return submit(Action(kind=kind, **request.model_dump(exclude_unset=True)))

            propose.__name__ = kind
            propose.__doc__ = action_summary(kind)
            if "folder" in kind and not kind.endswith("_delete"):
                propose.__doc__ += " parent_id selects the parent folder; null places it at the root."
            if kind.endswith("_delete"):
                propose.__doc__ += " " + actions.organization.deletion_effect(kind)
            # Concrete annotations let both SDK versions expose the nested JSON schema.
            propose.__annotations__ = {"request": _action_request_model(kind, model), "return": dict[str, Any]}
            tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=automatic and kind.endswith("_delete"),
                                            idempotentHint=True, openWorldHint=False))(propose)

        for kind in named_actions(run):
            register_action(kind, ACTION_MODELS[kind])
    _compact_registered_schemas(server)
    return server


class LocalAuth:
    """A capability token supplied only to the child CLI, never to browser code."""
    def __init__(self, app, token: str):
        self.app, self.token = app, token

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope["headers"])
            if b"origin" in headers:
                await JSONResponse({"error": "Browser origins are not allowed."}, status_code=403)(scope, receive, send)
                return
            if not secrets.compare_digest(headers.get(b"authorization", b""), ("Bearer " + self.token).encode()):
                await JSONResponse({"error": "Unauthorized"}, status_code=401)(scope, receive, send)
                return
        await self.app(scope, receive, send)


@dataclass(frozen=True)
class Connection:
    url: str
    token: str


@contextmanager
def serve_run(run: dict, lock, emit):
    """Bind only loopback on an OS-selected port; stop on every exit path."""
    token = secrets.token_urlsafe(32)
    server = create_server(run, lock, emit)
    _, _, v2 = _sdk()
    app = LocalAuth(server.streamable_http_app(**(_transport_options() if v2 else {})), token)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        url = f"http://127.0.0.1:{listener.getsockname()[1]}/mcp"
        worker = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", log_config=None,
                                             access_log=False, lifespan="on", loop="asyncio",
                                             timeout_graceful_shutdown=2))
        thread = Thread(target=worker.run, kwargs={"sockets": [listener]}, daemon=True, name="kavot-mcp")
        run["mcp_token"] = token
        try:
            thread.start()
            deadline = time.monotonic() + 5
            while not worker.started:
                if not thread.is_alive() or time.monotonic() >= deadline:
                    raise RuntimeError("Unable to start the local MCP server.")
                time.sleep(0.01)
            emit(run, "status", "Connecting to Kavot tools", "Local MCP server ready")
            yield Connection(url, token)
        finally:
            worker.should_exit = True
            thread.join(timeout=5)
            run.pop("mcp_token", None)


def configure_client(engine: str, command: list[str], environment: dict, connection: Connection) -> list[str]:
    """Inject transient MCP settings without touching a user's CLI config files."""
    environment[TOKEN_ENV] = connection.token
    if engine == "codex":
        # Use leaf overrides so exec/resume receive typed MCP settings, and
        # finish tool discovery before the model's first turn.
        settings = [
            "mcp_servers.kavot.url=" + json.dumps(connection.url),
            'mcp_servers.kavot.bearer_token_env_var="' + TOKEN_ENV + '"',
            "mcp_servers.kavot.required=true",
            "mcp_servers.kavot.enabled=true",
            'mcp_servers.kavot.default_tools_approval_mode="approve"',
            "mcp_optional_startup_grace_ms=0",
        ]
        options = [argument for setting in settings for argument in ("-c", setting)]
        position = 3 if command[2:3] == ["resume"] else 2
        return command[:position] + options + command[position:]
    if engine == "claude":
        config = {"mcpServers": {"kavot": {"type": "http", "url": connection.url,
                  "headers": {"Authorization": "Bearer ${" + TOKEN_ENV + "}"}}}}
        # Non-interactive runs deny every tool not pre-approved, including the
        # native read tools enabled with --tools (WebSearch, WebFetch…).
        native = command[command.index("--tools") + 1].split(",") if "--tools" in command else []
        return command + ["--strict-mcp-config", "--mcp-config", json.dumps(config),
                          "--allowedTools", ",".join([*native, "mcp__kavot__*"])]
    # OpenCode supports environment substitution in inline JSON configuration.
    config = json.loads(environment.get("OPENCODE_CONFIG_CONTENT") or "{}")
    config.setdefault("mcp", {})["kavot"] = {"type": "remote", "url": connection.url,
        "enabled": True, "oauth": False, "headers": {"Authorization": "Bearer {env:" + TOKEN_ENV + "}"}}
    environment["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
    permissions = json.loads(environment["OPENCODE_PERMISSION"])
    permissions["kavot_*"] = "allow"
    environment["OPENCODE_PERMISSION"] = json.dumps(permissions)
    return command

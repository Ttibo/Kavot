"""The request context a chat conversation gives the agent (get_context), without the bulk.

The interface captures what the user is looking at (view, project, open note, canvas
selection, citation graph, picked sources); this makes it compact: records become
id/title lists, long catalogues are capped, nothing is listed twice.
"""
from __future__ import annotations

import copy

from app.mcp import collections

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

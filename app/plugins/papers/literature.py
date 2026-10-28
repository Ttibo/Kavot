"""Read-only literature discovery for an agent run; never imports papers."""
from __future__ import annotations

import copy
import re
from urllib.parse import urlencode

from fastapi import HTTPException

from app.plugins.papers.connectors import graph, source_settings

MAX_ARTICLES = 600


def doi(value):
    return re.sub(r"^(?:doi:\s*|https?://(?:dx\.)?doi\.org/)", "", str(value or "").strip(), flags=re.I).casefold()


def excluded(run, node):
    ids = set(run["context"].get("excluded_resource_ids") or [])
    for paper in run.get("baseline", {}).get("state", {}).get("papers", []):
        if f"paper:{paper['id']}" not in ids:
            continue
        if (doi(paper.get("doi")) and doi(paper["doi"]) == doi(node.get("doi"))) or str(paper["id"]) == str(node.get("paper_id") or node.get("local_paper_id")):
            return True
        if str(node.get("id")) in {str(paper["id"]), f"local:{paper['id']}"}:
            return True
    return False


def register(run, nodes, *, complete_pack=False):
    catalog = run.setdefault("article_catalog", {})
    result = []
    fields = {"title", "authors", "abstract", "year", "published_at", "doi", "url", "publication", "pdf_url",
              "openalex_id", "origin", "metadata", "sources", "relation", "cited_by_count", "lookup_errors"}
    for node in nodes:
        if not isinstance(node, dict) or excluded(run, node):
            continue
        identifier = str(node.get("id") or node.get("openalex_id") or ("doi:" + doi(node["doi"]) if node.get("doi") else ""))
        if not identifier or not node.get("title"):
            continue
        if not complete_pack and identifier not in catalog and len(catalog) >= MAX_ARTICLES + len(run.get("article_pack", [])):
            continue
        item = {key: copy.deepcopy(value) for key, value in node.items() if key in fields}
        item["id"] = identifier
        item["local_paper_id"] = next((p["id"] for p in run["context"].get("records", {}).get("papers", [])
            if (doi(p.get("doi")) and doi(p["doi"]) == doi(node.get("doi"))) or
            str(p["id"]) == str(node.get("paper_id") or node.get("local_paper_id")) or
            str(node.get("id")) == str(p["id"])), None)
        item["evidence"] = "Metadata and abstract available; full text not read."
        item["href"] = "https://doi.org/" + str(node["doi"]) if node.get("doi") else node.get("url") or node.get("openalex_id")
        item["abstract"] = str(item.get("abstract") or "")[:16000]
        catalog[identifier] = {**catalog.get(identifier, {}), **item}
        result.append(copy.deepcopy(catalog[identifier]))
    return result


def initialize(run):
    if "article_pack" in run:
        return
    captured = run["context"].get("citation_graph") or {}
    focus = captured.get("focus") or captured.get("root")
    nodes = [*(captured.get("articles") or captured.get("candidates") or [])]
    if isinstance(focus, dict):
        nodes.insert(0, focus)
    if isinstance(captured.get("selected"), dict):
        nodes.append(captured["selected"])
    if not nodes:
        nodes = run["context"].get("records", {}).get("papers", [])
    items = register(run, nodes, complete_pack=True)
    run["article_pack"] = list(dict.fromkeys(item["id"] for item in items))
    run["article_focus"] = str(focus.get("id")) if isinstance(focus, dict) else None
    run["article_selected"] = str(captured["selected"].get("id")) if isinstance(captured.get("selected"), dict) else None


def pack(run, offset=0, limit=30):
    initialize(run)
    ids = run["article_pack"]
    selected = ids[offset:offset + limit]
    captured = run["context"].get("citation_graph") or {}
    return {"articles": [copy.deepcopy(run["article_catalog"][key]) for key in selected],
            "total": len(ids), "next_offset": offset + limit if offset + limit < len(ids) else None,
            "focus_id": run["article_focus"], "selected_id": run["article_selected"],
            "filtered_ids": [str(identifier) for identifier in captured.get("filtered_ids", [n.get("id") for n in captured.get("candidates", [])]) if str(identifier) in ids],
            "scope": "all_related_articles",
            "edges": [copy.deepcopy(e) for e in captured.get("edges", []) if str(e.get("source")) in ids and str(e.get("target")) in ids],
            "warning": captured.get("warning"), "provider_errors": captured.get("provider_errors", {}),
            "rules": "This pack contains every related article of the active graph, regardless of filters and the displayed page. Read every page with next_offset before drawing conclusions about the full pack. Cite DOI/URL. "
                     "Read abstracts with get_article_details and local sources with read_source. "
                     "A reference or an abstract does not prove the full text. "
                     "Rank by relevance to the question, explain limitations and do not confuse popularity with quality."}


def _alias(value):
    value = str(value or "").strip()
    normalized = doi(value)
    if re.fullmatch(r"10\.\d{4,9}/\S+", normalized):
        return "doi:" + normalized
    match = re.fullmatch(r"(?:https?://openalex\.org/|openalex:)?(W\d+)/?", value, flags=re.I)
    if match:
        return "openalex:" + match[1].upper()
    match = re.fullmatch(r"(?:local:|paper:)?(\d+)", value)
    if match:
        return "local:" + str(int(match[1]))
    return value


def reference(run, identifier=None):
    initialize(run)
    identifier = str(identifier if identifier is not None else run["article_selected"] or run["article_focus"] or "").strip()
    catalog = run["article_catalog"]
    if identifier in catalog:
        node = catalog[identifier]
    else:
        alias = _alias(identifier)
        matches = []
        for item in catalog.values():
            aliases = {item["id"], item.get("doi"), item.get("openalex_id"), item.get("url"), item.get("href")}
            if item.get("local_paper_id") is not None:
                aliases.add("local:" + str(item["local_paper_id"]))
            if alias and alias in {_alias(value) for value in aliases if value}:
                matches.append(item)
        if matches:
            # A DOI/OpenAlex/local identifier denotes the same article even when
            # several provider-specific graph nodes reference it.
            node = matches[0]
        elif alias.startswith("doi:") and re.fullmatch(r"10\.\d{4,9}/\S+", alias[4:]):
            node = {"doi": alias[4:], "title": ""}
        elif alias.startswith("openalex:") and re.fullmatch(r"W\d+", alias[9:]):
            node = {"openalex_id": "https://openalex.org/" + alias[9:], "title": ""}
        else:
            raise ValueError(f"Article not found: {identifier!r}. Call get_article_pack and copy "
                             "the id field, or use a DOI or an OpenAlex ID.")
    if excluded(run, node):
        raise ValueError("This article is excluded from the context.")
    return copy.deepcopy(node)


def search(query, limit):
    if not query.strip():
        raise ValueError("A question or keywords are required.")
    if not source_settings.enabled("openalex"):
        raise ValueError("Enable OpenAlex in the scholarly sources to search for articles by question.")
    payload = graph._request("openalex", "/works?" + urlencode({"search": query.strip(), "per-page": limit}), timeout=15)
    return {"articles": [graph._node(work, "search") for work in payload.get("results") or []],
            "total": (payload.get("meta") or {}).get("count"), "query": query, "provider": "openalex"}


def related(node, limit, direction):
    payload = graph.expand_graph(node, limit)
    nodes = payload.get("catalog") or payload.get("nodes") or []
    chosen = [n for n in nodes if str(n.get("id")) != str(payload.get("focus")) and
              (direction == "all" or n.get("relation") == direction)][:limit]
    focus = next((n for n in payload.get("nodes", []) if n.get("id") == payload.get("focus")), None)
    return {"articles": chosen, "focus": focus, "edges": payload.get("edges", []),
            "warning": payload.get("warning"), "provider_errors": payload.get("provider_errors", {}),
            "direction": direction}


def details(node):
    try:
        return graph.enrich_node(node, discover_pdf=False)
    except HTTPException as error:
        return {**node, "lookup_errors": [str(error.detail)]}

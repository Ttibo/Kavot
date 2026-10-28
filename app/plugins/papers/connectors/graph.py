from __future__ import annotations

import re
from typing import Any, Callable
from urllib.parse import quote, urlencode

from fastapi import HTTPException

from app.plugins.papers import library
from app.plugins.papers.connectors import citation_providers, importers, source_settings
from app.plugins.papers.connectors.http import request_json, download_pdf
from app.core.records.repository import now, store


def _request(source: str, path: str, **kwargs):
    return source_settings.request(source, path, request_json, **kwargs)


def _node(work: dict[str, Any], relation: str = "focus") -> dict[str, Any]:
    source = (work.get("primary_location") or {}).get("source") or {}
    return {
        "id": work.get("id"), "title": work.get("display_name") or "Untitled", "year": work.get("publication_year"),
        "authors": [item.get("author", {}).get("display_name") for item in (work.get("authorships") or [])[:8] if item.get("author", {}).get("display_name")],
        "doi": str(work.get("doi") or "").removeprefix("https://doi.org/"), "url": (work.get("primary_location") or {}).get("landing_page_url") or work.get("id"),
        "publication": source.get("display_name") or "", "abstract": " ".join(word for _, word in sorted((pos, word) for word, positions in (work.get("abstract_inverted_index") or {}).items() for pos in positions)), "pdf_url": next((loc.get("pdf_url") for loc in [work.get("best_oa_location") or {}, work.get("primary_location") or {}, *(work.get("locations") or [])] if loc.get("pdf_url")), None), "cited_by_count": work.get("cited_by_count", 0), "relation": relation,
        "openalex_id": work.get("id"), "origin": "openalex", "tags": [], "metadata": {"openalex_type": work.get("type")},
        "sources": ["openalex"], "referenced_works": work.get("referenced_works") or [],
    }


def _title_key(value: str) -> str:
    return " ".join(re.findall(r"\w+", value.casefold()))


def _work(identifier: str, fallback_title: str = "") -> dict[str, Any]:
    value = identifier.strip()
    if "openalex.org/" in value:
        value = value.rstrip("/").rsplit("/", 1)[-1]
    elif value.lower().startswith("10."):
        value = f"https://doi.org/{value}"
    try:
        return _request("openalex", f"/works/{quote(value, safe=':/()')}")
    except HTTPException as error:
        # DataCite/arXiv DOIs are not always attached to the corresponding
        # OpenAlex work. An exact title search resolves the canonical record.
        if not fallback_title or error.status_code not in {404, 502}:
            raise
        query = urlencode({"search": fallback_title, "per-page": 10})
        candidates = _request("openalex", f"/works?{query}").get("results") or []
        expected = _title_key(fallback_title)
        exact = [work for work in candidates if _title_key(str(work.get("display_name") or "")) == expected]
        if not exact:
            raise error
        return max(exact, key=lambda work: int(work.get("cited_by_count") or 0))


def _works_by_ids(identifiers: list[str]) -> list[dict[str, Any]]:
    ids = [value.rstrip("/").rsplit("/", 1)[-1] for value in identifiers]
    if not ids:
        return []
    query = urlencode({"filter": f"openalex:{'|'.join(ids)}", "per-page": len(ids)})
    return _request("openalex", f"/works?{query}").get("results") or []


def _remote_citation_graph(paper: dict[str, Any], limit: int = 20, persist: bool = True, progress: Callable | None = None) -> dict[str, Any]:
    identifier = paper.get("openalex_id") or paper.get("doi")
    if not identifier:
        raise HTTPException(status_code=422, detail="This article needs a DOI before its citation graph can be loaded")
    if progress:
        progress("resolve", "running")
    focus = _work(str(identifier), str(paper.get("title") or ""))
    focus_id = focus.get("id")
    if not focus_id:
        raise HTTPException(status_code=502, detail="OpenAlex returned an invalid work record")
    if persist and paper.get("id") and not paper.get("openalex_id"):
        store.update("papers", paper["id"], {"openalex_id": focus_id}, "Article")
    if progress:
        progress("resolve", "done")
        progress("references", "running")
    nodes = [_node(focus)]
    edges: list[dict[str, str]] = []
    errors: dict[str, str] = {}
    seen = {focus_id}
    referenced = (focus.get("referenced_works") or [])[:limit]
    try:
        for work in _works_by_ids(referenced):
            if work.get("id") not in seen:
                nodes.append(_node(work, "reference")); seen.add(work.get("id"))
            edges.append({"source": focus_id, "target": work.get("id"), "relation": "references"})
    except HTTPException as error:
        errors["openalex_references"] = str(error.detail)
    if progress:
        progress("references", "warning" if "openalex_references" in errors else "done")
        progress("citations", "running")
    query = urlencode({"filter": f"cites:{str(focus_id).rsplit('/', 1)[-1]}", "per-page": limit, "sort": "-cited_by_count"})
    try:
        citing = _request("openalex", f"/works?{query}").get("results") or []
    except HTTPException as error:
        errors["openalex_citations"] = str(error.detail)
        citing = []
    for work in citing:
        if work.get("id") not in seen:
            nodes.append(_node(work, "citation")); seen.add(work.get("id"))
        edges.append({"source": work.get("id"), "target": focus_id, "relation": "cites"})
    if progress:
        progress("citations", "warning" if "openalex_citations" in errors else "done")
    local_by_doi = {library.normalized_doi(item.get("doi")): item["id"] for item in store.list("papers") if library.normalized_doi(item.get("doi"))}
    for node in nodes:
        node["paper_id"] = (paper.get("id") if node["id"] == focus_id else None) or local_by_doi.get(library.normalized_doi(node.get("doi")))
    local_ids = {node["id"]: node.get("paper_id") for node in nodes if node.get("paper_id")}
    local_edges = [(local_ids.get(edge["source"]), local_ids.get(edge["target"]), edge) for edge in edges]
    if persist and any(source_id and target_id for source_id, target_id, _ in local_edges):
        with store.transaction() as state:
            for source_id, target_id, edge in local_edges:
                if not source_id or not target_id or source_id == target_id:
                    continue
                exists = any(item.get("source_id") == source_id and item.get("target_id") == target_id for item in state["citations"])
                if not exists:
                    timestamp = now()
                    state["citations"].append({"id": store.next_id(state, "citations"), "source_id": source_id, "target_id": target_id, "external_source_id": edge["source"], "external_target_id": edge["target"], "created_at": timestamp, "updated_at": timestamp})
    return {
        "focus": focus_id,
        "nodes": nodes,
        "edges": edges,
        "provider_errors": errors,
        "summary": {
            "displayed_references": sum(node.get("relation") == "reference" for node in nodes),
            "total_references": len(focus.get("referenced_works") or []),
            "displayed_citations": sum(node.get("relation") == "citation" for node in nodes),
            "total_citations": int(focus.get("cited_by_count") or 0),
            "limit_per_direction": limit,
        },
    }


def _local_citation_graph(paper: dict[str, Any], warning: str | None = None) -> dict[str, Any]:
    focus_id = f"local:{paper['id']}"
    nodes = [{
        "id": focus_id, "title": paper.get("title") or "Untitled", "year": str(paper.get("published_at") or "")[:4] or None,
        "authors": paper.get("authors") or [], "doi": paper.get("doi") or "", "url": paper.get("url") or "",
        "publication": paper.get("publication") or "", "abstract": paper.get("abstract") or "", "cited_by_count": 0,
        "relation": "focus", "openalex_id": paper.get("openalex_id") or "", "origin": paper.get("origin") or "manual",
        "tags": paper.get("tags") or [], "metadata": paper.get("metadata") or {}, "paper_id": paper.get("id"), "sources": ["local"],
    }]
    edges = []
    state = store.read()
    papers = {item["id"]: item for item in state["papers"]}
    for citation in state.get("citations", []):
        if paper["id"] not in {citation.get("source_id"), citation.get("target_id")}:
            continue
        other_id = citation["target_id"] if citation["source_id"] == paper["id"] else citation["source_id"]
        other = papers.get(other_id)
        if not other:
            continue
        node_id = f"local:{other_id}"
        relation = "reference" if citation["source_id"] == paper["id"] else "citation"
        nodes.append({
            "id": node_id, "title": other.get("title") or "Untitled", "year": str(other.get("published_at") or "")[:4] or None,
            "authors": other.get("authors") or [], "doi": other.get("doi") or "", "url": other.get("url") or "",
            "publication": other.get("publication") or "", "abstract": other.get("abstract") or "", "cited_by_count": 0,
            "relation": relation, "openalex_id": other.get("openalex_id") or "", "origin": other.get("origin") or "manual",
            "tags": other.get("tags") or [], "metadata": other.get("metadata") or {}, "paper_id": other_id, "sources": ["local"],
        })
        edges.append({"source": f"local:{citation['source_id']}", "target": f"local:{citation['target_id']}", "relation": "cites"})
    displayed_references = sum(node.get("relation") == "reference" for node in nodes)
    displayed_citations = sum(node.get("relation") == "citation" for node in nodes)
    return {
        "focus": focus_id,
        "nodes": nodes,
        "edges": edges,
        "warning": warning,
        "summary": {
            "displayed_references": displayed_references,
            "total_references": displayed_references,
            "displayed_citations": displayed_citations,
            "total_citations": displayed_citations,
            "limit_per_direction": max(displayed_references, displayed_citations),
        },
    }


def _identity(node: dict[str, Any]) -> str:
    doi = library.normalized_doi(node.get("doi"))
    if doi:
        return f"doi:{doi}"
    metadata = node.get("metadata") or {}
    if metadata.get("arxiv_id"):
        return f"arxiv:{str(metadata['arxiv_id']).casefold()}"
    title = " ".join(re.findall(r"\w+", str(node.get("title") or "").casefold()))
    return f"title:{title}:{node.get('year') or ''}" if title else f"id:{node.get('id')}"


def _merge_node(target: dict[str, Any], incoming: dict[str, Any]) -> None:
    if incoming.get("title") and (not target.get("title") or target.get("title") == target.get("doi") or target.get("title") == "Untitled"):
        target["title"] = incoming["title"]
    for field in ("title", "year", "authors", "doi", "url", "publication", "abstract", "pdf_url", "openalex_id", "paper_id"):
        if not target.get(field) and incoming.get(field):
            target[field] = incoming[field]
    target["cited_by_count"] = max(int(target.get("cited_by_count") or 0), int(incoming.get("cited_by_count") or 0))
    target["sources"] = sorted(set(target.get("sources") or []) | set(incoming.get("sources") or []))
    target["referenced_works"] = sorted(set(target.get("referenced_works") or []) | set(incoming.get("referenced_works") or []))
    target["metadata"] = {**(incoming.get("metadata") or {}), **(target.get("metadata") or {})}


def _merge_external_graph(base: dict[str, Any], additions: list[dict[str, Any]], errors: dict[str, str], limit: int) -> dict[str, Any]:
    base_focus = next((node for node in base["nodes"] if node["id"] == base["focus"]), base["nodes"][0])
    base_focus.setdefault("sources", ["openalex"] if base_focus.get("origin") == "openalex" else ["local"])
    candidates: dict[str, dict[str, Any]] = {}
    aliases = {base_focus["id"]: base_focus["id"]}
    root_edges = []

    def add(node: dict[str, Any], relation: str) -> None:
        node = {**node, "relation": relation}
        key = _identity(node)
        if key == _identity(base_focus):
            aliases[node["id"]] = base_focus["id"]
            _merge_node(base_focus, node)
            return
        if key in candidates:
            _merge_node(candidates[key], node)
        else:
            candidates[key] = node
        canonical_id = candidates[key]["id"]
        aliases[node["id"]] = canonical_id
        root_edges.append({"source": canonical_id if relation == "citation" else base_focus["id"],
                           "target": base_focus["id"] if relation == "citation" else canonical_id, "relation": "cites"})

    for node in base["nodes"]:
        if node["id"] != base["focus"]:
            add(node, node.get("relation") or "reference")
    counts = {
        "references": [int((base.get("summary") or {}).get("total_references") or 0)],
        "citations": [int((base.get("summary") or {}).get("total_citations") or 0)],
    }
    providers = set(base_focus.get("sources") or [])
    for result in additions:
        providers.add(result["source"])
        if result.get("focus"):
            _merge_node(base_focus, result["focus"])
        for relation in ("references", "citations"):
            counts[relation].append(int((result.get("counts") or {}).get(relation) or 0))
            singular = "reference" if relation == "references" else "citation"
            for node in result.get(relation) or []:
                add(node, singular)

    local_by_doi = {library.normalized_doi(item.get("doi")): item["id"] for item in store.list("papers") if library.normalized_doi(item.get("doi"))}
    for node in candidates.values():
        node["paper_id"] = node.get("paper_id") or local_by_doi.get(library.normalized_doi(node.get("doi")))
    ranking = lambda node: (-len(node.get("sources") or []), -int(node.get("cited_by_count") or 0), -(int(node.get("year") or 0) if str(node.get("year") or "").isdigit() else 0), str(node.get("title") or ""))
    all_references = sorted((node for node in candidates.values() if node["relation"] == "reference"), key=ranking)
    all_citations = sorted((node for node in candidates.values() if node["relation"] == "citation"), key=ranking)
    references = all_references[:limit]
    citations = all_citations[:limit]
    nodes = [base_focus, *references, *citations]
    # Include the whole catalog so pagination and filters retain all known links.
    catalog_nodes = [base_focus, *all_references, *all_citations]
    for node in catalog_nodes:
        if node.get("openalex_id"):
            aliases[node["openalex_id"]] = node["id"]
    known = {node["id"] for node in catalog_nodes}
    edges = []
    seen_edges = set()

    def connect(source, target):
        source, target = aliases.get(source, source), aliases.get(target, target)
        if source in known and target in known and source != target and (source, target) not in seen_edges:
            seen_edges.add((source, target))
            edges.append({"source": source, "target": target, "relation": "cites"})

    for edge in [*root_edges, *(base.get("edges") or [])]:
        connect(edge["source"], edge["target"])
    for node in catalog_nodes:
        for target in node.get("referenced_works") or []:
            connect(node["id"], target)
    local_ids = {node["paper_id"]: node["id"] for node in catalog_nodes if node.get("paper_id")}
    for edge in store.list("citations"):
        connect(local_ids.get(edge.get("source_id")), local_ids.get(edge.get("target_id")))
    return {
        "focus": base_focus["id"], "nodes": nodes, "edges": edges, "catalog": [*all_references, *all_citations],
        "providers": sorted(providers), "provider_errors": errors,
        "warning": base.get("warning"),
        "summary": {
            "displayed_references": len(references), "total_references": max(counts["references"], default=0),
            "displayed_citations": len(citations), "total_citations": max(counts["citations"], default=0),
            "limit_per_direction": limit,
        },
    }


def _complete_pack_references(base: dict[str, Any], additions: list[dict[str, Any]]) -> None:
    """Resolve provider-only articles in batches, retaining their full bibliography."""
    nodes = [*base["nodes"], *(node for result in additions for kind in ("references", "citations") for node in result.get(kind, []))]
    missing: dict[str, list[dict[str, Any]]] = {}
    for node in nodes:
        doi = library.normalized_doi(node.get("doi"))
        if doi and "referenced_works" not in node:
            missing.setdefault(doi, []).append(node)
    identifiers = list(missing)
    for start in range(0, len(identifiers), 50):
        query = urlencode({"filter": f"doi:{'|'.join(identifiers[start:start + 50])}", "per-page": 50})
        for work in _request("openalex", f"/works?{query}").get("results") or []:
            for node in missing.get(library.normalized_doi(work.get("doi")), []):
                _merge_node(node, _node(work))


def external_citation_graph(paper: dict[str, Any], limit: int = 24, persist: bool = True, progress: Callable | None = None) -> dict[str, Any]:
    collection_limit = max(limit, 60)
    openalex_error = None
    try:
        if source_settings.enabled("openalex"):
            base = _remote_citation_graph(paper, collection_limit, persist=persist, **({"progress": progress} if progress else {}))
        else:
            if progress:
                for step in ("resolve", "references", "citations"):
                    progress(step, "skipped")
            base = _local_citation_graph(paper, "") if paper.get("id") else {
                "focus": "external:focus", "nodes": [{**paper, "id": "external:focus", "relation": "focus", "sources": []}],
                "edges": [], "summary": {},
            }
    except HTTPException as error:
        openalex_error = str(error.detail)
        if progress:
            progress("openalex", "warning")
        if paper.get("id"):
            base = _local_citation_graph(paper, openalex_error)
        else:
            focus_id = str(paper.get("id") or paper.get("openalex_id") or f"external:{abs(hash(str(paper)))}")
            focus = {**paper, "id": focus_id, "relation": "focus", "sources": []}
            base = {"focus": focus_id, "nodes": [focus], "edges": [], "summary": {}}
    additions, errors = citation_providers.collect(paper, collection_limit, **({"progress": progress} if progress else {}))
    errors = {**base.get("provider_errors", {}), **errors}
    if openalex_error:
        errors["openalex"] = openalex_error
    if progress:
        progress("connections", "running")
    if source_settings.enabled("openalex") and not openalex_error:
        try:
            _complete_pack_references(base, additions)
        except HTTPException as error:
            errors["pack_connections"] = str(error.detail)
        if progress:
            progress("connections", "warning" if "pack_connections" in errors else "done")
    elif progress:
        progress("connections", "skipped")
    if progress:
        progress("merge", "running")
    result = _merge_external_graph(base, additions, errors, limit)
    if progress:
        progress("merge", "done")
    return result


def citation_graph(paper: dict[str, Any], limit: int = 24) -> dict[str, Any]:
    return external_citation_graph(paper, limit, persist=True)


def expand_graph(values: dict[str, Any], limit: int = 24) -> dict[str, Any]:
    paper = {key: values.get(key) for key in ("title", "authors", "abstract", "publication", "published_at", "doi", "url", "tags", "metadata", "openalex_id", "origin")}
    paper["year"] = values.get("year")
    return external_citation_graph(paper, limit, persist=False)


def import_node(source_paper_id: int | None, values: dict[str, Any]) -> dict[str, Any]:
    values = enrich_node(values, discover_pdf=True)
    clean = {key: values.get(key) for key in ("title", "authors", "abstract", "publication", "published_at", "doi", "url", "tags", "metadata", "openalex_id", "origin")}
    clean = {key: value for key, value in clean.items() if value is not None}
    existing = library.find_duplicate(clean)
    stream = None
    pdf_error = None
    candidates = list(dict.fromkeys(filter(None, [values.get("pdf_url"), *(values.get("pdf_urls") or [])])))
    if not (existing and existing.get("file_path")):
        for url in candidates:
            try:
                stream = download_pdf(url)
                pdf_error = None
                break
            except HTTPException as error:
                pdf_error = str(error.detail)
    try:
        paper, created = library.import_paper(clean, stream)
    finally:
        if stream:
            stream.close()
    if source_paper_id and values.get("relation") in {"citation", "reference"} and paper["id"] != source_paper_id:
        with store.transaction() as state:
            source_id, target_id = (paper["id"], source_paper_id) if values.get("relation") == "citation" else (source_paper_id, paper["id"])
            exists = any(item.get("source_id") == source_id and item.get("target_id") == target_id for item in state["citations"])
            if not exists:
                timestamp = now()
                state["citations"].append({"id": store.next_id(state, "citations"), "source_id": source_id, "target_id": target_id, "external_source_id": None, "external_target_id": values.get("openalex_id"), "created_at": timestamp, "updated_at": timestamp})
    return {"paper": paper, "created": created, "pdf": {"found": bool(candidates), "imported": bool(paper.get("file_path")), "error": pdf_error}}



def enrich_node(values: dict[str, Any], discover_pdf: bool = False) -> dict[str, Any]:
    result = dict(values)
    pdf_urls = list(filter(None, [values.get("pdf_url")]))
    errors = []
    identifier = values.get("openalex_id") or values.get("doi")
    if source_settings.enabled("openalex") and identifier and (discover_pdf or not result.get("abstract") or not result.get("pdf_url")):
        try:
            work = _work(str(identifier), str(values.get("title") or ""))
            _merge_node(result, _node(work))
            pdf_urls.extend(loc["pdf_url"] for loc in [work.get("best_oa_location") or {}, work.get("primary_location") or {}, *(work.get("locations") or [])] if loc.get("pdf_url"))
        except HTTPException as error:
            errors.append(str(error.detail))
    if not result.get("abstract") or not result.get("pdf_url"):
        identifier = (values.get("metadata") or {}).get("arxiv_id") or values.get("doi") or values.get("url")
        if identifier:
            try:
                extra = importers.preview(str(identifier))
                _merge_node(result, extra)
                if extra.get("pdf_url"):
                    pdf_urls.append(extra["pdf_url"])
            except HTTPException as error:
                errors.append(str(error.detail))
    if source_settings.enabled("europe_pmc") and not result.get("abstract") and values.get("doi"):
        try:
            payload = _request("europe_pmc", f"/search?{urlencode({'query': 'DOI:' + str(values['doi']), 'format': 'json', 'resultType': 'core', 'pageSize': 1})}", timeout=8)
            records = (payload.get("resultList") or {}).get("result") or []
            if records:
                result["abstract"] = re.sub(r"<[^>]+>", " ", records[0].get("abstractText") or "").strip()
        except HTTPException as error:
            errors.append(str(error.detail))
    if source_settings.enabled("semantic_scholar") and not result.get("abstract"):
        doi = values.get("doi")
        sid = (values.get("metadata") or {}).get("semantic_scholar_id")
        if sid or doi:
            try:
                identifier = sid or f"DOI:{doi}"
                extra = _request("semantic_scholar", f"/paper/{quote(str(identifier), safe=':')}?fields=abstract,openAccessPdf", timeout=8)
                result["abstract"] = extra.get("abstract") or ""
                pdf = (extra.get("openAccessPdf") or {}).get("url")
                if pdf:
                    pdf_urls.append(pdf)
                    result["pdf_url"] = result.get("pdf_url") or pdf
            except HTTPException as error:
                errors.append(str(error.detail))
    result["pdf_urls"] = list(dict.fromkeys(pdf_urls))
    result["lookup_errors"] = errors
    return result

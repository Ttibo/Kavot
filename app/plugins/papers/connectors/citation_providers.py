from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable
from urllib.parse import quote, urlencode

from fastapi import HTTPException

from app.plugins.papers.connectors.http import request_json
from app.plugins.papers.connectors import source_settings


def _request(source: str, path: str, **kwargs):
    return source_settings.request(source, path, request_json, **kwargs)




def _doi(value: Any) -> str:
    text = str(value or "").strip()
    text = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:)", "", text, flags=re.IGNORECASE)
    match = re.search(r"10\.\d{4,9}/[-._;()/:A-Z0-9]+", text, flags=re.IGNORECASE)
    return match.group(0).rstrip(".,;)") if match else ""


def _arxiv_id(paper: dict[str, Any]) -> str:
    metadata = paper.get("metadata") or {}
    if metadata.get("arxiv_id"):
        return re.sub(r"v\d+$", "", str(metadata["arxiv_id"]), flags=re.IGNORECASE)
    value = " ".join(str(paper.get(key) or "") for key in ("doi", "url"))
    match = re.search(r"(?:arxiv[.:/])?(\d{4}\.\d{4,5})(?:v\d+)?", value, flags=re.IGNORECASE)
    return match.group(1) if match else ""


def _base_node(**values: Any) -> dict[str, Any]:
    return {
        "id": values.get("id") or "",
        "title": values.get("title") or "Untitled",
        "year": values.get("year"),
        "authors": values.get("authors") or [],
        "doi": _doi(values.get("doi")),
        "url": values.get("url") or "",
        "publication": values.get("publication") or "",
        "abstract": values.get("abstract") or "",
        "pdf_url": values.get("pdf_url"),
        "cited_by_count": int(values.get("cited_by_count") or 0),
        "openalex_id": values.get("openalex_id") or "",
        "origin": values.get("origin") or "external",
        "tags": [],
        "metadata": values.get("metadata") or {},
        "sources": [values["source"]] if values.get("source") else [],
    }


def _result(source: str, focus: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"source": source, "focus": focus, "references": [], "citations": [], "counts": {}}


def semantic_scholar(paper: dict[str, Any], limit: int) -> dict[str, Any]:
    arxiv_id = _arxiv_id(paper)
    doi = _doi(paper.get("doi"))
    identifier = f"ARXIV:{arxiv_id}" if arxiv_id else f"DOI:{doi}" if doi else ""
    if not identifier:
        raise HTTPException(status_code=422, detail="Semantic Scholar needs a DOI or arXiv identifier")
    fields = "paperId,title,year,authors,venue,abstract,citationCount,referenceCount,externalIds,url,openAccessPdf"
    encoded = quote(identifier, safe=":")
    focus_raw = _request("semantic_scholar", f"/paper/{encoded}?{urlencode({'fields': fields})}", timeout=12)

    def node(raw: dict[str, Any]) -> dict[str, Any]:
        external = raw.get("externalIds") or {}
        return _base_node(
            id=f"s2:{raw.get('paperId')}", title=raw.get("title"), year=raw.get("year"),
            authors=[author.get("name") for author in raw.get("authors") or [] if author.get("name")],
            pdf_url=(raw.get("openAccessPdf") or {}).get("url"), doi=external.get("DOI"), url=raw.get("url"), publication=raw.get("venue"), abstract=raw.get("abstract"),
            cited_by_count=raw.get("citationCount"), origin="semantic_scholar", source="semantic_scholar",
            metadata={"semantic_scholar_id": raw.get("paperId"), "arxiv_id": external.get("ArXiv")},
        )

    result = _result("semantic_scholar", node(focus_raw))
    result["counts"] = {"citations": int(focus_raw.get("citationCount") or 0), "references": int(focus_raw.get("referenceCount") or 0)}
    related_fields = "paperId,title,year,authors,venue,abstract,citationCount,externalIds,url,openAccessPdf"
    for relation, wrapper in (("references", "citedPaper"), ("citations", "citingPaper")):
        payload = _request("semantic_scholar",
            f"/paper/{quote(str(focus_raw['paperId']), safe='')}/{relation}?{urlencode({'fields': related_fields, 'limit': limit})}",
            timeout=12,
        )
        result[relation] = [node(item.get(wrapper) or {}) for item in payload.get("data") or [] if (item.get(wrapper) or {}).get("paperId")]
    return result


def _pid(value: Any, prefix: str) -> str:
    match = re.search(rf"(?:^|\s){re.escape(prefix)}:([^\s;]+)", str(value or ""), flags=re.IGNORECASE)
    return match.group(1) if match else ""


def open_citations(paper: dict[str, Any], limit: int) -> dict[str, Any]:
    doi = _doi(paper.get("doi"))
    if not doi:
        raise HTTPException(status_code=422, detail="OpenCitations needs a DOI")
    pid = f"doi:{doi.casefold()}"
    result = _result("open_citations")
    counts: dict[str, int] = {}
    for relation, endpoint in (("citations", "citation-count"), ("references", "reference-count")):
        payload = _request("open_citations", f"/{endpoint}/{quote(pid, safe=':/.()')}", timeout=12)
        counts[relation] = int((payload[0] if payload else {}).get("count") or 0)
    result["counts"] = counts
    # These endpoints are unpaginated. Avoid downloading enormous result sets.
    for relation in ("references", "citations"):
        if counts[relation] > 250:
            continue
        payload = _request("open_citations", f"/{relation}/{quote(pid, safe=':/.()')}", timeout=12)
        field = "cited" if relation == "references" else "citing"
        nodes = []
        for row in payload[:limit]:
            related_doi = _pid(row.get(field), "doi")
            if not related_doi:
                continue
            nodes.append(_base_node(
                id=f"doi:{related_doi.casefold()}", title=related_doi, doi=related_doi,
                year=str(row.get("creation") or "")[:4] or None, url=f"https://doi.org/{related_doi}",
                origin="open_citations", source="open_citations", metadata={"oci": row.get("oci")},
            ))
        result[relation] = nodes
    return result


def crossref(paper: dict[str, Any], limit: int) -> dict[str, Any]:
    doi = _doi(paper.get("doi"))
    if not doi:
        raise HTTPException(status_code=422, detail="Crossref needs a DOI")
    try:
        payload = _request("crossref", f"/works/{quote(doi, safe='')}", timeout=12)
        work = payload.get("message") or {}
    except HTTPException as error:
        title = str(paper.get("title") or "").strip()
        if not title:
            raise
        payload = _request("crossref", f"/works?{urlencode({'query.title': title, 'rows': 10})}", timeout=12)
        expected = " ".join(re.findall(r"\w+", title.casefold()))
        matches = [item for item in (payload.get("message") or {}).get("items") or [] if " ".join(re.findall(r"\w+", " ".join(item.get("title") or []).casefold())) == expected]
        if not matches:
            raise error
        work = max(matches, key=lambda item: int(item.get("is-referenced-by-count") or 0))
    result = _result("crossref")
    result["counts"] = {
        "citations": int(work.get("is-referenced-by-count") or 0),
        "references": int(work.get("references-count") or len(work.get("reference") or [])),
    }
    nodes = []
    for index, reference in enumerate((work.get("reference") or [])[:limit]):
        ref_doi = _doi(reference.get("DOI"))
        title = reference.get("article-title") or reference.get("unstructured") or ref_doi or f"Reference {index + 1}"
        nodes.append(_base_node(
            id=f"doi:{ref_doi.casefold()}" if ref_doi else f"crossref-ref:{index}:{abs(hash(str(reference)))}",
            title=title, year=reference.get("year"), authors=[reference["author"]] if reference.get("author") else [],
            doi=ref_doi, url=f"https://doi.org/{ref_doi}" if ref_doi else "", origin="crossref", source="crossref",
        ))
    result["references"] = nodes
    return result


def europe_pmc(paper: dict[str, Any], limit: int) -> dict[str, Any]:
    doi = _doi(paper.get("doi"))
    if not doi:
        raise HTTPException(status_code=422, detail="Europe PMC needs a DOI")
    search = _request("europe_pmc", f"/search?{urlencode({'query': f'DOI:{doi}', 'format': 'json', 'pageSize': 3})}", timeout=12)
    matches = (search.get("resultList") or {}).get("result") or []
    if not matches:
        raise HTTPException(status_code=404, detail="Europe PMC has no matching record")
    focus_raw = matches[0]
    source, record_id = focus_raw.get("source"), focus_raw.get("id")

    def node(raw: dict[str, Any], fallback_id: str = "") -> dict[str, Any]:
        raw_doi = _doi(raw.get("doi"))
        rid = raw.get("id") or raw.get("pmid") or fallback_id
        return _base_node(
            id=f"doi:{raw_doi.casefold()}" if raw_doi else f"epmc:{raw.get('source') or source}:{rid}",
            title=raw.get("title"), year=raw.get("pubYear"),
            authors=[part.strip() for part in str(raw.get("authorString") or "").split(",") if part.strip()],
            doi=raw_doi, url=f"https://europepmc.org/article/{raw.get('source') or source}/{rid}",
            publication=raw.get("journalTitle") or raw.get("journalAbbreviation"), cited_by_count=raw.get("citedByCount"),
            origin="europe_pmc", source="europe_pmc", metadata={"pmid": raw.get("pmid") or rid},
        )

    result = _result("europe_pmc", node(focus_raw, str(record_id)))
    result["counts"] = {"citations": int(focus_raw.get("citedByCount") or 0), "references": 0}
    for relation, list_key, item_key in (("references", "referenceList", "reference"), ("citations", "citationList", "citation")):
        payload = _request("europe_pmc",
            f"/{quote(str(source), safe='')}/{quote(str(record_id), safe='')}/{relation}?{urlencode({'format': 'json', 'pageSize': limit})}",
            timeout=12,
        )
        items = (payload.get(list_key) or {}).get(item_key) or []
        result[relation] = [node(item, str(index)) for index, item in enumerate(items[:limit])]
        if relation == "references":
            result["counts"]["references"] = int(payload.get("hitCount") or len(items))
    return result


PROVIDERS: dict[str, Callable[[dict[str, Any], int], dict[str, Any]]] = {
    "semantic_scholar": semantic_scholar,
    "open_citations": open_citations,
    "crossref": crossref,
    "europe_pmc": europe_pmc,
}


def collect(paper: dict[str, Any], limit: int, progress: Callable | None = None) -> tuple[list[dict[str, Any]], dict[str, str]]:
    results: list[dict[str, Any]] = []
    errors: dict[str, str] = {}
    active = {name: provider for name, provider in PROVIDERS.items() if source_settings.enabled(name)}
    if progress:
        for name in PROVIDERS:
            progress(name, "running" if name in active else "skipped")
    if not active:
        return results, errors
    with ThreadPoolExecutor(max_workers=len(active)) as executor:
        futures = {executor.submit(provider, paper, limit): name for name, provider in active.items()}
        for future in as_completed(futures):
            name = futures[future]
            try:
                results.append(future.result())
                if progress:
                    progress(name, "done")
            except HTTPException as error:
                errors[name] = str(error.detail)
            except Exception:
                errors[name] = "Unexpected provider response"
            if progress and name in errors:
                progress(name, "warning")
    return results, errors

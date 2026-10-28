from __future__ import annotations

import html
import re
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from typing import Any
from urllib.parse import quote, urlparse

from fastapi import HTTPException

from app.plugins.papers.connectors.http import request_bytes, request_json
from app.plugins.papers.connectors import source_settings


DOI_RE = re.compile(r"10\.\d{4,9}/[-._;()/:A-Z0-9]+", re.IGNORECASE)
ARXIV_RE = re.compile(r"(?:arxiv\.org/(?:abs|pdf)/|arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+/\d{7}(?:v\d+)?)", re.IGNORECASE)


def _clean_doi(value: str) -> str | None:
    match = DOI_RE.search(value.strip())
    return match.group(0).rstrip(".,;)") if match else None


def crossref(doi: str) -> dict[str, Any]:
    payload = source_settings.request("crossref", f"/works/{quote(doi, safe='')}", request_json)
    item = payload.get("message") or {}
    title = " ".join(item.get("title") or []).strip()
    if not title:
        raise HTTPException(status_code=404, detail="Crossref did not return a title for this DOI")
    date_parts = ((item.get("published-print") or item.get("published-online") or item.get("issued") or {}).get("date-parts") or [[]])[0]
    published = "-".join(str(part).zfill(2) if index else str(part) for index, part in enumerate(date_parts))
    authors = [" ".join(filter(None, [author.get("given"), author.get("family")])) for author in item.get("author") or []]
    abstract = re.sub(r"<[^>]+>", " ", str(item.get("abstract") or ""))
    pdf_url = next((str(link.get("URL")) for link in item.get("link") or [] if str(link.get("content-type") or "").casefold() == "application/pdf" and link.get("URL")), "")
    if not pdf_url:
        pdf_url = _openalex_pdf(str(item.get("DOI") or doi))
    return {
        "title": html.unescape(title), "authors": authors, "abstract": html.unescape(re.sub(r"\s+", " ", abstract)).strip(),
        "publication": " ".join(item.get("container-title") or []), "published_at": published,
        "doi": str(item.get("DOI") or doi), "url": str(item.get("URL") or f"https://doi.org/{doi}"),
        "tags": [], "metadata": {"crossref_type": item.get("type"), "publisher": item.get("publisher")}, "origin": "crossref", "pdf_url": pdf_url or None,
    }


def _openalex_pdf(doi: str) -> str:
    if not doi or not source_settings.enabled("openalex"):
        return ""
    try:
        work = source_settings.request("openalex", f"/works/{quote(f'https://doi.org/{doi}', safe=':/()')}", request_json)
    except HTTPException:
        return ""
    locations = [work.get("best_oa_location") or {}, work.get("primary_location") or {}, *(work.get("locations") or [])]
    return next((str(location.get("pdf_url")) for location in locations if location.get("pdf_url")), "")


def arxiv(identifier: str) -> dict[str, Any]:
    match = ARXIV_RE.search(identifier)
    if not match:
        raise HTTPException(status_code=422, detail="Invalid arXiv identifier")
    arxiv_id = match.group(1)
    canonical_arxiv_id = re.sub(r"v\d+$", "", arxiv_id, flags=re.IGNORECASE)
    body, _ = source_settings.request("arxiv", f"/query?id_list={quote(arxiv_id)}", request_bytes, headers={"Accept": "application/atom+xml"})
    root = ET.fromstring(body)
    ns = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
    entry = root.find("a:entry", ns)
    if entry is None:
        raise HTTPException(status_code=404, detail="arXiv record not found")
    text = lambda name: " ".join((entry.findtext(name, default="", namespaces=ns)).split())
    publisher_doi = text("arxiv:doi")
    arxiv_doi = f"10.48550/arXiv.{canonical_arxiv_id}"
    return {
        "title": text("a:title"), "authors": [" ".join((node.findtext("a:name", default="", namespaces=ns)).split()) for node in entry.findall("a:author", ns)],
        "abstract": text("a:summary"), "publication": text("arxiv:journal_ref") or "arXiv", "published_at": text("a:published")[:10],
        "doi": publisher_doi or arxiv_doi, "url": f"https://arxiv.org/abs/{canonical_arxiv_id}",
        "tags": [node.attrib.get("term", "") for node in entry.findall("a:category", ns) if node.attrib.get("term")],
        "metadata": {"arxiv_id": canonical_arxiv_id, "arxiv_doi": arxiv_doi, "publisher_doi": publisher_doi or None},
        "origin": "arxiv", "pdf_url": f"https://arxiv.org/pdf/{canonical_arxiv_id}",
    }


class _MetadataParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.values: dict[str, list[str]] = {}
    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.casefold() != "meta": return
        data = {key.casefold(): value or "" for key, value in attrs}
        name = data.get("name") or data.get("property")
        if name and data.get("content"):
            self.values.setdefault(name.casefold(), []).append(data["content"].strip())


def webpage(url: str) -> dict[str, Any]:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=422, detail="Enter an HTTP(S) article URL")
    body, headers = request_bytes(url, headers={"Accept": "text/html,application/xhtml+xml"})
    if "html" not in headers.get("Content-Type", "text/html").casefold():
        raise HTTPException(status_code=422, detail="The URL does not point to an HTML article page")
    parser = _MetadataParser(); parser.feed(body[:2_000_000].decode("utf-8", errors="replace"))
    one = lambda *keys: next((parser.values[key][0] for key in keys if parser.values.get(key)), "")
    doi = _clean_doi(one("citation_doi", "dc.identifier", "dc.identifier.doi")) or ""
    if doi:
        try:
            result = crossref(doi)
            result["pdf_url"] = result.get("pdf_url") or one("citation_pdf_url") or None
            return result
        except HTTPException: pass
    title = one("citation_title", "dc.title", "og:title", "twitter:title")
    if not title:
        raise HTTPException(status_code=422, detail="No scholarly metadata was found on this page")
    return {"title": title, "authors": parser.values.get("citation_author", []), "abstract": one("citation_abstract", "dc.description", "description"), "publication": one("citation_journal_title", "citation_conference_title"), "published_at": one("citation_publication_date", "citation_date"), "doi": doi, "url": url, "tags": [], "metadata": {}, "origin": "url", "pdf_url": one("citation_pdf_url") or None}


def preview(identifier: str) -> dict[str, Any]:
    value = identifier.strip()
    if ARXIV_RE.search(value) and ("arxiv" in value.casefold() or not DOI_RE.search(value)):
        return arxiv(value)
    doi = _clean_doi(value)
    if doi:
        return crossref(doi)
    if value.startswith(("http://", "https://")):
        return webpage(value)
    raise HTTPException(status_code=422, detail="Enter a DOI, an arXiv identifier, or an article URL")

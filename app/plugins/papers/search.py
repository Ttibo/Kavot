"""Search documents of the Papers plugin: the extracted pages of each article's PDF.

Article metadata (title, abstract, authors…) is indexed by the core from the
collection's search_fields; this source adds the full text, page by page.
"""
from __future__ import annotations

from typing import Any, Iterator

from app.core.search.documents import Document, Unchanged, passage_documents, projects_of, ref

PAGE_CHARS = 4000


def documents(state: dict[str, Any], known: dict[str, str]) -> Iterator[Document | Unchanged]:
    from app.core.workspace import asset_metadata
    from app.plugins.papers.library import local_pdf_path
    for paper in state.get("papers", []):
        path = local_pdf_path(paper)
        if not path:
            continue
        try:
            metadata = asset_metadata.metadata_path(path)
            stat = metadata.stat()
        except (OSError, ValueError):
            continue
        group = ref("articles", paper["id"]) + "/pdf"
        version = f"{stat.st_mtime_ns}:{stat.st_size}:{projects_of(paper)}"
        if known.get(group) == version:
            yield Unchanged(group)
            continue
        extraction = asset_metadata.read(path) or {}
        pages = [(f"page-{page['page']}", str(page.get("text", ""))[:PAGE_CHARS]) for page in extraction.get("pages", [])
                 if str(page.get("text", "")).strip()]
        if pages:
            yield from passage_documents("articles", paper["id"], paper.get("title") or "", pages, version=version,
                                         project_ids=projects_of(paper), updated_at=paper.get("updated_at", ""), group=group)


def article_card(card: dict[str, Any], paper: dict[str, Any], index) -> None:
    """Workspace map card of an article: bibliographic facts, abstract and the sections of its PDF."""
    from app.core.digest.cards import pdf_outline
    from app.core.search.text import first_sentences
    from app.plugins.papers.library import local_pdf_path
    card["kind"] = "article"
    authors = paper.get("authors") or []
    facts = {"authors": authors[:3] + (["et al."] if len(authors) > 3 else []),
             "year": str(paper.get("published_at") or "")[:4], "publication": paper.get("publication"),
             "doi": paper.get("doi"), "status": paper.get("status"), "tags": paper.get("tags")}
    card["facts"] = {k: v for k, v in facts.items() if v}
    if paper.get("abstract"):
        card["gist"] = first_sentences(paper["abstract"], 240)
    item = index.item("articles", str(paper.get("id", ""))) or {"passages": []}
    pages = [p for p in item["passages"] if p["anchor"].startswith("page-")]
    outline, count = pdf_outline(local_pdf_path(paper), card["ref"])
    if pages:
        card["facts"]["pdf_pages"] = count or len(pages)
    card["outline"] = outline

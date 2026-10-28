from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any, BinaryIO

from fastapi import HTTPException

from app.core.kernel.config import settings
from app.core.kernel.files import atomic_write_json, prefixed_entry, safe_name
from app.core.workspace import asset_metadata
from app.core.records.repository import now, store


def paper_directory(paper: dict[str, Any]) -> Path:
    existing = prefixed_entry(settings.library_path, paper['id'])
    return existing or settings.library_path / f"{paper['id']}-{safe_name(paper['title'], 'article')}"


def local_pdf_path(paper: dict[str, Any]) -> Path | None:
    """Resolve synced attachments against this device's workspace first."""
    if not paper.get("file_path"):
        return None
    local = paper_directory(paper) / "paper.pdf"
    if local.is_file():
        return local
    # Preserve support for older attachments outside the managed library.
    original = Path(paper["file_path"])
    return original if original.is_file() else None


def paper_folder_ids(paper: dict[str, Any]) -> list[int]:
    return list(dict.fromkeys(value for value in [paper.get("folder_id"), *(paper.get("folder_ids") or [])] if value is not None))


def enrich(paper: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    path = local_pdf_path(paper)
    paper = {**paper, "file_path": str(path) if path else paper.get("file_path"),
             "extraction": asset_metadata.summary(path) if path else None}
    projects = [{"id": item["id"], "name": item["name"], "color": item["color"]} for item in state["projects"] if item["id"] in paper.get("project_ids", [])]
    topics = [item for item in state["topics"] if item["id"] in paper.get("topic_ids", [])]
    return {**paper, "projects": projects, "topics": topics, "note_count": sum(item.get("paper_id") == paper["id"] and not item.get("trashed_at") for item in state["notes"]), "reference_count": sum(item.get("paper_id") == paper["id"] for item in state["paper_references"])}


def list_papers(project_id: int | None = None, topic_id: int | None = None, paper_status: str | None = None, query: str | None = None) -> list[dict[str, Any]]:
    state = store.read()
    items = state["papers"]
    if project_id is not None:
        items = [item for item in items if project_id in item.get("project_ids", [])]
    if topic_id is not None:
        items = [item for item in items if topic_id in item.get("topic_ids", [])]
    if paper_status:
        items = [item for item in items if item.get("status") == paper_status]
    if query:
        needle = query.casefold()
        items = [item for item in items if needle in " ".join([item.get("title", ""), item.get("abstract", ""), *item.get("authors", []), *item.get("tags", [])]).casefold()]
    return [enrich(item, state) for item in sorted(items, key=lambda value: (value["created_at"], value["id"]), reverse=True)]


def create_paper(values: dict[str, Any], source: BinaryIO | None = None) -> dict[str, Any]:
    with store.transaction() as state:
        timestamp = now()
        paper = {"id": store.next_id(state, "papers"), "authors": [], "abstract": "", "publication": "", "published_at": "", "doi": "", "url": "", "status": "to_read", "tags": [], "metadata": {}, "project_ids": [], "topic_ids": [], "folder_id": None, "file_path": None, "zotero_key": None, "openalex_id": None, "origin": "manual", **values, "created_at": timestamp, "updated_at": timestamp}
        state["papers"].append(paper)
        root = paper_directory(paper)
        root.mkdir(parents=True, exist_ok=True)
        atomic_write_json(root / "metadata.kavot.json", paper)
        result = enrich(paper, state)
    if source:
        attach_pdf(result["id"], source)
    from app.core.workspace.documents import create_article_note
    create_article_note(result["id"])
    return enrich(store.find("papers", result["id"], "Article"), store.read())


def normalized_doi(value: str | None) -> str:
    value = (value or "").strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if value.startswith(prefix):
            value = value[len(prefix):]
    return value.strip()


def find_duplicate(values: dict[str, Any]) -> dict[str, Any] | None:
    doi = normalized_doi(values.get("doi"))
    zotero_key = values.get("zotero_key")
    openalex_id = str(values.get("openalex_id") or "").casefold()
    for paper in store.list("papers"):
        if zotero_key and paper.get("zotero_key") == zotero_key:
            return paper
        if doi and normalized_doi(paper.get("doi")) == doi:
            return paper
        if openalex_id and str(paper.get("openalex_id") or "").casefold() == openalex_id:
            return paper
    return None


def import_paper(values: dict[str, Any], source: BinaryIO | None = None) -> tuple[dict[str, Any], bool]:
    """Create an imported paper, or merge metadata into its existing match."""
    duplicate = find_duplicate(values)
    if not duplicate:
        return create_paper(values, source), True
    merged = {key: value for key, value in values.items() if value not in (None, "", [], {})}
    paper = update_paper(duplicate["id"], merged)
    if source and not paper.get("file_path"):
        paper = attach_pdf(paper["id"], source)
    return paper, False


def update_paper(paper_id: int, values: dict[str, Any]) -> dict[str, Any]:
    if "folder_id" in values and "folder_ids" not in values:
        current = store.find("papers", paper_id, "Article")
        if values["folder_id"] != current.get("folder_id"):
            values = {**values, "folder_ids": [values["folder_id"]] if values["folder_id"] is not None else []}
    paper = store.update("papers", paper_id, values, "Article")
    atomic_write_json(paper_directory(paper) / "metadata.kavot.json", paper)
    return enrich(paper, store.read())


def attach_pdf(paper_id: int, source: BinaryIO, *, extract: bool = True) -> dict[str, Any]:
    paper = store.find("papers", paper_id, "Article")
    root = paper_directory(paper)
    root.mkdir(parents=True, exist_ok=True)
    target = root / "paper.pdf"
    asset_metadata.save_upload(target, source, extract=extract)
    return update_paper(paper_id, {"file_path": str(target)})



def delete_paper(paper_id: int) -> None:
    paper = store.delete("papers", paper_id, "Article")
    root = paper_directory(paper)
    asset_metadata.remove(root)
    if root.is_dir():
        shutil.rmtree(root)
    with store.transaction() as state:
        state["notes"] = [item for item in state["notes"] if item.get("paper_id") != paper_id]
        state["paper_references"] = [item for item in state["paper_references"] if item.get("paper_id") != paper_id]
        state["citations"] = [item for item in state.get("citations", []) if item.get("source_id") != paper_id and item.get("target_id") != paper_id]


def pdf_path(paper_id: int) -> Path:
    paper = store.find("papers", paper_id, "Article")
    path = local_pdf_path(paper)
    if path is None:
        raise HTTPException(status_code=404, detail="No PDF is associated with this article")
    return path


def page_count(path: Path) -> int:
    tool = shutil.which("pdfinfo")
    if not tool:
        return 1
    result = subprocess.run([tool, str(path)], capture_output=True, text=True, timeout=20, check=False)
    for line in result.stdout.splitlines():
        if line.startswith("Pages:"):
            return int(line.split(":", 1)[1].strip())
    return 1


def render_page(paper_id: int, page: int) -> Path:
    source = pdf_path(paper_id)
    return render_pdf_page(source, page, source.parent / ".preview")


def render_pdf_page(source: Path, page: int, cache: Path) -> Path:
    if page < 1 or page > page_count(source):
        raise HTTPException(status_code=404, detail="PDF page not found")
    tool = shutil.which("pdftoppm")
    if not tool:
        raise HTTPException(status_code=503, detail="Local PDF renderer is unavailable")
    target = cache / f"page-{page:05d}.png"
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.is_file() or target.stat().st_mtime < source.stat().st_mtime:
        result = subprocess.run([tool, "-f", str(page), "-l", str(page), "-singlefile", "-png", "-r", "160", str(source), str(target.with_suffix(""))], capture_output=True, timeout=45, check=False)
        if result.returncode or not target.is_file():
            raise HTTPException(status_code=422, detail="PDF rendering failed")
    return target



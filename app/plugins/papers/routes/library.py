from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse

from app.plugins.papers.models import PaperFolderCreate, PaperFolderUpdate, PaperProjectsUpdate, PaperUpdate
from app.models.pdf_annotations import PdfAnnotation
from app.core.kernel.files import atomic_write_json
from app.plugins.papers import library
from app.core.records.repository import json_values, store


router = APIRouter(tags=["library"])


@router.get("/papers")
def papers(project_id: int | None = None, topic_id: int | None = None, status: str | None = None, q: str | None = None) -> list[dict[str, Any]]:
    return library.list_papers(project_id, topic_id, status, q)


def _json_list(value: str, label: str) -> list[Any]:
    try:
        result = json.loads(value or "[]")
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=422, detail=f"Invalid {label}") from error
    if not isinstance(result, list):
        raise HTTPException(status_code=422, detail=f"{label} must be a list")
    return result


@router.post("/papers", status_code=201)
def create_paper(
    title: str = Form(...), authors: str = Form("[]"), abstract: str = Form(""),
    publication: str = Form(""), published_at: str = Form(""), doi: str = Form(""),
    url: str = Form(""), reading_status: str = Form("to_read"), tags: str = Form("[]"),
    project_ids: str = Form("[]"), folder_id: int | None = Form(None), file: UploadFile | None = File(None),
) -> dict[str, Any]:
    if not title.strip():
        raise HTTPException(status_code=422, detail="The article title is required")
    values = {
        "title": title.strip(), "authors": _json_list(authors, "authors"), "abstract": abstract,
        "publication": publication, "published_at": published_at, "doi": doi, "url": url,
        "status": reading_status, "tags": _json_list(tags, "tags"),
        "project_ids": [int(value) for value in _json_list(project_ids, "project IDs")], "folder_id": folder_id,
    }
    return library.create_paper(values, file.file if file else None)


@router.get("/papers/{paper_id}")
def get_paper(paper_id: int) -> dict[str, Any]:
    state = store.read()
    return library.enrich(store.find("papers", paper_id, "Article"), state)


@router.patch("/papers/{paper_id}")
def update_paper(paper_id: int, payload: PaperUpdate) -> dict[str, Any]:
    return library.update_paper(paper_id, json_values(payload, exclude_unset=True))


@router.delete("/papers/{paper_id}", status_code=204)
def delete_paper(paper_id: int) -> Response:
    library.delete_paper(paper_id)
    return Response(status_code=204)


@router.get("/papers/{paper_id}/file")
def paper_file(paper_id: int) -> FileResponse:
    return FileResponse(library.pdf_path(paper_id), media_type="application/pdf", filename="paper.pdf")


@router.post("/papers/{paper_id}/file")
def upload_paper_file(paper_id: int, file: UploadFile = File(...)) -> dict[str, Any]:
    return library.attach_pdf(paper_id, file.file)




@router.get("/papers/{paper_id}/annotations")
def pdf_annotations(paper_id: int) -> list[dict[str, Any]]:
    return store.find("papers", paper_id, "Article").get("pdf_annotations", [])


@router.put("/papers/{paper_id}/annotations/{annotation_id}")
def save_pdf_annotation(paper_id: int, annotation_id: str, payload: PdfAnnotation) -> dict[str, Any]:
    if payload.id != annotation_id:
        raise HTTPException(422, "Annotation ID mismatch")
    if payload.page > library.page_count(library.pdf_path(paper_id)):
        raise HTTPException(422, "Page outside PDF")
    with store.transaction() as state:
        paper = next((p for p in state['papers'] if p['id'] == paper_id), None)
        if paper is None:
            raise HTTPException(404, "Article not found")
        annotation = payload.model_dump()
        paper['pdf_annotations'] = [a for a in paper.get('pdf_annotations', []) if a['id'] != annotation_id] + [annotation]
        atomic_write_json(library.paper_directory(paper) / 'metadata.kavot.json', paper)
    return annotation


@router.delete("/papers/{paper_id}/annotations/{annotation_id}", status_code=204)
def delete_pdf_annotation(paper_id: int, annotation_id: str) -> Response:
    with store.transaction() as state:
        paper = next((p for p in state['papers'] if p['id'] == paper_id), None)
        if paper is None:
            raise HTTPException(404, "Article not found")
        paper['pdf_annotations'] = [a for a in paper.get('pdf_annotations', []) if a['id'] != annotation_id]
        atomic_write_json(library.paper_directory(paper) / 'metadata.kavot.json', paper)
    return Response(status_code=204)





@router.post("/papers/{paper_id}/crops", status_code=201)
def save_crop(
    paper_id: int, page: int = Form(..., ge=1), note_id: int = Form(...), cursor: int = Form(..., ge=0),
    x: float = Form(..., ge=0, lt=1), y: float = Form(..., ge=0, lt=1), width: float = Form(..., gt=0, le=1), height: float = Form(..., gt=0, le=1),
) -> dict[str, Any]:
    from app.core.workspace.pdf_captures import insert_pdf_crop
    return insert_pdf_crop(library.render_page(paper_id, page), f'Capture PDF {paper_id} — page {page}.png', note_id, cursor, x, y, width, height)


@router.get("/papers/{paper_id}/captures/{filename}")
def capture(paper_id: int, filename: str) -> FileResponse:
    path = library.pdf_path(paper_id).parent / "assets" / Path(filename).name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Capture not found")
    return FileResponse(path, media_type="image/png")


@router.get("/papers/{paper_id}/references")
def references(paper_id: int) -> list[dict[str, Any]]:
    store.find("papers", paper_id, "Article")
    return [item for item in store.list("paper_references") if item.get("paper_id") == paper_id]


@router.put("/papers/{paper_id}/projects")
def replace_projects(paper_id: int, payload: PaperProjectsUpdate) -> dict[str, Any]:
    return library.update_paper(paper_id, {"project_ids": payload.project_ids})


@router.post("/papers/{paper_id}/projects/{project_id}")
def attach_project(paper_id: int, project_id: int) -> dict[str, Any]:
    store.find("projects", project_id, "Project")
    paper = store.find("papers", paper_id, "Article")
    return library.update_paper(paper_id, {"project_ids": list(dict.fromkeys([*paper.get("project_ids", []), project_id]))})


@router.delete("/papers/{paper_id}/projects/{project_id}")
def detach_project(paper_id: int, project_id: int) -> dict[str, Any]:
    paper = store.find("papers", paper_id, "Article")
    return library.update_paper(paper_id, {"project_ids": [value for value in paper.get("project_ids", []) if value != project_id]})


@router.get("/paper-folders")
def folders() -> list[dict[str, Any]]:
    state = store.read()
    counts = {item["id"]: sum(item["id"] in library.paper_folder_ids(paper) for paper in state["papers"]) for item in state["paper_folders"]}
    return [{**item, "paper_count": counts[item["id"]]} for item in sorted(state["paper_folders"], key=lambda value: value["name"].casefold())]


@router.post("/paper-folders", status_code=201)
def create_folder(payload: PaperFolderCreate) -> dict[str, Any]:
    return store.create("paper_folders", json_values(payload))


@router.patch("/paper-folders/{folder_id}")
def update_folder(folder_id: int, payload: PaperFolderUpdate) -> dict[str, Any]:
    return store.update("paper_folders", folder_id, json_values(payload, exclude_unset=True), "Library folder")


@router.delete("/paper-folders/{folder_id}", status_code=204)
def delete_folder(folder_id: int) -> Response:
    with store.transaction() as state:
        if not any(item["id"] == folder_id for item in state["paper_folders"]):
            raise HTTPException(status_code=404, detail="Library folder not found")
        descendants = {folder_id}
        while True:
            found = {item["id"] for item in state["paper_folders"] if item.get("parent_id") in descendants}
            if found <= descendants:
                break
            descendants.update(found)
        state["paper_folders"] = [item for item in state["paper_folders"] if item["id"] not in descendants]
        for paper in state["papers"]:
            paper["folder_ids"] = [value for value in library.paper_folder_ids(paper) if value not in descendants]
            if paper.get("folder_id") in descendants:
                paper["folder_id"] = next(iter(paper["folder_ids"]), None)
    return Response(status_code=204)

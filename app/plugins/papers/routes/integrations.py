from __future__ import annotations

import asyncio
import json
from threading import Event
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import StreamingResponse

from app.plugins.papers.models import CitationNodeDetailsRequest, CitationGraphExpandRequest, IdentifierImportRequest, PaperImportConfirm, ZoteroSettingsUpdate
from app.plugins.papers import library
from app.plugins.papers.connectors import graph, importers, zotero, source_settings
from app.plugins.papers.models import ScholarlySourcesUpdate
from app.plugins.papers.connectors.http import download_pdf
from app.core.records.repository import json_values, store


router = APIRouter(tags=["integrations"])


@router.get("/integrations/zotero")
def zotero_status() -> dict[str, Any]:
    return zotero.status()


@router.put("/integrations/zotero")
def configure_zotero(payload: ZoteroSettingsUpdate) -> dict[str, Any]:
    return zotero.configure(payload.api_key)


@router.post("/integrations/zotero/sync")
def synchronize_zotero(background: bool = False) -> dict[str, Any]:
    return zotero.start_sync() if background else zotero.synchronize()


@router.get("/integrations/zotero/sync")
def zotero_sync_status(response: Response) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return zotero.sync_status()



@router.get("/integrations/scholarly-sources")
def scholarly_sources() -> dict[str, Any]:
    return source_settings.status()


@router.put("/integrations/scholarly-sources")
def configure_scholarly_sources(payload: ScholarlySourcesUpdate) -> dict[str, Any]:
    return source_settings.configure([source.model_dump(exclude_none=True) for source in payload.sources])




@router.post("/library/import-preview")
def import_preview(payload: IdentifierImportRequest) -> dict[str, Any]:
    return importers.preview(payload.identifier)


@router.post("/library/import", status_code=201)
def confirm_import(payload: PaperImportConfirm) -> dict[str, Any]:
    values = json_values(payload)
    pdf_url = values.pop("pdf_url", None)
    values.pop("relation", None)
    existing = library.find_duplicate(values)
    stream = None
    pdf_error = None
    if pdf_url and not (existing and existing.get("file_path")):
        try:
            stream = download_pdf(pdf_url)
        except HTTPException as error:
            pdf_error = error.detail
    try:
        paper, created = library.import_paper(values, stream)
    finally:
        if stream:
            stream.close()
    return {"paper": paper, "created": created, "pdf": {"found": bool(pdf_url), "imported": bool(paper.get("file_path")), "error": pdf_error}}


def _stream_citation_graph(paper: dict[str, Any], limit: int, persist: bool):
    async def events():
        queue = asyncio.Queue()
        stopped = Event()
        loop = asyncio.get_running_loop()

        def emit(event):
            if not stopped.is_set():
                loop.call_soon_threadsafe(queue.put_nowait, event)

        def run():
            try:
                result = graph.external_citation_graph(paper, limit, persist=persist,
                    progress=lambda step, status: emit({"type": "progress", "step": step, "status": status}))
                emit({"type": "result", "data": result})
            except Exception:
                emit({"type": "error", "message": "Unable to load the graph. Try again."})

        worker = asyncio.create_task(asyncio.to_thread(run))
        try:
            yield json.dumps({"type": "progress", "step": "start", "status": "done"}) + "\n"
            while True:
                event = await queue.get()
                yield json.dumps(event) + "\n"
                if event["type"] in {"result", "error"}:
                    break
        finally:
            stopped.set()
            worker.cancel()

    return StreamingResponse(events(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@router.get("/papers/{paper_id}/citation-graph")
def paper_citation_graph(paper_id: int, limit: int = Query(default=24, ge=1, le=60), stream: bool = False):
    if stream:
        return _stream_citation_graph(store.find("papers", paper_id, "Article"), limit, True)
    return graph.citation_graph(store.find("papers", paper_id, "Article"), limit)


@router.post("/citation-graph/expand")
def expand_citation_graph(payload: CitationGraphExpandRequest, limit: int = Query(default=24, ge=1, le=60), stream: bool = False):
    if stream:
        return _stream_citation_graph(json_values(payload), limit, False)
    return graph.expand_graph(json_values(payload), limit)


@router.post("/papers/{paper_id}/citation-nodes/import", status_code=201)
def import_citation_node(paper_id: int, payload: PaperImportConfirm) -> dict[str, Any]:
    store.find("papers", paper_id, "Article")
    return graph.import_node(paper_id, json_values(payload))



@router.post("/citation-graph/details")
def citation_node_details(payload: CitationNodeDetailsRequest) -> dict[str, Any]:
    return graph.enrich_node(json_values(payload))


@router.post("/citation-graph/import", status_code=201)
def import_external_citation_node(payload: PaperImportConfirm) -> dict[str, Any]:
    return graph.import_node(None, json_values(payload))

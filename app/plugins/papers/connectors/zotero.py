from __future__ import annotations

import hashlib
import copy
import logging
import threading
import uuid
from typing import Any, Callable
from urllib.parse import quote, urlencode, urlsplit

from fastapi import HTTPException

from app.core.kernel import env
from app.core.kernel.user_settings import move_to_env
from app.core.kernel.config import settings
from app.plugins.papers import library
from app.plugins.papers.connectors.http import request_json, download_pdf
from app.plugins.papers.connectors import zotero_content
from app.core.records.repository import store


API_ROOT = "https://api.zotero.org"
SKIPPED_TYPES = {"attachment", "note", "annotation"}
Progress = Callable[..., None]
_job_lock = threading.RLock()
_job: dict[str, Any] | None = None


def sync_status() -> dict[str, Any]:
    with _job_lock:
        if _job and _job["workspace"] == str(settings.storage_path):
            return copy.deepcopy({key: value for key, value in _job.items() if key != "workspace"})
        return {"status": "idle"}


def start_sync() -> dict[str, Any]:
    """Return immediately; one worker owns the sync, even across browser reloads."""
    global _job
    with _job_lock:
        if _job and _job["status"] == "running":
            if _job["workspace"] != str(settings.storage_path):
                raise HTTPException(409, "A Zotero sync is still finishing in another workspace. Retry shortly.")
            return sync_status()
        _job = {"id": uuid.uuid4().hex, "workspace": str(settings.storage_path), "status": "running", "progress": {"phase": "connecting", "message": "Connecting to Zotero…"}, "result": None, "error": ""}
        response = sync_status()
        threading.Thread(target=_run_sync, args=(_job["id"], _job["workspace"]), daemon=True, name="zotero-sync").start()
        return response


def _run_sync(job_id: str, workspace: str) -> None:
    def report(**progress):
        with _job_lock:
            if str(settings.storage_path) != workspace:
                raise HTTPException(409, "The workspace changed during synchronization. Retry in the selected workspace.")
            if _job and _job["id"] == job_id:
                _job["progress"] = progress
    try:
        result = synchronize(report)
        with _job_lock:
            if _job and _job["id"] == job_id:
                _job.update(status="completed", result=result, progress={"phase": "done", "message": "Zotero import complete"})
    except Exception as error:
        # Do not expose exception URLs, signed links or credentials to clients.
        message = str(error.detail) if isinstance(error, HTTPException) else "The Zotero import could not finish. References already imported are kept; retry the synchronization."
        if not isinstance(error, HTTPException):
            logging.getLogger(__name__).error("Zotero sync failed (%s)", type(error).__name__)
        with _job_lock:
            if _job and _job["id"] == job_id:
                _job.update(status="failed", error=message)


API_KEY_ENV, USER_ID_ENV = "KAVOT_ZOTERO_API_KEY", "KAVOT_ZOTERO_USER_ID"


def credentials() -> tuple[str, str]:
    """The API key and library id from the .env file (moved there from older settings)."""
    move_to_env(("integrations", "zotero", "api_key"), API_KEY_ENV)
    move_to_env(("integrations", "zotero", "user_id"), USER_ID_ENV)
    return env.get(API_KEY_ENV), env.get(USER_ID_ENV)


def status() -> dict[str, Any]:
    key, user_id = credentials()
    return {
        "configured": bool(key),
        "api_key_hint": f"••••{key[-4:]}" if key else "",
        "user_id": int(user_id) if user_id.isdigit() else user_id or None,
    }


def configure(api_key: str) -> dict[str, Any]:
    key = api_key.strip()
    current = request_json(f"{API_ROOT}/keys/current", headers={"Zotero-API-Key": key})
    user_id = current.get("userID")
    if not user_id:
        raise HTTPException(status_code=422, detail="This Zotero key is not linked to a personal library")
    env.update({API_KEY_ENV: key, USER_ID_ENV: str(int(user_id))})
    return status()


def _paper_values(item: dict[str, Any]) -> dict[str, Any] | None:
    data = item.get("data") or {}
    if data.get("itemType") in SKIPPED_TYPES or not str(data.get("title") or "").strip():
        return None
    authors = []
    for creator in data.get("creators") or []:
        name = " ".join(part for part in [creator.get("firstName"), creator.get("lastName")] if part)
        if not name:
            name = str(creator.get("name") or "")
        if name:
            authors.append(name)
    return {
        "title": str(data.get("title") or "").strip(),
        "authors": authors,
        "abstract": str(data.get("abstractNote") or ""),
        "publication": str(data.get("publicationTitle") or data.get("conferenceName") or data.get("publisher") or ""),
        "published_at": str(data.get("date") or ""),
        "doi": str(data.get("DOI") or ""),
        "url": str(data.get("url") or ""),
        "tags": [str(tag.get("tag")) for tag in data.get("tags") or [] if tag.get("tag")],
        "metadata": {"zotero_item_type": data.get("itemType"), "zotero_version": item.get("version")},
        "zotero_key": str(data.get("key") or item.get("key") or ""),
        "origin": "zotero",
    }


def _is_pdf(item: dict[str, Any]) -> bool:
    data = item.get("data") or {}
    return data.get("itemType") == "attachment" and (
        str(data.get("contentType") or "").split(";")[0].strip().lower() == "application/pdf"
        or str(data.get("filename") or "").lower().endswith(".pdf")
        or (data.get("linkMode") == "linked_url" and urlsplit(str(data.get("url") or "")).path.lower().endswith(".pdf"))
    )


def _attachment_pdf(item: dict[str, Any], user_id: Any, api_key: str):
    data = item.get("data") or {}
    mode = data.get("linkMode")
    key = str(item.get("key") or data.get("key") or "")
    if mode == "linked_file":
        raise HTTPException(409, "This PDF is a local linked file. Upload it to Zotero Storage or attach it manually in Kavot.")
    if mode in {"imported_file", "imported_url"} and key:
        url = f"{API_ROOT}/users/{quote(str(user_id), safe='')}/items/{quote(key, safe='')}/file"
        try:
            stream = download_pdf(url, headers={"Zotero-API-Key": api_key, "Zotero-API-Version": "3"})
        except HTTPException as error:
            if "HTTP 403" in str(error.detail) or "HTTP 401" in str(error.detail):
                raise HTTPException(403, "Zotero denied file access. Enable file access for this API key in your Zotero account.") from error
            if "HTTP 404" in str(error.detail):
                # Imported URL attachments retain their original download URL,
                # even when their binary has never reached Zotero Storage.
                source_url = str(data.get("url") or "")
                if urlsplit(source_url).scheme in {"http", "https"}:
                    try:
                        return download_pdf(source_url)
                    except (HTTPException, OSError):
                        pass
                raise HTTPException(409, "This PDF is not available in Zotero Storage. Sync the file in Zotero first; local-only and WebDAV files cannot be downloaded through this connection.") from error
            raise
        # WebDAV metadata can describe a newer file than Zotero Storage serves.
        expected = str(data.get("md5") or "").lower()
        if expected:
            try:
                checksum = hashlib.md5()
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    checksum.update(chunk)
                if checksum.hexdigest() != expected:
                    raise HTTPException(409, "The stored PDF does not match Zotero's current file. Sync it to Zotero Storage first; the latest version may be on WebDAV.")
                stream.seek(0)
            except BaseException:
                stream.close()
                raise
        return stream
    if mode == "linked_url":
        url = str(data.get("url") or "")
        if urlsplit(url).scheme not in {"http", "https"}:
            raise HTTPException(409, "This PDF attachment has no downloadable web address.")
        return download_pdf(url)
    raise HTTPException(409, "This PDF attachment is not available for download.")


def _sync_pdfs(attachments: list[dict[str, Any]], papers: dict[str, dict[str, Any]], user_id: Any, api_key: str, report: Progress) -> dict[str, Any]:
    result = {"downloaded": 0, "existing": 0, "unavailable": 0, "failed": 0, "errors": []}
    grouped: dict[int, list[dict[str, Any]]] = {}
    for item in attachments:
        data = item.get("data") or {}
        parent = str(data.get("parentItem") or item.get("key") or data.get("key") or "")
        paper = papers.get(parent)
        if paper:
            grouped.setdefault(paper["id"], []).append(item)
    def progress(completed, title="", message="Checking PDF attachments…"):
        report(phase="pdfs", completed=completed, total=len(grouped), title=title, message=message, pdfs=copy.deepcopy(result))
    progress(0)
    for index, (paper_id, candidates) in enumerate(grouped.items()):
        paper = store.find("papers", paper_id, "Article")
        progress(index, paper["title"])
        if library.local_pdf_path(paper):
            result["existing"] += 1
            progress(index + 1)
            continue
        errors = []
        for item in sorted(candidates, key=lambda entry: (entry.get("data", {}).get("linkMode") not in {"imported_file", "imported_url"}, str(entry.get("key") or ""))):
            try:
                progress(index, paper["title"], "Downloading PDF…")
                with _attachment_pdf(item, user_id, api_key) as stream:
                    progress(index, paper["title"], "Saving PDF…")
                    library.attach_pdf(paper_id, stream, extract=False)
                result["downloaded"] += 1
                break
            except HTTPException as error:
                errors.append((error.status_code, str(error.detail)))
            except OSError:
                errors.append((500, "The downloaded PDF could not be saved locally."))
        else:
            result["unavailable" if all(code == 409 for code, _ in errors) else "failed"] += 1
            result["errors"].append({"paper_id": paper_id, "title": paper["title"], "message": " ".join(dict.fromkeys(message for _, message in errors))})
        progress(index + 1)
    return result


def _fetch_collections(user_id: Any, api_key: str, report: Progress) -> list[dict[str, Any]]:
    collections = []
    while True:
        report(phase="collections", completed=len(collections), message="Fetching Zotero folders…")
        query = urlencode({"format": "json", "limit": 100, "start": len(collections)})
        page = request_json(f"{API_ROOT}/users/{user_id}/collections?{query}", headers={"Zotero-API-Key": api_key, "Zotero-API-Version": "3"})
        if not isinstance(page, list):
            raise HTTPException(502, "Zotero returned an invalid collections response")
        collections.extend(page)
        if len(page) < 100:
            return collections


def synchronize(report: Progress = lambda **_: None) -> dict[str, Any]:
    api_key, user_id = credentials()
    if not api_key or not user_id:
        raise HTTPException(status_code=409, detail="Configure Zotero in Settings before synchronizing")
    created = updated = skipped = 0
    attachments = []
    notes = []
    memberships = {}
    papers = {}
    collections = _fetch_collections(user_id, api_key, report)
    folders = zotero_content.sync_collections(collections, user_id)
    start = 0
    while True:
        report(phase="references", page=start // 100 + 1, completed=created + updated, created=created, updated=updated, skipped=skipped, message="Fetching references from Zotero…")
        query = urlencode({"format": "json", "limit": 100, "start": start, "sort": "dateModified", "direction": "asc"})
        items = request_json(f"{API_ROOT}/users/{user_id}/items?{query}", headers={"Zotero-API-Key": api_key, "Zotero-API-Version": "3"})
        if not isinstance(items, list):
            raise HTTPException(status_code=502, detail="Zotero returned an invalid library response")
        with store.batch() as page_state:
            by_zotero_key = {paper["zotero_key"]: paper for paper in page_state["papers"] if paper.get("zotero_key")}
            for item in items:
                data = item.get("data") or {}
                if data.get("itemType") == "note":
                    notes.append(item)
                    continue
                if _is_pdf(item):
                    attachments.append(item)
                    data = item.get("data") or {}
                    if data.get("parentItem"):
                        continue
                    # A standalone PDF has no bibliographic parent: give it its own
                    # library entry so it remains accessible from the PDF reader.
                    item = {**item, "data": {**data, "itemType": "document", "title": data.get("title") or data.get("filename") or "Zotero PDF"}}
                values = _paper_values(item)
                if not values:
                    skipped += 1
                    continue
                report(phase="references", page=start // 100 + 1, completed=created + updated, created=created, updated=updated, skipped=skipped, title=values["title"], message="Importing references…")
                duplicate = by_zotero_key.get(values.get("zotero_key")) or library.find_duplicate(values)
                if duplicate:
                    values["metadata"] = {**(duplicate.get("metadata") or {}), **values["metadata"]}
                if duplicate and duplicate.get("zotero_key") == values.get("zotero_key") and item.get("version") is not None and (duplicate.get("metadata") or {}).get("zotero_version") == item["version"]:
                    paper, was_created = duplicate, False
                    skipped += 1
                else:
                    paper, was_created = library.import_paper(values)
                by_zotero_key[values["zotero_key"]] = paper
                papers[str(item.get("key") or (item.get("data") or {}).get("key") or "")] = paper
                memberships.setdefault(paper["id"], set()).update(data.get("collections") or [])
                created += int(was_created)
                updated += int(not was_created)
        if len(items) < 100:
            break
        start += len(items)
    with store.batch():
        for paper_id, keys in memberships.items():
            zotero_content.file_paper(paper_id, sorted(keys), folders)
    note_folders = zotero_content.sync_collections(collections, user_id, notes=True) if any(not (note.get("data") or {}).get("parentItem") for note in notes) else {}
    with store.batch():
        note_result = zotero_content.sync_notes(notes, papers, note_folders, user_id, report)
    pdfs = _sync_pdfs(attachments, papers, user_id, api_key, report)
    return {"created": created, "updated": updated, "skipped": skipped, "total": created + updated, "pdfs": pdfs,
            "collections": {"total": len(folders)}, "notes": note_result}

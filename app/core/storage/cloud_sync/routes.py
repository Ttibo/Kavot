from __future__ import annotations

import os
import asyncio
import json
import threading
import time
import httpx
from contextlib import nullcontext
from typing import Literal, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File
from fastapi.responses import StreamingResponse, FileResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, ConfigDict, Field

from app.core.storage.cloud_sync.client import CloudError, LocalSync

router = APIRouter(prefix="/api/cloud-sync", tags=["cloud-sync"])
_lock = threading.RLock()
_clients = {}
_wake = threading.Event()
_stop = threading.Event()
_worker = None
_events_worker = None
_events_http = None
_events_stop = threading.Event()
_events_connected = threading.Event()
_status_lock = threading.Lock()
# Local edits are noticed by a stat-only watcher; the cloud pushes its own
# changes over SSE. The periodic pass is only a safety net.
WATCH_SECONDS = 2
SAFETY_SECONDS = 900
OFFLINE_SECONDS = 60
_workspace_status = {
    "running": False,
    "last_sync": None,
    "last_error": None,
    "summary": None,
    "interval_seconds": WATCH_SECONDS,
    "progress": None,
    "local_revision": 0,
    "auth_required": False,
    "duration_ms": None,
    # Bumped whenever the stored activity history changes.
    "activity_revision": 0,
}


def local_only(request: Request):
    if request.url.hostname not in {"127.0.0.1", "localhost", "::1"} or request.headers.get("x-kavot-local") != "1":
        raise HTTPException(403, "This operation must come from the local app.")


def client():
    from app.core.kernel.config import settings
    from app.core.kernel.user_settings import config_dir
    from app.core.kernel import env
    origin = env.get("KAVOT_CLOUD_URL", "https://kavot.cloud")
    key = (origin, str(settings.storage_path.resolve()))
    if key not in _clients:
        _clients[key] = LocalSync(origin, settings.storage_path, config_dir() / "cloud-sync.sqlite")
    return _clients[key]


def invoke(action, *, serialize=True):
    with _lock if serialize else nullcontext():
        try:
            return action(client())
        except CloudError as error:
            raise HTTPException(error.status, error.detail)


def workspace_status():
    from app.core.kernel.config import settings
    with _status_lock:
        return {**_workspace_status, "path": str(settings.storage_path), "live": _events_connected.is_set(),
                "enabled": os.getenv("KAVOT_DESKTOP", "").lower() in {"1", "true", "yes"}}


def _set_auth_required(value):
    with _status_lock:
        _workspace_status["auth_required"] = value


def run_workspace_sync():
    with _lock:
        return _run_workspace_sync()


def _record_activity(sync_client, started_at, started, summary=None, error=None):
    """Store the pass in the activity history; never fail a sync over it."""
    try:
        changed = sync_client.record_activity(started_at, round((time.monotonic() - started) * 1000), summary, error)
    except Exception:
        return
    if changed:
        with _status_lock:
            _workspace_status["activity_revision"] += 1


def _run_workspace_sync():
    sync_client = None
    started, started_at = time.monotonic(), time.time()
    with _status_lock:
        _workspace_status["running"] = True
        _workspace_status["last_error"] = None
        _workspace_status["progress"] = {"phase": "remote", "path": None, "completed": 0, "total": 0}
    try:
        with _lock:
            sync_client = client()
            def report(**event):
                with _status_lock:
                    _workspace_status["progress"] = {**(_workspace_status["progress"] or {}), **event}
            sync_client.progress = report
            from app.core.storage.cloud_sync.sharing import reconcile
            sync_client.received_shares = 0
            with sync_client.session():
                shared_errors = reconcile(sync_client)
                summary = sync_client.sync_workspace()
            summary["errors"].extend(shared_errors)
            if not summary["errors"] and not summary["conflicts"]:
                # Later events announcing this revision need no new pass.
                sync_client.applied_revision = sync_client.pass_revision
        with _status_lock:
            _workspace_status["auth_required"] = False
            _workspace_status["duration_ms"] = round((time.monotonic() - started) * 1000)
            _workspace_status["summary"] = summary
            if summary["downloaded"] or summary["deleted_local"]:
                _workspace_status["local_revision"] += 1
            _workspace_status["last_sync"] = int(time.time())
            if summary["errors"]:
                _workspace_status["last_error"] = f"{len(summary['errors'])} file(s) could not be synced."
        _record_activity(sync_client, started_at, started, summary)
        return summary
    except CloudError as error:
        with _status_lock:
            _workspace_status["last_error"] = str(error.detail)
            # A rejected device token cannot recover by retrying: wait for a new link.
            _workspace_status["auth_required"] = error.status == 401
        if sync_client is not None:
            _record_activity(sync_client, started_at, started, error=str(error.detail))
        raise
    except Exception:
        with _status_lock:
            _workspace_status["last_error"] = "Automatic sync failed."
        if sync_client is not None:
            _record_activity(sync_client, started_at, started, error="Automatic sync failed.")
        raise
    finally:
        with _status_lock:
            # A received share is already on disk even if the later file sync fails.
            if sync_client is not None and getattr(sync_client, 'received_shares', 0):
                _workspace_status["local_revision"] += 1
            _workspace_status["running"] = False


def _background_loop():
    fingerprint, last_pass, failures = None, 0.0, 0
    while not _stop.is_set():
        woken = _wake.wait(WATCH_SECONDS)
        _wake.clear()
        if _stop.is_set():
            break
        try:
            sync_client = client()
            # Edits from agents, editors or the file explorer never pass through
            # the API, so compare a cheap stat signature of the workspace.
            current = sync_client.fingerprint()
            periodic = (SAFETY_SECONDS if _events_connected.is_set() else OFFLINE_SECONDS) * 2 ** min(failures, 4)
            with _status_lock:
                blocked = _workspace_status["auth_required"]
            if blocked or not (woken or current != fingerprint or time.monotonic() - last_pass >= periodic):
                continue
            # Coalesce bursts of editor saves without delaying local responses.
            if _stop.wait(0.5):
                break
            _wake.clear()
            fingerprint, last_pass = current, time.monotonic()
            if sync_client.token():
                run_workspace_sync()
            failures = 0
        except Exception:
            # The status endpoint exposes the last useful error. A missing token,
            # offline server, or unavailable keyring must never stop Kavot.
            failures += 1


def _cloud_events_loop(stop=None):
    global _events_http
    stop = stop if stop is not None else _stop
    while not stop.is_set():
        http = None
        try:
            sync_client = client()
            token = sync_client.token()
            if not token:
                stop.wait(2)
                continue
            with httpx.Client(transport=sync_client.api_transport, trust_env=False,
                              follow_redirects=False, timeout=httpx.Timeout(10, read=20)) as http:
                _events_http = http
                with http.stream('GET', sync_client.origin + '/api/cloud/sync/events',
                                 headers={'Authorization': 'Bearer ' + token}) as response:
                    if response.status_code == 401:
                        _set_auth_required(True)
                        stop.wait(30)
                        continue
                    response.raise_for_status()
                    if not response.headers.get('content-type', '').startswith('text/event-stream'):
                        raise ValueError('Invalid event stream')
                    _events_connected.set()
                    # The first event carries the current revision: a reconnection
                    # reconciles only when something changed while disconnected.
                    for line in response.iter_lines():
                        if stop.is_set() or client() is not sync_client:
                            break
                        if line.startswith('data:'):
                            try:
                                revision = str(json.loads(line[5:]).get('revision'))
                            except (ValueError, AttributeError):
                                revision = None
                            if revision is None or revision != sync_client.applied_revision:
                                _wake.set()
        except Exception:
            pass  # Offline and older servers retain the periodic sync fallback.
        finally:
            if _events_http is http:
                _events_connected.clear()
                _events_http = None
        stop.wait(2)


def start_background_sync():
    global _worker, _events_worker, _events_stop
    if _worker is not None and _worker.is_alive():
        return
    _stop.clear()
    _worker = threading.Thread(target=_background_loop, name="kavot-cloud-sync", daemon=True)
    _worker.start()
    # A previous blocked read must stay stopped even if the service restarts.
    _events_stop = threading.Event()
    _events_worker = threading.Thread(target=_cloud_events_loop, args=(_events_stop,), name='kavot-cloud-events', daemon=True)
    _events_worker.start()
    _wake.set()


def stop_background_sync():
    _stop.set()
    _events_stop.set()
    _wake.set()
    http = _events_http
    if http is not None:
        http.close()
    if _worker is not None and _worker.is_alive():
        _worker.join(timeout=5)
    if _events_worker is not None and _events_worker.is_alive():
        _events_worker.join(timeout=5)


@router.get('/workspace/events', dependencies=[Depends(local_only)])
async def workspace_events(request: Request):
    async def stream():
        previous = None
        heartbeat = time.monotonic()
        while not await request.is_disconnected():
            status = workspace_status()
            current = (status['local_revision'], status['running'])
            if current != previous:
                yield 'data: ' + json.dumps({'local_revision': current[0], 'running': current[1]}) + '\n\n'
                previous = current
                heartbeat = time.monotonic()
            elif time.monotonic() - heartbeat >= 10:
                yield ': heartbeat\n\n'
                heartbeat = time.monotonic()
            await asyncio.sleep(0.25)
    return StreamingResponse(stream(), media_type='text/event-stream',
        headers={'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no'})


def request_background_sync():
    _wake.set()


def notify_local_change():
    """Make open windows reload data written outside their own requests (agents)."""
    with _status_lock:
        _workspace_status["local_revision"] += 1


class PathInput(BaseModel):
    path: str = Field(min_length=1, max_length=1000)



class ResolveInput(PathInput):
    choice: Literal["keep_local", "keep_remote", "keep_both"]
    expected_version: int = Field(ge=0)


class ShareSource(BaseModel):
    kind: Literal["note", "project", "item"]
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,128}$")
    collection: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9_-]{1,63}$")


class ShareCreate(BaseModel):
    source: ShareSource
    recipient_number: str = Field(pattern=r"^[0-9]{12}$")


class ShareEdit(BaseModel):
    expected_version: int = Field(ge=1)
    content: dict[str, Any]


class ShareInvite(BaseModel):
    recipient_number: str = Field(pattern=r"^[0-9]{12}$")


@router.get("/shares/catalog", dependencies=[Depends(local_only)])
def share_catalog():
    from app.core.storage.cloud_sync.sharing import catalog
    return catalog()


@router.get("/shares", dependencies=[Depends(local_only)])
def shares(offset: int = 0):
    return invoke(lambda c: c.api("GET", f"/shares?offset={max(0, offset)}"), serialize=False)


@router.post("/shares", dependencies=[Depends(local_only)])
def share_create(body: ShareCreate):
    from app.core.storage.cloud_sync.sharing import publish
    if body.source.kind == "item" and not body.source.collection:
        raise HTTPException(422, "Choose a collection.")
    if body.source.kind != "item" and not body.source.id.isdigit():
        raise HTTPException(422, "Invalid item ID.")
    return invoke(lambda c: publish(c, body.source.model_dump(exclude_none=True), body.recipient_number))


@router.get("/shares/{item_id}", dependencies=[Depends(local_only)])
def share_read(item_id: UUID):
    return invoke(lambda c: c.api("GET", f"/shares/{item_id}"), serialize=False)


@router.put("/shares/{item_id}", dependencies=[Depends(local_only)])
def share_edit(item_id: UUID, body: ShareEdit):
    result = invoke(lambda c: c.api("PUT", f"/shares/{item_id}", body.model_dump()))
    request_background_sync()
    return result


@router.post("/shares/{item_id}/members", dependencies=[Depends(local_only)])
def share_invite(item_id: UUID, body: ShareInvite):
    return invoke(lambda c: c.api("POST", f"/shares/{item_id}/members", body.model_dump()))


@router.delete("/shares/{item_id}/members/{number}", dependencies=[Depends(local_only)])
def share_revoke(item_id: UUID, number: str):
    if len(number) != 12 or not number.isdigit():
        raise HTTPException(422, "Invalid sharing number.")
    return invoke(lambda c: c.api("DELETE", f"/shares/{item_id}/members/{number}"))


@router.delete("/shares/{item_id}", dependencies=[Depends(local_only)])
def share_delete(item_id: UUID):
    return invoke(lambda c: c.api("DELETE", f"/shares/{item_id}"))


@router.get("/shares/{item_id}/attachments/{resource_id}", dependencies=[Depends(local_only)])
def share_attachment(item_id: UUID, resource_id: UUID):
    return invoke(lambda c: c.api("GET", f"/shares/{item_id}/attachments/{resource_id}"), serialize=False)


@router.get("/status", dependencies=[Depends(local_only)])
def status():
    def read(c):
        workspace = workspace_status()
        return {"connected": bool(c.token()) and not workspace["auth_required"], "origin": c.origin,
                "workspace": workspace}
    return invoke(read, serialize=False)


@router.post("/connect", dependencies=[Depends(local_only)])
def connect():
    return invoke(lambda c: c.connect())


@router.post("/connect/poll", dependencies=[Depends(local_only)])
def poll():
    result = invoke(lambda c: c.poll())
    if result["status"] == "approved":
        with _status_lock:
            _workspace_status["auth_required"] = False
            _workspace_status["last_error"] = None
        request_background_sync()
    return result


@router.get("/workspace/status", dependencies=[Depends(local_only)])
def automatic_status():
    return workspace_status()


@router.get("/workspace/activity", dependencies=[Depends(local_only)])
def workspace_activity():
    """Recent passes that changed something and recent file events on this device."""
    return invoke(lambda c: c.activity(), serialize=False)


@router.post("/workspace/sync", dependencies=[Depends(local_only)])
def synchronize_workspace():
    return invoke(lambda _: run_workspace_sync())



@router.get("/resources", dependencies=[Depends(local_only)])
def resources(offset: int = 0):
    return invoke(lambda c: c.api("GET", f"/sync/resources?offset={max(0, offset)}"), serialize=False)


@router.get("/resources/{resource_id}/revisions", dependencies=[Depends(local_only)])
def resource_revisions(resource_id: UUID):
    return invoke(lambda c: c.api("GET", f"/sync/resources/{resource_id}/revisions"), serialize=False)


class RestoreRevisionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision_id: UUID
    expected_version: int = Field(ge=0)


@router.post("/resources/{resource_id}/restore", dependencies=[Depends(local_only)])
def restore_resource_revision(resource_id: UUID, body: RestoreRevisionInput):
    """Publish an older revision as the new head; the next pass downloads it."""
    result = invoke(lambda c: c.api("POST", f"/sync/resources/{resource_id}/restore",
                                    {"revision_id": str(body.revision_id), "expected_version": body.expected_version}))
    request_background_sync()
    return result


@router.get("/account", dependencies=[Depends(local_only)])
def account():
    return invoke(lambda c: c.api("GET", "/me"), serialize=False)


@router.get("/backups", dependencies=[Depends(local_only)])
def online_backups():
    from app.core.storage import online_backups as backups
    return invoke(backups.list_backups, serialize=False)


@router.post("/backups", status_code=201, dependencies=[Depends(local_only)])
def create_online_backup():
    from app.core.storage import online_backups as backups
    return invoke(backups.create_backup)


@router.post("/backups/upload", status_code=201, dependencies=[Depends(local_only)])
def upload_online_backup(file: UploadFile = File(...)):
    from app.core.storage import online_backups as backups
    return invoke(lambda c: backups.upload_backup(c, file))


@router.post("/backups/from-local/{local_id}", status_code=201, dependencies=[Depends(local_only)])
def copy_backup_online(local_id: UUID):
    """Keep an existing local version online too (same backup, two places)."""
    from app.core.storage import online_backups as backups, backups as workspace_backups
    kind = next((item["kind"] for item in workspace_backups.list_backups() if item["id"] == str(local_id)), None)
    if kind is None:
        raise HTTPException(404, "Backup not found")
    return invoke(lambda c: backups.upload_local(c, str(local_id), automatic=kind == "auto"))


@router.get("/backups/{backup_id}/download", dependencies=[Depends(local_only)])
def download_online_backup(backup_id: UUID):
    from app.core.storage import online_backups as backups
    path, item = invoke(lambda c: backups.download_backup(c, backup_id), serialize=False)
    return FileResponse(path, filename=item["name"], media_type="application/zip",
                        background=BackgroundTask(path.unlink, missing_ok=True))


@router.post("/backups/{backup_id}/restore", dependencies=[Depends(local_only)])
def restore_online_backup(backup_id: UUID):
    from app.core.storage import online_backups as backups
    return invoke(lambda c: backups.restore_backup(c, backup_id))


@router.delete("/backups/{backup_id}", status_code=204, dependencies=[Depends(local_only)])
def delete_online_backup(backup_id: UUID):
    from app.core.storage import online_backups as backups
    invoke(lambda c: backups.delete_backup(c, backup_id))




@router.post("/compare", dependencies=[Depends(local_only)])
def compare(body: PathInput):
    return invoke(lambda c: c.comparison(body.path))


@router.post("/resolve", dependencies=[Depends(local_only)])
def resolve(body: ResolveInput):
    with _lock:
        result = invoke(lambda c: c.resolve(body.path, body.choice, body.expected_version))
        if result["status"] != "conflict":
            with _status_lock:
                _workspace_status["local_revision"] += 1
                summary = _workspace_status["summary"]
                if summary:
                    _workspace_status["summary"] = {
                        **summary, "conflicts": [path for path in summary["conflicts"] if path != body.path],
                    }
    request_background_sync()
    return result


class ResetWorkspaceInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmation: Literal["replace-cloud-with-local"]


@router.post("/workspace/reset", dependencies=[Depends(local_only)])
def reset_workspace(body: ResetWorkspaceInput):
    def reset(c):
        with _status_lock:
            _workspace_status["running"] = True
            _workspace_status["last_error"] = None
            _workspace_status["progress"] = {"phase": "reset", "path": None, "completed": 0, "total": 0}
        started, started_at = time.monotonic(), time.time()
        def report(**event):
            with _status_lock:
                _workspace_status["progress"] = {**(_workspace_status["progress"] or {}), **event}
        c.progress = report
        try:
            result = c.replace_cloud_from_local()
            with _status_lock:
                _workspace_status["summary"] = result["summary"]
                if result["summary"]["errors"]:
                    _workspace_status["last_error"] = "Cloud reset; some local files still need to be uploaded."
                _workspace_status["last_sync"] = int(time.time())
            _record_activity(c, started_at, started, result["summary"])
            return result
        except CloudError as error:
            with _status_lock:
                _workspace_status["last_error"] = error.detail
            _record_activity(c, started_at, started, error=str(error.detail))
            raise
        finally:
            with _status_lock:
                _workspace_status["running"] = False
    return invoke(reset)

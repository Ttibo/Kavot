"""Portable workspace snapshots with non-destructive restoration.

Snapshots are dated, numbered versions. Manual ones are kept until deleted;
automatic ones follow a day/week/month retention policy.
"""
from __future__ import annotations

import os
import json
import shutil
import stat
import threading
import time
import uuid
import zipfile
from pathlib import Path

from fastapi import HTTPException

from app.core.storage.cloud_sync.client import tree_fingerprint
from app.core.kernel.config import settings
from app.core.kernel.user_settings import save_storage_path
from app.core.records.repository import store

PERIODS = {"daily": 86400, "weekly": 7 * 86400}
_index_lock = threading.Lock()
schedule_status = {"last_run": None, "last_error": None, "last_backup": None}


def _folder() -> Path:
    return settings.storage_path / ".kavot-backups"


def _archive(identifier: str) -> Path:
    try:
        return _folder() / f"{uuid.UUID(identifier)}.zip"
    except ValueError as error:
        raise HTTPException(404, "Backup not found") from error


def _index_path() -> Path:
    return _folder() / "index.json"


def _read_index() -> dict:
    try:
        data = json.loads(_index_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_index(index: dict) -> None:
    _folder().mkdir(parents=True, exist_ok=True)
    temporary = _folder() / f"index-{uuid.uuid4().hex}.tmp"
    temporary.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(temporary, _index_path())


def fingerprint() -> str:
    return tree_fingerprint(settings.storage_path)


def list_backups() -> list[dict]:
    """Every snapshot, newest first, with a stable version number (oldest = 1)."""
    if not _folder().exists():
        return []
    with _index_lock:
        index = _read_index()
    items = []
    for path in _folder().glob("*.zip"):
        try:
            info = path.stat()
        except OSError:
            continue
        meta = index.get(path.stem, {})
        items.append({"id": path.stem, "size": info.st_size,
                      "created_at": meta.get("created_at", info.st_mtime),
                      "kind": meta.get("kind", "manual"), "label": meta.get("label"),
                      "files": meta.get("files"), "fingerprint": meta.get("fingerprint")})
    items.sort(key=lambda item: item["created_at"])
    for number, item in enumerate(items, 1):
        item["version"] = number
    return items[::-1]


def create_backup(kind: str = "manual", label: str | None = None) -> dict:
    store.ensure()
    folder = _folder()
    folder.mkdir(parents=True, exist_ok=True)
    identifier = str(uuid.uuid4())
    temporary = folder / f"{identifier}.tmp"
    archive = _archive(identifier)
    signature = fingerprint()
    files = 0
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED,
                             allowZip64=True) as bundle:
            for path in settings.storage_path.rglob("*"):
                relative = path.relative_to(settings.storage_path)
                if (".kavot-backups" in relative.parts or ".kavot-conflicts" in relative.parts or ".kavot-local" in relative.parts
                        or path.is_symlink() or not path.is_file()):
                    continue
                bundle.write(path, relative.as_posix())
                files += 1
        with zipfile.ZipFile(temporary) as bundle:
            if bundle.testzip() is not None:
                raise OSError("The backup failed its verification")
        os.replace(temporary, archive)
    finally:
        temporary.unlink(missing_ok=True)
    meta = {"created_at": time.time(), "kind": kind, "label": (label or "").strip()[:120] or None,
            "files": files, "fingerprint": signature}
    with _index_lock:
        index = _read_index()
        index[identifier] = meta
        _write_index(index)
    return next(item for item in list_backups() if item["id"] == identifier)


def backup_path(identifier: str) -> Path:
    path = _archive(identifier)
    if not path.is_file():
        raise HTTPException(404, "Backup not found")
    return path


def delete_backup(identifier: str) -> None:
    path = backup_path(identifier)
    path.unlink()
    with _index_lock:
        index = _read_index()
        if index.pop(path.stem, None) is not None:
            _write_index(index)


def retained(items: list[dict], now: float) -> set[str]:
    """Grandfather-father-son retention: the newest snapshot per day (7 days),
    per week (4 weeks) and per month (12 months), plus the newest overall."""
    keep, buckets = set(), set()
    for position, item in enumerate(sorted(items, key=lambda value: value["created_at"], reverse=True)):
        if position == 0:
            keep.add(item["id"])
        moment = time.localtime(item["created_at"])
        age = (now - item["created_at"]) / 86400
        for name, days, pattern in (("day", 7, "%Y-%m-%d"), ("week", 28, "%G-%V"), ("month", 366, "%Y-%m")):
            bucket = (name, time.strftime(pattern, moment))
            if age <= days and bucket not in buckets:
                buckets.add(bucket)
                keep.add(item["id"])
    return keep


def prune(now: float | None = None) -> list[str]:
    """Remove automatic snapshots outside the retention policy; manual ones stay."""
    automatic = [item for item in list_backups() if item["kind"] == "auto"]
    keep = retained(automatic, now or time.time())
    removed = []
    for item in automatic:
        if item["id"] not in keep:
            delete_backup(item["id"])
            removed.append(item["id"])
    return removed


def run_scheduled_backup(now: float | None = None) -> dict | None:
    """Create an automatic snapshot when one is due and the workspace changed."""
    from app.core.kernel.user_settings import load_backup_settings
    now = now or time.time()
    config = load_backup_settings()
    period = PERIODS.get(config["schedule"])
    if not period:
        return None
    items = list_backups()
    automatic = [item for item in items if item["kind"] == "auto"]
    # Ten minutes of slack keeps a daily backup from drifting later every day.
    if automatic and now - automatic[0]["created_at"] < period - 600:
        return None
    if items and items[0].get("fingerprint") == fingerprint():
        return None
    schedule_status["last_run"] = now
    try:
        item = create_backup(kind="auto")
        prune(now)
        schedule_status["last_backup"] = item["id"]
        schedule_status["last_error"] = None
        if config["online"]:
            from app.core.storage.cloud_sync.routes import client
            from app.core.storage import online_backups
            if client().token():
                online_backups.upload_local(client(), item["id"], automatic=True)
        return item
    except Exception as error:
        schedule_status["last_error"] = str(getattr(error, "detail", error)) or "Automatic backup failed."
        raise


_scheduler: threading.Thread | None = None
_scheduler_stop = threading.Event()


def _scheduler_loop() -> None:
    # Let the app finish starting before the first, possibly large, archive.
    if _scheduler_stop.wait(60):
        return
    while True:
        try:
            run_scheduled_backup()
        except Exception:
            pass  # Exposed through schedule_status; retried on the next check.
        if _scheduler_stop.wait(15 * 60):
            return


def start_scheduler() -> None:
    global _scheduler
    if _scheduler is not None and _scheduler.is_alive():
        return
    _scheduler_stop.clear()
    _scheduler = threading.Thread(target=_scheduler_loop, name="kavot-backups", daemon=True)
    _scheduler.start()


def stop_scheduler() -> None:
    _scheduler_stop.set()
    if _scheduler is not None and _scheduler.is_alive():
        _scheduler.join(timeout=5)


def validate_archive(archive) -> None:
    """Reject damaged archives and entries that cannot belong to a workspace."""
    try:
        with zipfile.ZipFile(archive) as bundle:
            names = set()
            state_file = False
            for member in bundle.infolist():
                name = member.filename.replace("\\", "/")
                normalized = name.rstrip("/")
                parts = normalized.split("/")
                if (name != member.filename or name.startswith("/") or not normalized
                        or any(part in {"", ".", ".."} for part in parts)
                        or ":" in parts[0] or any(part.casefold() == ".kavot-backups" for part in parts)
                        or stat.S_ISLNK(member.external_attr >> 16)):
                    raise HTTPException(422, "Invalid path in the backup")
                if normalized.casefold() in names:
                    raise HTTPException(422, "Duplicate path in the backup")
                names.add(normalized.casefold())
                state_file |= normalized == "kavot.state.json" and not member.is_dir()
            if not state_file:
                raise HTTPException(422, "This ZIP is not a Kavot workspace backup")
            with bundle.open("kavot.state.json") as state_source:
                state = json.load(state_source)
            if not isinstance(state, dict) or not isinstance(state.get("schema_version"), int):
                raise HTTPException(422, "Invalid Kavot workspace data")
            if bundle.testzip() is not None:
                raise HTTPException(422, "Damaged backup")
    except (OSError, EOFError, ValueError, UnicodeError, RuntimeError, NotImplementedError,
            zipfile.BadZipFile, zipfile.LargeZipFile) as error:
        raise HTTPException(422, "Invalid or damaged ZIP backup") from error


def restore_archive(archive: Path, identifier: str) -> dict:
    validate_archive(archive)
    current = settings.storage_path.resolve()
    target = current.parent / f"{current.name}-restaure-{identifier[:8]}"
    if target.exists():
        raise HTTPException(409, "The restore folder already exists")
    target.mkdir()
    try:
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                destination = (target / member.filename).resolve()
                if destination != target and target not in destination.parents:
                    raise HTTPException(422, "Invalid path in the backup")
                if member.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.open(member) as source, destination.open("xb") as output:
                        shutil.copyfileobj(source, output)
        from app.core.agents.sessions import workspace_change
        with workspace_change():
            save_storage_path(target)
            object.__setattr__(settings, "storage_root", target)
            store.ensure()
    except Exception:
        object.__setattr__(settings, "storage_root", current)
        save_storage_path(current)
        shutil.rmtree(target, ignore_errors=True)
        raise
    return {"path": str(target), "previous_path": str(current)}


def restore_backup(identifier: str) -> dict:
    return restore_archive(backup_path(identifier), identifier)

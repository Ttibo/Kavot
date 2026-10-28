from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.core.kernel.config import settings
from app.core.kernel.user_settings import load_backup_settings, load_preferences, save_backup_settings, save_preferences, save_storage_path
from app.core.records.repository import store
from app.core.kernel.system import dashboard, load_demo
from app.core.storage import backups as workspace_backups


router = APIRouter(tags=["system"])


class FontSizesUpdate(BaseModel):
    navigation: int | None = Field(default=None, ge=10, le=24, strict=True)
    interface: int | None = Field(default=None, ge=10, le=24, strict=True)
    titles: int | None = Field(default=None, ge=10, le=40, strict=True)
    editor: int | None = Field(default=None, ge=10, le=24, strict=True)
    tables: int | None = Field(default=None, ge=10, le=24, strict=True)
    assistant: int | None = Field(default=None, ge=10, le=24, strict=True)
    code: int | None = Field(default=None, ge=10, le=24, strict=True)


class PreferenceUpdate(BaseModel):
    theme: Literal["light", "dark"] | None = None
    font_sizes: FontSizesUpdate | None = None
    # Per theme, role -> "#rrggbb"; unknown roles and invalid colors are dropped when saved.
    colors: dict[Literal["light", "dark"], dict[str, str]] | None = None
    palette: list[str] | None = Field(default=None, min_length=1, max_length=24)
    semantic_search: bool | None = None
    # Takes effect at the next start: plugins are loaded once.
    disabled_plugins: list[str] | None = Field(default=None, max_length=50)


class StorageUpdate(BaseModel):
    path: str = Field(min_length=1, max_length=1000)


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "application": "Kavot", "storage": "files"}


@router.get("/dashboard")
def get_dashboard() -> dict[str, Any]:
    return dashboard()


@router.post("/demo", status_code=201)
def create_demo() -> dict[str, Any]:
    return load_demo()


@router.get("/settings/preferences")
def preferences() -> dict[str, Any]:
    return load_preferences()


@router.patch("/settings/preferences")
def update_preferences(payload: PreferenceUpdate) -> dict[str, Any]:
    return save_preferences(payload.model_dump(exclude_none=True))


@router.get("/settings/storage")
def storage_settings() -> dict[str, str]:
    return {"path": str(settings.storage_path)}


@router.get("/settings/backups")
def list_workspace_backups() -> list[dict]:
    return workspace_backups.list_backups()


class BackupCreate(BaseModel):
    label: str | None = Field(default=None, max_length=120)


class BackupSchedule(BaseModel):
    schedule: Literal["off", "daily", "weekly"] | None = None
    online: bool | None = None


@router.post("/settings/backups", status_code=201)
def create_workspace_backup(payload: BackupCreate | None = None) -> dict:
    return workspace_backups.create_backup(label=payload.label if payload else None)


@router.delete("/settings/backups/{backup_id}", status_code=204)
def delete_workspace_backup(backup_id: str) -> None:
    workspace_backups.delete_backup(backup_id)


@router.get("/settings/backup-schedule")
def backup_schedule() -> dict[str, Any]:
    return {**load_backup_settings(), **workspace_backups.schedule_status}


@router.patch("/settings/backup-schedule")
def update_backup_schedule(payload: BackupSchedule) -> dict[str, Any]:
    return {**save_backup_settings(payload.model_dump(exclude_none=True)), **workspace_backups.schedule_status}


@router.get("/settings/backups/{backup_id}/download")
def download_workspace_backup(backup_id: str) -> FileResponse:
    return FileResponse(workspace_backups.backup_path(backup_id),
                        filename=f"kavot-{backup_id}.zip", media_type="application/zip")


@router.post("/settings/backups/{backup_id}/restore")
def restore_workspace_backup(backup_id: str) -> dict:
    return workspace_backups.restore_backup(backup_id)


@router.post("/settings/storage")
def change_storage(payload: StorageUpdate) -> dict[str, str]:
    current = settings.storage_path.resolve()
    target = Path(payload.path).expanduser().resolve()
    if target == current:
        return {"path": str(current)}
    if target == current.parent or current in target.parents:
        raise HTTPException(status_code=422, detail="The new folder cannot be inside the current workspace")
    target.mkdir(parents=True, exist_ok=True)
    if any(target.iterdir()):
        raise HTTPException(status_code=409, detail="The selected folder must be empty")
    from app.core.agents.sessions import workspace_change as external_workspace_change
    with external_workspace_change():
        for item in current.iterdir() if current.is_dir() else ():
            shutil.move(str(item), str(target / item.name))
        save_storage_path(target)
        object.__setattr__(settings, "storage_root", target)
        store.ensure()
    return {"path": str(target)}

"""Create the file-backed workspace at application startup."""

from __future__ import annotations

from contextlib import asynccontextmanager
import os
import shutil

from fastapi import FastAPI

from app.core.kernel.config import settings
from app.core.records.databases import ensure_catalog
from app.core.projects.projects import ensure_files
from app.core.records.repository import store


def ensure_workspace_directories() -> None:
    """Create every top-level directory owned by the workspace."""

    for path in (
        settings.storage_path,
        settings.library_path,
        settings.projects_path,
        settings.notes_path,
        settings.databases_path,
    ):
        path.mkdir(parents=True, exist_ok=True)

    # ``daily`` was the historical storage location for every unscoped note.
    # Keep existing work when upgrading while exposing the clearer ``general``
    # workspace from now on.
    legacy_general = settings.notes_path / "daily"
    general = settings.notes_path / "general"
    if legacy_general.is_dir() and not general.exists():
        legacy_general.replace(general)
    elif legacy_general.is_dir():
        for item in legacy_general.iterdir():
            target = general / item.name
            if not target.exists():
                shutil.move(str(item), str(target))


def reconcile_workspace() -> None:
    store.ensure()
    from app.core.workspace.documents import backfill_article_pdf_links, migrate_html_notes
    migrate_html_notes()
    backfill_article_pdf_links()
    from app.core.records.migrations import migrate_legacy_files, archive_retired_collections
    migrate_legacy_files()
    archive_retired_collections()
    ensure_catalog()
    for project in store.list("projects"):
        ensure_files(project)


@asynccontextmanager
async def lifespan(_: FastAPI):
    from app.core.kernel import env
    env.ensure_user_file()
    ensure_workspace_directories()
    reconcile_workspace()
    from app.core.storage.cloud_sync.routes import start_background_sync, stop_background_sync
    automatic_sync = os.getenv("KAVOT_DESKTOP", "").lower() in {"1", "true", "yes"}
    from app.core.automation import watchers, workflows
    workflows.recover()
    watchers.migrate()
    if automatic_sync:
        start_background_sync()
        from app.core.storage import backups as workspace_backups
        workspace_backups.start_scheduler()
        watchers.start()
        workflows.start()
    try:
        yield
    finally:
        if automatic_sync:
            stop_background_sync()
            workspace_backups.stop_scheduler()
            watchers.stop()
            workflows.stop()
        from app.core.agents.sessions import shutdown
        shutdown()


__all__ = ["ensure_workspace_directories", "lifespan", "reconcile_workspace"]

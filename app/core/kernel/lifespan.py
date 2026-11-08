"""Create the file-backed workspace at application startup."""

from __future__ import annotations

from contextlib import asynccontextmanager
import logging
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
    from app.core.workspace.documents import backfill_article_pdf_links
    from app.core.workspace.note_migration import migrate_html_notes
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
    from app.core.kernel.plugins import load as load_plugins
    services = load_plugins().background_services
    if automatic_sync:
        start_background_sync()
        from app.core.storage import backups as workspace_backups
        workspace_backups.start_scheduler()
        for service in services:
            service.start()
        # Agent CLIs opened from Kavot connect to it; a failure must not stop the app (it is retried on launch).
        from app.mcp import server as mcp_server
        try:
            mcp_server.start()
        except RuntimeError as error:
            logging.getLogger(__name__).warning("Kavot MCP server not started: %s", error)
    try:
        yield
    finally:
        if automatic_sync:
            stop_background_sync()
            workspace_backups.stop_scheduler()
            for service in services:
                service.stop()
        from app.core.agents import consoles, sessions
        consoles.shutdown()
        sessions.shutdown()
        from app.mcp import server as mcp_server
        mcp_server.stop()


__all__ = ["ensure_workspace_directories", "lifespan", "reconcile_workspace"]

"""FastAPI application factory.

The factory only assembles transport concerns. Workspace migrations and data
reconciliation belong to :mod:`app.core.kernel.lifespan`.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse

from app.api import api_router
from app.core.kernel.lifespan import lifespan
from app.core.kernel.config import BASE_DIR
from app.core.storage.cloud_sync.routes import router as cloud_sync_router


def create_app(*, static_dir: Path | None = None) -> FastAPI:
    """Build a fully configured Kavot API application."""

    application = FastAPI(
        title="Kavot API",
        description="Workspace for research projects and literature reviews.",
        version="0.1.0",
        lifespan=lifespan,
    )

    @application.middleware("http")
    async def prevent_stale_interface_cache(request: Request, call_next):
        response = await call_next(request)
        if request.url.path in {"/", "/index.html"} or request.url.path.endswith(
            (".js", ".mjs", ".css")
        ):
            response.headers["Cache-Control"] = "no-store, max-age=0"
        if (request.method in {"POST", "PUT", "PATCH", "DELETE"}
                and request.url.path.startswith("/api/")
                and not request.url.path.startswith("/api/cloud-sync")
                and not request.url.path.startswith("/api/note-scripts/network/fetch")
                and response.status_code < 400):
            from app.core.storage.cloud_sync.routes import request_background_sync
            request_background_sync()
        return response

    application.include_router(api_router)
    application.include_router(cloud_sync_router)
    assets = static_dir or Path(BASE_DIR / "frontend" / "static")
    if (assets / "index.html").is_file():
        application.mount("/", StaticFiles(directory=assets, html=True), name="static")
    else:
        @application.get("/", include_in_schema=False)
        async def frontend_not_built():
            return HTMLResponse(
                "<h1>Kavot</h1><p>Build the interface with "
                "<code>npm --prefix frontend run build</code>.</p>",
                status_code=503,
            )
    return application


__all__ = ["create_app"]

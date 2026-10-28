"""HTTP routes of the core. Plugins mount their own routers through the registry."""

from .collection_watchers import router as collection_watchers_router
from .databases import router as databases_router
from .documents import router as documents_router
from .external_agents import router as external_agents_router
from .projects import router as projects_router
from .records import router as records_router
from .scripts import router as scripts_router
from .system import router as system_router
from .workflows import router as workflows_router
from .watchers import router as watchers_router

ROUTERS = (
    system_router,
    projects_router,
    documents_router,
    scripts_router,
    databases_router,
    records_router,
    external_agents_router,
    collection_watchers_router,
    workflows_router,
    watchers_router,
)

__all__ = ["ROUTERS"]

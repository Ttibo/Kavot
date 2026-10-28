"""Single registry for every local HTTP route exposed by Kavot: the core's, then the plugins'."""

from fastapi import APIRouter

from app.api.routes import ROUTERS
from app.core.kernel.plugins import load

api_router = APIRouter(prefix="/api")
for feature_router in (*ROUTERS, *load().routers):
    api_router.include_router(feature_router)

__all__ = ["api_router"]

"""ASGI entry point used by Uvicorn and the desktop launcher.

Application construction lives in :mod:`app.factory`; keeping this module tiny
makes imports predictable for scripts, tests, and desktop packaging.
"""

from app.factory import create_app


app = create_app()

__all__ = ["app"]

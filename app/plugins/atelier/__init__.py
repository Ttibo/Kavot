"""Atelier plugin: the code workspace of a project (folders, Git, code map, agents)."""
from __future__ import annotations


def register(registry, manifest) -> None:
    from app.plugins.atelier import routes, runs

    registry.routers.append(routes.router)
    runs.recover()

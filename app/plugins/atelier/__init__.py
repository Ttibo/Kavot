"""Atelier plugin: the code workspace of a project (folders, Git, code map, agents)."""
from __future__ import annotations


def register(registry, manifest) -> None:
    from app.plugins.atelier import agents, routes

    registry.routers.append(routes.router)
    registry.agent_workspaces.append(agents)
    agents.drop_legacy_runs()

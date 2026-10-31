"""Extension points the core opens to plugins.

Plugins fill the registry once, when they are loaded; the core only reads it.
Nothing here imports a plugin: :mod:`app.core.kernel.plugins` does the loading.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class Registry:
    # Manifests of the loaded plugins, by id.
    plugins: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Collection definitions shown in the catalogue (same shape as databases.CORE_COLLECTIONS).
    collections: list[dict[str, Any]] = field(default_factory=list)
    # Keys of kavot.state.json owned by plugins (e.g. "tasks", "conferences").
    state_collections: list[str] = field(default_factory=list)
    # FastAPI routers mounted under /api.
    routers: list[Any] = field(default_factory=list)
    # Link types: id -> {"from": collection, "to": collection, "label": str, "plugin": id}.
    link_types: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Link sources: functions (state) -> iterable of {"source", "relation", "target", "provenance"}.
    link_sources: list[Callable[[dict], Any]] = field(default_factory=list)
    # Calendar sources: functions (state, project_id) -> list of events.
    calendar_sources: list[Callable[[dict, int | None], list[dict]]] = field(default_factory=list)
    # MCP tool installers: functions (ToolContext) -> None that declare tools on the run's server.
    mcp_tools: list[Callable[[Any], None]] = field(default_factory=list)
    # Workspace map: collection id -> function (card, row, index) adding facts/outline to an item's card.
    card_builders: dict[str, Callable[[dict, dict, Any], None]] = field(default_factory=dict)
    # Agent guides read on demand with the MCP get_guide tool: topic -> text.
    agent_guides: dict[str, str] = field(default_factory=dict)
    # Search sources: functions (state) -> iterable of index documents (see core.search.documents).
    search_sources: list[Callable[[dict], Any]] = field(default_factory=list)
    # Settings declared by plugins: plugin id -> list of setting definitions.
    settings: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    # Connectors declared by plugins: "<plugin>.<connector>" -> definition.
    connectors: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Reviewable agent actions: kind -> {"model": pydantic model, "state_key": str,
    # "apply": (payload, identifier, values) -> dict with the new or changed item}.
    agent_actions: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Working folders of agent conversations (see app.core.agents.sessions.Workspace): objects with
    # prepare(session, context, mode), launch(session, run) -> Workspace | None, finish(session, run)
    # and forget(session), each called with the sessions lock held.
    agent_workspaces: list[Any] = field(default_factory=list)
    # Hooks on kavot.state.json: fill a new workspace, upgrade an existing one (return True if changed).
    state_initializers: list[Callable[[dict, str], None]] = field(default_factory=list)
    state_migrations: list[Callable[[dict, str], bool]] = field(default_factory=list)
    _loaded: bool = False

    def collection(self, collection_id: str) -> dict[str, Any] | None:
        return next((item for item in self.collections if item["id"] == collection_id), None)

    def state_key(self, collection_id: str) -> str | None:
        """kavot.state.json key that stores a built-in collection's items."""
        definition = self.collection(collection_id)
        return definition.get("state_key") if definition else None


registry = Registry()

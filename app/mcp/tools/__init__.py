"""Kavot's MCP tools, grouped by what they work on.

Each module has an ``install(ctx)`` that declares its tools with ``ctx.tool``,
exactly like a plugin's ``mcp_tools`` installer. A tool body runs with the
session lock held and reads the session's state through ``ctx.run``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.mcp.schemas import compact
from app.mcp.session import Session


@dataclass
class ToolContext:
    """What a tool installer receives (core modules and plugins alike)."""
    default: Session
    tool: Any
    read_only: Any
    network_read: Any
    annotations: Any

    @property
    def session(self) -> Session:
        """The session of the agent making this call."""
        from app.mcp.server import CURRENT
        return CURRENT.get() or self.default

    @property
    def lock(self):
        return self.session.lock

    @property
    def run(self) -> dict:
        return self.session.current()

    def active(self) -> None:
        """Raises when the call's request has ended (a stopped conversation)."""
        self.session.current()

    @staticmethod
    def emit(*_args) -> None:
        """The server already shows every call in the conversation; kept for plugins that call it."""

    @staticmethod
    def compact(value: Any) -> Any:
        return compact(value)


def install_all(ctx: ToolContext) -> None:
    from app.core.kernel.plugins import load as load_plugins
    from app.mcp.tools import workspace, notes, records, changes
    for module in (workspace, notes, records, changes):
        module.install(ctx)
    for install in load_plugins().mcp_tools:
        install(ctx)

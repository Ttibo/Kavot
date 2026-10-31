"""What a plugin gives an agent conversation to work in (see Registry.agent_workspaces)."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Workspace:
    """Folders a conversation's CLI works in, beyond Kavot's own data (always reached through MCP)."""
    cwd: str
    write: bool = False  # may change the files of `writable`
    writable: list[str] = field(default_factory=list)
    readable: list[str] = field(default_factory=list)
    brief: list[str] = field(default_factory=list)
    timeout: int | None = None

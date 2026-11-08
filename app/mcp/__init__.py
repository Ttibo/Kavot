"""Kavot's MCP server: the workspace as tools for agent CLIs (Claude Code, Codex, OpenCode).

Agents reach it from the Agents view's chat (:mod:`app.core.agents.sessions`, one token
per conversation) or from a terminal (:mod:`app.core.agents.terminal`, the workspace
token), keeping every native option of their CLI. This package is what an agent sees
of Kavot, served on loopback while the app runs.

Layout:

- ``server``: builds the server, serves it (start/stop with the app), authenticates calls;
- ``session``: what the tools remember between calls, and the read scope;
- ``memo``, ``context_view``: what a conversation already read, and its compact context;
- ``tools/``: the tools, one module per area (``install(ctx)``, like plugins' ``mcp_tools``);
- ``actions``, ``organization``, ``collections``: validation and application of changes;
- ``schemas``, ``instructions``: compact schemas and what the agent is told.

Every tool definition and result costs the agent tokens on each turn: keep the
instructions short (details go in guides), results compact, and the named write
tools few (other changes go through ``apply_action``).
"""

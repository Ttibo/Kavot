"""Start an agent CLI (Claude Code, Codex, OpenCode) in a terminal, connected to Kavot's MCP server.

The agent keeps everything native: its sign-in, models, permissions, slash
commands and sessions. Kavot only chooses the folder (the workspace) and adds
its MCP server to that launch, without touching the CLI's own configuration.
"""
from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

from fastapi import HTTPException

from app.core.agents import install
from app.core.agents.engines import ENGINES, configuration, resolve_executable
from app.core.kernel.config import settings
from app.core.kernel.user_settings import config_dir


def launch_arguments(engine: str, url: str) -> tuple[list[str], dict[str, str]]:
    """The CLI arguments and environment that add Kavot's MCP server to this launch only.

    The token travels in the environment; the arguments carry no secret.
    """
    from app.mcp.server import TOKEN_ENV
    header = {"Authorization": "Bearer ${" + TOKEN_ENV + "}"}
    if engine == "claude":
        path = config_dir() / "agents" / "claude-mcp.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"mcpServers": {"kavot": {"type": "http", "url": url, "headers": header}}}), encoding="utf-8")
        # One value: --mcp-config takes several files and would swallow a following argument.
        return ["--mcp-config=" + str(path)], {}
    if engine == "codex":
        # A value that is not valid TOML is taken as a plain string: no quotes to survive the shell.
        return ["-c", f"mcp_servers.kavot.url={url}", "-c", f"mcp_servers.kavot.bearer_token_env_var={TOKEN_ENV}"], {}
    config = {"mcp": {"kavot": {"type": "remote", "url": url, "enabled": True, "oauth": False,
                                "headers": {"Authorization": "Bearer {env:" + TOKEN_ENV + "}"}}}}
    return [], {"OPENCODE_CONFIG_CONTENT": json.dumps(config)}


def open_terminal(argv: list[str], cwd: Path | None = None, environment: dict[str, str] | None = None) -> None:
    """Run a command in a new terminal window that stays open when it ends."""
    extra = environment or {}
    env = {**os.environ, "PATH": install.search_path(), **extra}
    if install.WINDOWS:
        quoted = " ".join("'" + part.replace("'", "''") + "'" for part in argv)
        subprocess.Popen(["powershell", "-NoProfile", "-NoExit", "-Command", f"& {quoted}"],
                         cwd=cwd, env=env, creationflags=subprocess.CREATE_NEW_CONSOLE)
        return
    exports = " ".join(f"{name}={shlex.quote(value)}" for name, value in extra.items())
    command = (f"cd {shlex.quote(str(cwd))} && " if cwd else "") + (f"env {exports} " if exports else "") + shlex.join(argv)
    if sys.platform == "darwin":
        # Terminal starts the command in its own environment: the variables go in the command itself.
        script = command.replace("\\", "\\\\").replace('"', '\\"')
        subprocess.Popen(["osascript", "-e", f'tell application "Terminal" to do script "{script}"',
                          "-e", 'tell application "Terminal" to activate'])
        return
    terminal = next((install.which(name) for name in ("x-terminal-emulator", "gnome-terminal", "konsole", "xterm")
                     if install.which(name)), None)
    if not terminal:
        raise OSError("No terminal found.")
    separator = ["--"] if Path(terminal).name == "gnome-terminal" else ["-e"]
    subprocess.Popen([terminal, *separator, "sh", "-c", f'{command}; exec "${{SHELL:-sh}}"'], env=env)


def agent_command(engine: str) -> tuple[list[str], Path, dict[str, str]]:
    """The command, folder and extra environment that start the agent in the workspace with Kavot's tools."""
    from app.mcp import server
    binary = resolve_executable(engine, configuration()[engine]["executable"])
    if not binary:
        raise HTTPException(422, f"{ENGINES[engine]['name']} is not installed. Install it in the settings.")
    connection = server.connection()
    arguments, environment = launch_arguments(engine, connection.url)
    root = settings.storage_path.resolve()
    root.mkdir(parents=True, exist_ok=True)
    return [binary, *arguments], root, {server.TOKEN_ENV: connection.token, **environment}


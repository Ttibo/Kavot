"""Starting an agent in a terminal: the workspace folder, Kavot's tools, the token kept out of the command line."""
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.core.agents import terminal
from app.mcp import server as mcp_server


def test_launch_adds_kavot_to_this_run_only(client, monkeypatch):
    monkeypatch.setattr(terminal, "resolve_executable", lambda engine, configured="": f"/bin/{engine}")
    try:
        argv, cwd, environment = terminal.agent_command("claude")
        connection = mcp_server.connection()
        assert environment[mcp_server.TOKEN_ENV] == connection.token
        assert connection.token not in " ".join(argv)
        assert argv[0] == "/bin/claude" and argv[1].startswith("--mcp-config=")
        config = json.loads(Path(argv[1].split("=", 1)[1]).read_text(encoding="utf-8"))
        assert config["mcpServers"]["kavot"]["url"] == connection.url
        assert connection.token not in json.dumps(config)
        assert Path(cwd) == terminal.settings.storage_path.resolve()

        argv, _, _ = terminal.agent_command("codex")
        assert argv == ["/bin/codex", "-c", f"mcp_servers.kavot.url={connection.url}",
                        "-c", f"mcp_servers.kavot.bearer_token_env_var={mcp_server.TOKEN_ENV}"]
        _, _, environment = terminal.agent_command("opencode")
        assert json.loads(environment["OPENCODE_CONFIG_CONTENT"])["mcp"]["kavot"]["url"] == connection.url
    finally:
        mcp_server.stop()


def test_missing_program_is_explained(client, monkeypatch):
    monkeypatch.setattr(terminal, "resolve_executable", lambda engine, configured="": None)
    with pytest.raises(HTTPException) as error:
        terminal.agent_command("codex")
    assert error.value.status_code == 422 and "not installed" in error.value.detail

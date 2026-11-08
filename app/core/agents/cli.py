"""How a chat request runs each agent CLI: its command line, and how its JSON stream reads.

Kavot's data is changed only through MCP (a proposal, or /auto), never by the CLI
itself: every engine runs with read-only native tools.
"""
from __future__ import annotations

import json
import os
import uuid

from app.core.kernel.user_settings import config_dir
from app.mcp import server as mcp_server

READ_TOOLS = "Read,Glob,Grep,WebSearch,WebFetch"
OPENCODE_READ = {"*": "deny", "read": "allow", "glob": "allow", "grep": "allow", "list": "allow",
                 "webfetch": "allow", "websearch": "allow", "codesearch": "allow"}
# Each model call resends the whole conversation: past this size the CLI summarizes it
# instead of rereading every earlier tool result on each call.
COMPACT_TOKENS = 80_000
# The smallest auto-compact window Claude Code accepts (CLAUDE_CODE_AUTO_COMPACT_WINDOW).
CLAUDE_COMPACT_WINDOW = 100_000
# Label of a streamed fragment of the answer being written (shown live, not kept).
STREAMED = "Texte en cours"


def command(run: dict, binary: str, config: dict, vendor_id: str | None, prompt: str, title: str) -> tuple[list[str], dict]:
    """The CLI command and environment of a request (read-only native tools)."""
    engine = run["engine"]
    model = ["--model", config["model"]] if config["model"] else []
    effort = config.get("effort", "")
    environment = os.environ.copy()
    if engine == "codex":
        options = ["--json", "--skip-git-repo-check"]
        options += ["-c", 'sandbox_mode="read-only"'] if vendor_id else ["--sandbox", "read-only"]
        options += ["-c", 'approval_policy="never"', *(["-c", f'model_reasoning_effort="{effort}"'] if effort else []),
                    "-c", f"model_auto_compact_token_limit={COMPACT_TOKENS}", *model]
        # The prompt goes in on stdin ("-").
        return [binary, "exec", *(["resume", *options, vendor_id] if vendor_id else options), "-"], environment
    if engine == "claude":
        # Claude Code compacts at a share of its window, and the window follows the model (up to 1M
        # tokens: 40% of it never triggered). Fix the window, then the share that gives COMPACT_TOKENS.
        environment.setdefault("CLAUDE_CODE_AUTO_COMPACT_WINDOW", str(CLAUDE_COMPACT_WINDOW))
        window = environment["CLAUDE_CODE_AUTO_COMPACT_WINDOW"]
        window = int(window) if window.isdigit() else CLAUDE_COMPACT_WINDOW
        environment.setdefault("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", str(min(100, COMPACT_TOKENS * 100 // window)))
        # Plan mode refuses every MCP tool not marked read-only, so Kavot's proposal tools would
        # never run: read access relies on --tools instead. The prompt goes in on stdin.
        return [binary, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
                "--permission-mode", "default", *model, *(["--effort", effort] if effort else []),
                *(["--resume", vendor_id] if vendor_id else ["--session-id", str(uuid.uuid4())]),
                "--tools", READ_TOOLS], environment
    environment["OPENCODE_PERMISSION"] = json.dumps(OPENCODE_READ)
    # Windows limits command-line length: OpenCode reads the request from an attached file.
    request_path = config_dir() / f"external-request-{run['id']}.txt"
    request_path.write_text(prompt, encoding="utf-8")
    run["request_path"] = request_path
    # --file is variadic: any positional text after it is treated as another filename.
    return [binary, "run", "--format", "json", "--thinking", "--agent", "plan", *model,
            *(["--variant", effort] if effort else []), *(["--session", vendor_id] if vendor_id else ["--title", title]),
            "Answer the attached Kavot request while following its context and rules.", "--file", str(request_path)], environment


def connect(engine: str, command: list[str], environment: dict, connection) -> list[str]:
    """Add Kavot's MCP server to this CLI launch, without touching the user's CLI configuration."""
    environment[mcp_server.TOKEN_ENV] = connection.token
    if engine == "codex":
        # Leaf overrides so exec/resume receive typed MCP settings, and tool discovery
        # finishes before the model's first turn.
        overrides = [
            "mcp_servers.kavot.url=" + json.dumps(connection.url),
            'mcp_servers.kavot.bearer_token_env_var="' + mcp_server.TOKEN_ENV + '"',
            "mcp_servers.kavot.required=true",
            "mcp_servers.kavot.enabled=true",
            'mcp_servers.kavot.default_tools_approval_mode="approve"',
            "mcp_optional_startup_grace_ms=0",
        ]
        options = [argument for setting in overrides for argument in ("-c", setting)]
        position = 3 if command[2:3] == ["resume"] else 2
        return command[:position] + options + command[position:]
    if engine == "claude":
        config = {"mcpServers": {"kavot": {"type": "http", "url": connection.url,
                  "headers": {"Authorization": "Bearer ${" + mcp_server.TOKEN_ENV + "}"}}}}
        # Non-interactive runs deny every tool not pre-approved, including the
        # native read tools enabled with --tools (WebSearch, WebFetch…).
        native = command[command.index("--tools") + 1].split(",") if "--tools" in command else []
        return command + ["--strict-mcp-config", "--mcp-config", json.dumps(config),
                          "--allowedTools", ",".join([*native, "mcp__kavot__*"])]
    # OpenCode supports environment substitution in inline JSON configuration.
    config = json.loads(environment.get("OPENCODE_CONFIG_CONTENT") or "{}")
    config.setdefault("mcp", {})["kavot"] = {"type": "remote", "url": connection.url,
        "enabled": True, "oauth": False, "headers": {"Authorization": "Bearer {env:" + mcp_server.TOKEN_ENV + "}"}}
    environment["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
    permissions = json.loads(environment["OPENCODE_PERMISSION"])
    permissions["kavot_*"] = "allow"
    environment["OPENCODE_PERMISSION"] = json.dumps(permissions)
    return command


def parse_result(engine: str, output: str) -> tuple[str | None, str]:
    """The CLI session id and the final answer of a request's JSON stream."""
    vendor_id = None
    responses = []
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if engine == "codex":
            if event.get("type") in {"turn.failed", "error"}:
                raise ValueError(str(event.get("error") or event.get("message") or "Codex failed."))
            if event.get("type") == "thread.started":
                vendor_id = event.get("thread_id")
            item = event.get("item") or {}
            if event.get("type") == "item.completed" and item.get("type") == "agent_message" and item.get("text"):
                responses.append(item["text"])
        elif engine == "claude":
            if event.get("type") == "result":
                vendor_id = event.get("session_id")
                if event.get("is_error"):
                    raise ValueError(str(event.get("result") or "Claude Code failed."))
                responses = [str(event.get("result") or "")]
        else:
            if event.get("type") == "error":
                raise ValueError(str(event.get("error") or event.get("part") or "OpenCode failed."))
            vendor_id = event.get("sessionID") or event.get("sessionId") or vendor_id
            part = event.get("part") or {}
            if event.get("type") == "text" and part.get("text"):
                responses.append(part["text"])
    return vendor_id, "\n\n".join(text for text in responses if text).strip()


def _result_text(content) -> str:
    """A tool result's text, whether the CLI gives a string or content blocks."""
    if isinstance(content, list):
        return "\n".join(str(block.get("text") or "") if isinstance(block, dict) else str(block) for block in content)
    return str(content or "")


def activity(engine: str, event: dict, tools: dict | None = None) -> list[tuple[str, str, str]] | None:
    """What a CLI event shows in the thread: [] when it adds nothing, None when it is unknown (kept raw).

    tools maps Claude's tool call ids to their names, so each result says which call it answers.
    """
    kind = str(event.get("type") or "")
    tools = {} if tools is None else tools
    if engine == "codex":
        if kind == "thread.started":
            return [("status", "Session started", "")]
        if kind.startswith("turn."):
            return [("status", kind.replace("turn.", "Step ").replace("_", " "), "")]
        item = event.get("item") or {}
        item_type = str(item.get("type") or "")
        if kind.startswith("item."):
            detail = "\n".join(str(value) for value in (item.get("command"), item.get("aggregated_output"),
                         item.get("text"), item.get("path")) if value)
            if item_type == "agent_message":
                return [("message", "Answer", detail)] if kind == "item.completed" else []
            if item_type == "reasoning":
                return [("thinking", "Reasoning", detail)] if kind == "item.completed" and detail else []
            return [("tool", item_type.replace("_", " ") or "Action", detail)]
    elif engine == "claude":
        if kind == "stream_event":
            partial = event.get("event") or {}
            delta = partial.get("delta") or {}
            if delta.get("type") == "text_delta" and delta.get("text"):
                return [("message", STREAMED, str(delta["text"]))]
            block = partial.get("content_block") or {}
            if partial.get("type") == "content_block_start" and block.get("type") == "tool_use":
                return [("tool", str(block.get("name") or "Outil"), "")]
            # Other fragments (tool input, reasoning) arrive whole in the next assistant event.
            return []
        if kind == "system":
            return [("status", "Session started", "")]
        if kind == "assistant":
            found = []
            for block in (event.get("message") or {}).get("content") or []:
                if block.get("type") == "thinking" and block.get("thinking"):
                    found.append(("thinking", "Reasoning", str(block["thinking"])))
                elif block.get("type") == "text" and block.get("text"):
                    found.append(("message", "Answer", str(block["text"])))
                elif block.get("type") == "tool_use":
                    tools[block.get("id")] = str(block.get("name") or "Outil")
                    found.append(("tool", tools[block.get("id")], json.dumps(block.get("input") or {}, ensure_ascii=False)))
            return found
        if kind == "user":
            content = (event.get("message") or {}).get("content")
            if not isinstance(content, list):
                return []
            return [("error" if block.get("is_error") else "tool",
                     "Tool result · " + tools.get(block.get("tool_use_id"), "tool"), _result_text(block.get("content")))
                    for block in content if isinstance(block, dict) and block.get("type") == "tool_result"]
        if kind == "result":
            return [("status", "Run finished", "")]
    else:
        part = event.get("part") or {}
        if kind == "text" and part.get("text"):
            return [("message", "Answer", str(part["text"]))]
        if kind in {"tool_use", "tool", "step_start", "step_finish", "error"}:
            detail = part.get("state") or part.get("input") or part.get("text") or ""
            return [("error" if kind == "error" else "tool", str(part.get("tool") or kind).replace("_", " "), str(detail))]
    return None


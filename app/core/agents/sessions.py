"""Local CLI bridges for agent conversations: the assistant, the Chat view and the Atelier.

Kavot owns only the conversation list and transcript displayed in its UI. Each
agent keeps its own authentication, model configuration and execution loop.
Every request gets Kavot's MCP tools; a plugin may also give a conversation
folders to read or change (the Atelier gives Git worktrees of a project's code).
"""
from __future__ import annotations

import atexit
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
import copy
import hashlib
from contextlib import contextmanager, ExitStack
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import HTTPException

from app.core import journal
from app.core.kernel.config import settings
from app.core.kernel.plugins import load as load_plugins
from app.core.kernel.user_settings import config_dir, load_integrations, save_integration
from app.core.agents import context as external_agent_context, actions as external_agent_actions
from app.core.agents import mcp_server as agent_mcp, install, digests
from app.core.agents.usage import Meter, add as add_usage
from app.core.agents.workspace import Workspace

ENGINES = {
    "codex": {"name": "Codex", "command": "codex"},
    "claude": {"name": "Claude Code", "command": "claude"},
    "opencode": {"name": "OpenCode", "command": "opencode"},
}
_lock = threading.RLock()
_runs: dict[str, dict] = {}
MODE_RULES = {
    "answer": "\nAnswer without any action or structured proposal. Be concise: no preamble, no restating the request.",
    "propose": "\nMode /edit: use the write tools to prepare changes; the user reviews each proposal.",
    "auto": "\nMode /auto: the user allowed direct changes. The write tools apply immediately; "
            "do exactly what was asked, nothing more, and summarize every applied change at the end.",
}
READ_TOOLS = "Read,Glob,Grep,WebSearch,WebFetch"
OPENCODE_READ = {"*": "deny", "read": "allow", "glob": "allow", "grep": "allow", "list": "allow",
                 "webfetch": "allow", "websearch": "allow", "codesearch": "allow"}
# Each model call resends the whole conversation: past this size the CLI summarizes it
# instead of rereading every earlier tool result on each call.
COMPACT_TOKENS = 80_000
# Selected notes shown in the prompt as level-1 briefs (~100 tokens each); the rest by title.
PROMPT_BRIEFS = 12
# Kinds of events kept with each answer, so a reopened conversation shows what the agent did.
KEPT_EVENTS = {"message", "tool", "thinking", "error", "write", "proposal"}
KEPT_DETAIL = 4000


def _stop_running() -> None:
    for run in _runs.values():
        if run["status"] != "running":
            continue
        run["status"] = "cancelled"
        process = run.get("process")
        if process:
            try:
                process.terminate()
            except OSError:
                pass
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    process.kill()
                except OSError:
                    pass


def shutdown() -> None:
    with _lock:
        _stop_running()


@contextmanager
def workspace_change():
    with _lock:
        _stop_running()
        yield


atexit.register(shutdown)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resolve_executable(engine: str, configured: str = "") -> str | None:
    candidate = configured.strip() or install.which(ENGINES[engine]["command"])
    if not candidate:
        return None
    path = Path(candidate).expanduser()
    # The npm Windows shim is a batch file. Run its native executable directly
    # so user prompts never pass through cmd.exe expansion.
    if engine == "opencode" and sys.platform == "win32" and path.suffix.lower() in {".cmd", ".ps1"}:
        native = path.parent / "node_modules" / "opencode-ai" / "bin" / "opencode.exe"
        if native.is_file():
            path = native
    if sys.platform == "win32" and path.suffix.lower() in {".cmd", ".bat", ".ps1"}:
        return None
    if not path.is_file():
        found = shutil.which(str(path))
        if not found:
            return None
        path = Path(found)
    return str(path.resolve())


def configuration() -> dict:
    stored = load_integrations().get("external_agents") or {}
    return {engine: {
        "enabled": bool(stored.get(engine, {}).get("enabled", False)),
        "executable": str(stored.get(engine, {}).get("executable", "")),
        "model": str(stored.get(engine, {}).get("model", "")),
        "effort": str(stored.get(engine, {}).get("effort", "")),
        # A lighter model and effort for questions (/answer), and the model that writes note summaries in the background.
        "answer_model": str(stored.get(engine, {}).get("answer_model", "")),
        "answer_effort": str(stored.get(engine, {}).get("answer_effort", "")),
        "digest_model": str(stored.get(engine, {}).get("digest_model", "")),
        "access": stored.get(engine, {}).get("access", "read"),
    } for engine in ENGINES}


def public_settings() -> dict:
    config = configuration()
    return {"engines": [{
        "id": engine, "name": meta["name"], **config[engine],
        "detected_path": _resolve_executable(engine, config[engine]["executable"]),
    } for engine, meta in ENGINES.items()]}


def configure(updates: dict) -> dict:
    with _lock:
        config = configuration()
        for engine, update in updates.items():
            if engine not in ENGINES:
                raise HTTPException(422, "Moteur agentique inconnu.")
            config[engine].update(update)
        save_integration("external_agents", config)
        return public_settings()


def check(engine: str, executable: str = "") -> dict:
    if engine not in ENGINES:
        raise HTTPException(404, "Moteur agentique inconnu.")
    binary = _resolve_executable(engine, executable or configuration()[engine]["executable"])
    if not binary:
        raise HTTPException(422, "Program not found. Give the path to its executable.")
    try:
        result = subprocess.run([binary, "--version"], capture_output=True, text=True,
                                timeout=10, encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise HTTPException(502, f"Unable to start {ENGINES[engine]['name']} : {error}") from None
    if result.returncode:
        raise HTTPException(502, (result.stderr or result.stdout or "The program failed.")[-600:])
    return {"path": binary, "version": result.stdout.strip().splitlines()[-1] if result.stdout.strip() else "Detected"}


def _sessions_file() -> Path:
    return config_dir() / "external-agent-sessions.json"


def _read_sessions() -> list[dict]:
    try:
        value = json.loads(_sessions_file().read_text(encoding="utf-8"))
        return value if isinstance(value, list) else []
    except (OSError, ValueError):
        return []


def _write_sessions(sessions: list[dict]) -> None:
    target = _sessions_file()
    temporary = None
    try:
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(sessions, handle, ensure_ascii=False, indent=2)
        os.replace(temporary, target)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def _session(sessions: list[dict], session_id: str) -> dict:
    root = str(settings.storage_path.resolve())
    for session in sessions:
        if session.get("id") == session_id and session.get("workspace") == root:
            return session
    raise HTTPException(404, "Session not found in this workspace.")


def _public_session(session: dict) -> dict:
    active = next((run["id"] for run in _runs.values()
                   if run["session_id"] == session["id"] and run["status"] == "running"), None)
    return {key: value for key, value in session.items() if key != "workspace"} | {"active_run_id": active}


def _summary(session: dict) -> dict:
    """A conversation in a list: everything but its transcript."""
    public = _public_session(session)
    last = (session.get("last_run") or {})
    return {key: value for key, value in public.items() if key not in {"messages", "last_run"}} | {
        "message_count": len(session.get("messages") or []), "last_status": last.get("status")}


def list_sessions(engine: str | None = None, project_id: int | None = None) -> list[dict]:
    """The user's conversations, newest first; watchers' and other internal sessions are left out."""
    if engine is not None and engine not in ENGINES:
        raise HTTPException(404, "Moteur agentique inconnu.")
    with _lock:
        return sorted((_summary(s) for s in _read_sessions()
                       if (engine is None or s.get("engine") == engine) and not s.get("watcher_id") and not s.get("purpose")
                       and (project_id is None or s.get("project_id") == project_id)
                       and s.get("workspace") == str(settings.storage_path.resolve())),
                      key=lambda s: s["updated_at"], reverse=True)


def get_session(session_id: str) -> dict:
    with _lock:
        return _public_session(_session(_read_sessions(), session_id))


@contextmanager
def editing(session_id: str):
    """A stored conversation to change in place (plugins use it for their part of it); saved on exit."""
    with _lock:
        sessions = _read_sessions()
        session = _session(sessions, session_id)
        yield session
        session["updated_at"] = _now()
        _write_sessions(sessions)


def running(session_id: str) -> bool:
    with _lock:
        return any(run["session_id"] == session_id and run["status"] == "running" for run in _runs.values())


def active_runs() -> list[dict]:
    """Requests running now, with the workspace each one got."""
    with _lock:
        return [run for run in _runs.values() if run["status"] == "running"]


def _home(session: dict) -> Path:
    """The folder a new conversation's CLI starts in: its own, empty, so nothing is read or written by accident."""
    return config_dir() / "agent-conversations" / session["id"]


def _conversation_instructions(session: dict, cwd: str) -> None:
    """Write Kavot's standing policy where the CLI reads it once (AGENTS.md / CLAUDE.md / .opencode rules).

    Keeping it out of the user prompt avoids resending ~900 tokens in every message
    of a resumed conversation, and lets the provider cache the file read.
    """
    home = Path(cwd)
    if home != _home(session) or home.resolve() == settings.storage_path.resolve():
        return  # A resumed conversation runs where it was started: never add files there.
    home.mkdir(parents=True, exist_ok=True)
    rules = external_agent_context.POLICY
    # Codex copies an MCP server's instructions into every tool description, so a
    # tool listing would repeat them dozens of times: its tool rules live here instead.
    if session["engine"] == "codex" and (session.get("tool_rules_in_agents") or not session.get("vendor_session_id")):
        session["tool_rules_in_agents"] = True
        rules += "\n" + agent_mcp.INSTRUCTIONS
    (home / "AGENTS.md").write_text(rules + "\n", encoding="utf-8")
    (home / "CLAUDE.md").write_text("Read AGENTS.md.\n" + external_agent_context.POLICY + "\n", encoding="utf-8")


def rename_session(session_id: str, title: str) -> dict:
    with editing(session_id) as session:
        session["title"] = title.strip()[:120] or session["title"]
        return _public_session(session)


def delete_session(session_id: str) -> None:
    """Remove a conversation; a plugin may refuse while it holds work to review (open worktrees)."""
    with _lock:
        sessions = _read_sessions()
        session = _session(sessions, session_id)
        if running(session_id):
            raise HTTPException(409, "Stop the agent first.")
        for provider in load_plugins().agent_workspaces:
            provider.forget(session)
        _write_sessions([item for item in sessions if item is not session])
        if session.get("cwd") and Path(session["cwd"]) == _home(session):
            shutil.rmtree(session["cwd"], ignore_errors=True)
        for run_id in [key for key, run in _runs.items() if run["session_id"] == session_id]:
            _runs.pop(run_id, None)


def create_session(engine: str, vendor_session_id: str | None = None, watcher_id: int | None = None,
                   purpose: str | None = None, project_id: int | None = None) -> dict:
    if engine not in ENGINES:
        raise HTTPException(404, "Moteur agentique inconnu.")
    with _lock:
        config = configuration()[engine]
        if not config["enabled"]:
            raise HTTPException(409, "Enable this engine in Settings → AI and agents.")
        if vendor_session_id:
            if engine in {"codex", "claude"}:
                try:
                    vendor_session_id = str(uuid.UUID(vendor_session_id))
                except ValueError:
                    raise HTTPException(422, "Invalid session ID.") from None
            elif not vendor_session_id.startswith("ses_") or not vendor_session_id[4:].replace("_", "").isalnum():
                raise HTTPException(422, "Invalid OpenCode session ID.")
        session = {"id": str(uuid.uuid4()), "engine": engine,
                   "title": f"Session {vendor_session_id[:12]}" if vendor_session_id else "New session",
                   "workspace": str(settings.storage_path.resolve()), "vendor_session_id": vendor_session_id,
                   "messages": [], "model": config["model"], "effort": config["effort"],
                   "created_at": _now(), "updated_at": _now(), "usage": {}, "usage_history": [],
                   **({"project_id": int(project_id)} if project_id else {}),
                   **({"watcher_id": watcher_id} if watcher_id is not None else {}),
                   **({"purpose": purpose} if purpose else {})}
        # The CLI keeps its sessions per folder: chosen at the first message (see _workspace).
        # A resumed CLI session lives where it was started; Kavot used to start them in the workspace.
        session["cwd"] = str(settings.storage_path.resolve()) if vendor_session_id else None
        sessions = _read_sessions()
        sessions.append(session)
        _write_sessions(sessions)
        return _public_session(session)


def _command(engine: str, binary: str, config: dict, vendor_id: str | None, prompt: str, title: str) -> list[str]:
    model = ["--model", config["model"]] if config["model"] else []
    effort = config.get("effort", "")
    if engine == "codex":
        base = [binary, "exec"]
        reasoning = ["-c", f'model_reasoning_effort="{effort}"'] if effort else []
        reasoning += ["-c", f"model_auto_compact_token_limit={COMPACT_TOKENS}"]
        if vendor_id:
            base += ["resume", "--json", "--skip-git-repo-check", "-c",
                     f'sandbox_mode="{"workspace-write" if config["access"] == "write" else "read-only"}"',
                     "-c", 'approval_policy="never"', *reasoning, *model, vendor_id, "-"]
        else:
            base += ["--json", "--skip-git-repo-check", "--sandbox",
                     "workspace-write" if config["access"] == "write" else "read-only",
                     "-c", 'approval_policy="never"', *reasoning, *model, "-"]
        return base
    if engine == "claude":
        # Plan mode refuses every MCP tool not marked read-only, so Kavot's
        # proposal tools would never run. Read access relies on --tools instead.
        return [binary, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode",
                "acceptEdits" if config["access"] == "write" else "default", *model,
                *(["--effort", effort] if effort else []),
                *( ["--resume", vendor_id] if vendor_id else ["--session-id", str(uuid.uuid4())] ), prompt]
    return [binary, "run", "--format", "json", "--thinking", "--agent", "build" if config["access"] == "write" else "plan",
            *( ["--auto"] if config["access"] == "write" else [] ), *model,
            *(["--variant", effort] if effort else []),
            *( ["--session", vendor_id] if vendor_id else ["--title", title] ), prompt]


def _parse_result(engine: str, output: str) -> tuple[str | None, str]:
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


def _activity(engine: str, event: dict, tools: dict | None = None) -> list[tuple[str, str, str]] | None:
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
                return [("message", "Texte en cours", str(delta["text"]))]
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


def _append_event(run: dict, kind: str, label: str, detail: str = "") -> None:
    with _lock:
        token = run.get("mcp_token")
        if token:
            label, detail = label.replace(token, "[secret]"), detail.replace(token, "[secret]")
        run["event_seq"] += 1
        run["events"].append({"id": run["event_seq"], "kind": kind,
                              "label": label[:160], "detail": detail[:6000], "at": _now()})
        if len(run["events"]) > 500:
            # Unknown raw events go first, so the agent's own steps are kept.
            raw = next((index for index, item in enumerate(run["events"]) if item["kind"] == "raw"), 0)
            del run["events"][raw]


def _cli_command(run: dict, binary: str, config: dict, vendor_id: str | None, prompt: str, title: str,
                 space: Workspace) -> tuple[list[str], dict]:
    """The CLI command: read tools everywhere, file edits only inside the workspace's writable folders."""
    engine = run["engine"]
    write = space.write and bool(space.writable)
    command = _command(engine, binary, {**config, "access": "write" if write else "read"}, vendor_id,
                       "" if engine in {"codex", "claude"} else prompt, title)
    environment = os.environ.copy()
    others = [path for path in dict.fromkeys([*space.writable, *space.readable]) if path != space.cwd]
    if engine == "claude":
        # Claude Code compacts at a share of its context window (200k tokens).
        environment.setdefault("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", str(COMPACT_TOKENS * 100 // 200_000))
        tools = READ_TOOLS + (",Edit,Write" if write else "")
        command = command[:-1] + ["--tools", tools] + [part for path in others for part in ("--add-dir", path)]
    elif engine == "codex":
        writable = [path for path in space.writable if path != space.cwd]
        if write and writable:
            position = command.index(vendor_id) if vendor_id and vendor_id in command else len(command) - 1
            command[position:position] = ["-c", f"sandbox_workspace_write.writable_roots={json.dumps(writable)}"]
    else:
        permission = {**OPENCODE_READ, **({"edit": "allow"} if write else {}), **({"external_directory": "allow"} if others else {})}
        environment["OPENCODE_PERMISSION"] = json.dumps(permission)
        # Windows limits command-line length. OpenCode reads the frozen
        # request attachment, while Codex and Claude receive it on stdin.
        request_path = config_dir() / f"external-request-{run['id']}.txt"
        request_path.write_text(prompt, encoding="utf-8")
        # --file is variadic: any positional text after it is treated as
        # another filename. Keep the message before the attachment flag.
        command[-1:] = ["Answer the attached Kavot request while following its context and rules.", "--file", str(request_path)]
        run["request_path"] = request_path
    return command, environment


def _execute(run: dict, prompt: str, config: dict, vendor_id: str | None, title: str) -> None:
    engine = run["engine"]
    space: Workspace = run["space"]
    connections = ExitStack()
    meter, started = Meter(engine, run.get("usage_baseline") if vendor_id else None), time.monotonic()
    # The run stays "running" until its answer is saved on the conversation: a view that sees it
    # finished and reloads the conversation then always finds the answer there.
    outcome = None
    try:
        binary = _resolve_executable(engine, config["executable"])
        if not binary:
            raise ValueError("Program not found. Check its path in the settings.")
        # Kavot's data is changed only through MCP (a proposal, or /auto), never by
        # the CLI itself; the CLI edits files only in the folders a plugin gave it.
        command, environment = _cli_command(run, binary, config, vendor_id, prompt, title, space)
        connection = connections.enter_context(agent_mcp.serve_run(run, _lock, _append_event))
        command = agent_mcp.configure_client(engine, command, environment, connection)
        Path(space.cwd).mkdir(parents=True, exist_ok=True)
        with _lock:
            if run["status"] == "cancelled":
                return
            process = subprocess.Popen(command, cwd=space.cwd, stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                       encoding="utf-8", errors="replace", env=environment,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            run["process"] = process
        watchdog = None
        if run.get("timeout"):
            def expire() -> None:
                run["timed_out"] = True
                try:
                    process.terminate()
                except OSError:
                    pass
            watchdog = threading.Timer(run["timeout"], expire)
            watchdog.daemon = True
            watchdog.start()
        _append_event(run, "tool", "Request sent", prompt)
        if engine in {"codex", "claude"} and process.stdin:
            process.stdin.write(prompt)
            process.stdin.close()
        elif process.stdin:
            process.stdin.close()
        stderr_chunks: list[str] = []
        def read_errors() -> None:
            for line in process.stderr:
                stderr_chunks.append(line)
                if line.strip():
                    _append_event(run, "log", "Sortie de l'outil", line.strip())
        stderr_reader = threading.Thread(target=read_errors, daemon=True)
        stderr_reader.start()
        output: list[str] = []
        tool_names: dict = {}
        for line in process.stdout:
            output.append(line)
            try:
                event = json.loads(line)
            except ValueError:
                continue
            calls = len(meter.messages)
            if meter.feed(event):
                with _lock:
                    run["usage"] = meter.value()
                if len(meter.messages) > calls:
                    # Each model call rereads the whole conversation: show what this one read.
                    usage = list(meter.messages.values())[-1]
                    read = sum(usage.get(key) or 0 for key in ("input", "cache_read", "cache_write"))
                    cached = round(100 * (usage.get("cache_read") or 0) / read) if read else 0
                    _append_event(run, "tool", "Model call", f"call {len(meter.messages)} · {read:,} tokens read · {cached}% from cache")
            activities = _activity(engine, event, tool_names) if isinstance(event, dict) else []
            if activities is None:
                _append_event(run, "raw", str(event.get("type") or "Event"), json.dumps(event, ensure_ascii=False))
            for activity in activities or []:
                if activity[0] == "message" and activity[1] == "Texte en cours":
                    # Streamed text of the current answer, shown live until the full message arrives.
                    with _lock:
                        run["draft"] = ((run.get("draft") or "") + activity[2])[-20_000:]
                    continue
                if activity[0] == "message":
                    with _lock:
                        run["draft"] = ""
                _append_event(run, *activity)
        process.wait()
        if watchdog:
            watchdog.cancel()
        stderr_reader.join(timeout=2)
        if run["status"] == "cancelled":
            return
        if run.get("timed_out"):
            raise ValueError(f"The agent exceeded its time limit ({run['timeout'] // 60} min) and was stopped.")
        parsed_id, answer = _parse_result(engine, "".join(output))
        if process.returncode:
            raise ValueError(("".join(stderr_chunks) or answer or "The engine failed.").strip()[-1200:])
        if not parsed_id:
            raise ValueError("The engine did not return a session ID; it cannot be resumed.")
        answer = answer.replace(connection.token, "[secret]")
        answer, proposals, proposal_errors = external_agent_actions.parse(answer, run)
        if run.get("mode") == "answer":
            if proposals:
                proposal_errors.append("Switch to /edit to prepare these changes.")
            proposals = []
        with _lock:
            # Keep proposals submitted through MCP. Legacy blocks are accepted
            # for resumed conversations, with the same scope checks and limit.
            for proposal in proposals:
                try:
                    agent_mcp._check_scope(proposal["action"], run)
                    if any(p["action"] == proposal["action"] for p in run["proposals"]):
                        continue
                    if len(run["proposals"]) >= 30:
                        raise ValueError("At most 30 proposals per request.")
                    run["proposals"].append(proposal)
                    _append_event(run, "proposal", "Proposed change", proposal["label"] + " — " + proposal["target"])
                except ValueError as error:
                    proposal_errors.append(str(error))
            run.update(response=answer or "Review the proposals below.", proposal_errors=proposal_errors, vendor_id=parsed_id)
            outcome = "completed"
            for error in proposal_errors:
                _append_event(run, "error", "Proposal cannot be applied", error)
            _append_event(run, "status", "Done")
    except Exception as error:
        with _lock:
            if run["status"] != "cancelled":
                message = str(error)
                if run.get("mcp_token"):
                    message = message.replace(run["mcp_token"], "[secret]")
                run.update(error=message)
                outcome = "failed"
                _append_event(run, "error", "Error", message)
    finally:
        connections.close()
        with _lock:
            run.pop("process", None)
            request_path = run.pop("request_path", None)
            if request_path:
                request_path.unlink(missing_ok=True)
            if run["status"] == "running":  # Without an outcome: stopped before the CLI started.
                run["status"] = outcome or "cancelled"
            usage = meter.value()
            if not usage.get("duration_ms"):
                usage["duration_ms"] = int((time.monotonic() - started) * 1000)
            run.update(usage=usage, draft="")
            if meter.cumulative:
                run["thread_usage"] = meter.cumulative
            _record(run, usage)
        on_finish = run.pop("on_finish", None)
        if on_finish:
            try:
                on_finish(_public_run(run, full=True))
            except Exception as error:  # A watcher bookkeeping failure must not hide the run result.
                _append_event(run, "error", "Watcher update failed", str(error))


def _source_line(item: dict, brief: bool) -> str:
    """A selected source in the prompt: a note as its level-1 brief, so the agent opens it only if needed."""
    if brief and item.get("kind") == "note" and item.get("note_id"):
        from app.core.digest import levels
        try:
            return f"- {item['id']}: " + levels.line(levels.brief(item["note_id"]))
        except (ValueError, OSError):
            pass  # Not indexed yet: the title and path still name it.
    return f"- {item['id']}: {item['title']} — {item['path']}"


def _context_version(snapshot: dict) -> tuple[str, dict[str, str]]:
    """Short fingerprints of what get_context returns and of each selected source's text.

    A resumed conversation already holds what it read: when nothing changed, the prompt
    says so and the agent does not reload the context, the guides or the sources.
    """
    def digest(value) -> str:
        return hashlib.sha1(json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:10]
    context = agent_mcp.compact_context(snapshot)
    sources = {source["id"]: digest([source.get("text"), source.get("pages")]) for source in snapshot.get("sources", [])}
    return digest([context, sources, agent_mcp.INSTRUCTIONS]), sources


def run_model(config: dict, session: dict, mode: str) -> dict:
    """The model and effort of one request: the conversation's, or for a question (/answer) the lighter ones
    when the conversation keeps the engine's default model."""
    chosen = {"model": session.get("model", config["model"]), "effort": session.get("effort", config["effort"])}
    if mode == "answer" and chosen["model"] in {"", config["model"]}:
        if config.get("answer_model"):
            return {"model": config["answer_model"], "effort": config.get("answer_effort", "")}
        if config.get("answer_effort") and chosen["effort"] in {"", config["effort"]}:
            chosen["effort"] = config["answer_effort"]
    return chosen


def _thread_usage(session: dict) -> dict:
    """The running total the engine reported after the previous message, which the next total includes.

    Codex reports its thread's tokens, Claude Code its session's cost.
    """
    if session.get("engine") not in {"codex", "claude"}:
        return {}
    if session.get("thread_usage"):
        return session["thread_usage"]
    # Conversations metered before the fix stored that running total as each message's usage.
    last = (session.get("usage_history") or [{}])[-1]
    keys = ("input", "cache_read", "output", "reasoning") if session["engine"] == "codex" else ("cost_usd",)
    return {key: last.get(key) or 0 for key in keys}


def _record(run: dict, usage: dict) -> None:
    """Save a finished request on its conversation: the answer with what the agent did, and what it cost."""
    sessions = _read_sessions()
    session = next((item for item in sessions if item["id"] == run["session_id"] and item.get("workspace") == run["workspace"]), None)
    if session is None:  # Deleted while it ran.
        return
    if run.get("vendor_id"):
        session["vendor_session_id"] = run["vendor_id"]
    events = [{**event, "detail": event["detail"][:KEPT_DETAIL]} for event in run["events"] if event["kind"] in KEPT_EVENTS][-300:]
    message = {"role": "assistant", "content": run.get("response") or "", "at": _now(), "run_id": run["id"], "events": events,
               "mode": run.get("mode"), **({"proposals": copy.deepcopy(run["proposals"])} if run.get("proposals") else {})}
    if run["status"] != "completed":
        message.update(status=run["status"], error=run.get("error") or ("Stopped." if run["status"] == "cancelled" else ""))
    session["messages"].append(message)
    prompt = next((item["content"] for item in reversed(session["messages"]) if item["role"] == "user"), "")
    if run.get("thread_usage"):
        session["thread_usage"] = run["thread_usage"]
    session["usage"] = add_usage(session.get("usage") or {}, usage)
    session.setdefault("usage_history", []).append({"at": _now(), "prompt": prompt[:120], "run_id": run["id"], **usage})
    del session["usage_history"][:-200]
    for provider in load_plugins().agent_workspaces:
        try:
            provider.finish(session, run)
        except Exception as error:  # The answer is kept even if a plugin cannot read its folders.
            _append_event(run, "error", "Unable to read the changes", str(getattr(error, "detail", error)))
    session["updated_at"] = _now()
    session["last_run"] = _public_run(run, full=True)
    _write_sessions(sessions)


def focus_lines(focus) -> list[str]:
    """What the user picked in the chat (project, notes, articles, folders, collection), with addresses to explore."""
    return [f"- {item.get('kind', 'item')}: {str(item.get('title') or '')[:120]}"
            + (f" ({item['count']} items)" if item.get("count") else "") + (f" — {item['ref']}" if item.get("ref") else "")
            for item in (focus or [])[:20] if isinstance(item, dict)]


def _workspace(session: dict, mode: str, root: Path) -> Workspace:
    """Where this request runs: the folders a plugin gives the conversation, in the conversation's own folder."""
    space = next((found for provider in load_plugins().agent_workspaces if (found := provider.launch(session, mode))), None)
    # The CLI keeps its sessions per folder: a conversation always runs in the one of its first message,
    # its main worktree when it starts with code. Conversations older than this ran in the workspace.
    if "cwd" not in session:
        session["cwd"] = str(root)
    elif not session["cwd"]:
        session["cwd"] = (space.cwd if space else "") or str(_home(session))
    space = space or Workspace(cwd=session["cwd"])
    space.cwd = cwd = session["cwd"]
    if space.write and Path(cwd).resolve() == root:
        raise HTTPException(409, "This conversation started in the Kavot workspace: start a new conversation to give it code to change.")
    return space


def start_message(session_id: str, prompt: str, context: dict | None = None,
                  model: str | None = None, effort: str | None = None, mode: str = "answer", *,
                  fresh: bool = False, timeout: int | None = None, on_finish=None,
                  instructions: str = "") -> dict:
    with _lock:
        sessions = _read_sessions()
        session = _session(sessions, session_id)
        if any(run["session_id"] == session_id and run["status"] == "running" for run in _runs.values()):
            raise HTTPException(409, "This session is already running a request.")
        engine = session["engine"]
        config = configuration()[engine]
        if not config["enabled"]:
            raise HTTPException(409, "This engine is disabled in the settings.")
        root = settings.storage_path.resolve()
        root.mkdir(parents=True, exist_ok=True)
        context = dict(context or {})
        if session.get("project_id") and not context.get("project_id"):
            context["project_id"] = session["project_id"]
        # Plugins attach what the user picked for them (code to change, folders to read) before the context is frozen.
        for provider in load_plugins().agent_workspaces:
            provider.prepare(session, context, mode)
        snapshot, resources, target = external_agent_context.prepare(context, prompt)
        space = _workspace(session, mode, root)
        _conversation_instructions(session, space.cwd)
        if model is not None:
            session["model"] = model.strip()
        if effort is not None:
            session["effort"] = effort.strip()
        config = {**config, **run_model(config, session, mode)}
        resumed = bool(session["vendor_session_id"]) and not fresh
        version, sources = _context_version(snapshot)
        seen = session.get("source_versions") or {} if resumed else {}
        # An unchanged source was already briefed in an earlier message of this conversation.
        unchanged = {item["id"] for item in resources if item["id"] in sources and seen.get(item["id"]) == sources[item["id"]]}
        detail = [_source_line(item, brief=index < PROMPT_BRIEFS and item["id"] not in unchanged) +
                  (" (unchanged since a previous message: reuse its brief and what you read)" if item["id"] in unchanged else "")
                  for index, item in enumerate(resources)]
        # Briefed notes without a current summary get one in the background, for the next messages.
        digests.queue(*[f"kavot://notes/{item['note_id']}" for item in resources[:PROMPT_BRIEFS]
                        if item.get("kind") == "note" and item.get("note_id")])
        if not resumed:
            freshness = ""
        elif session.get("context_version") == version:
            freshness = ("Context " + version + ": unchanged since your previous message. Reuse the context, guides, tool "
                         "list and sources already read in this conversation; call them again only if they are no longer in your context.\n")
        else:
            freshness = "Context " + version + ": changed since your previous message; call get_context once.\n"
        session.update(context_version=version, source_versions={**seen, **sources})
        focus = focus_lines(snapshot.get("focus"))
        explicit_target = bool(context.get("target_note_id") and str(context.get("target_note_id")) != str(context.get("note_id") or ""))
        target_label = "Note cible choisie" if explicit_target else "Default open note"
        target_instruction = (f"{target_label} : {target['title']} — {target['path']}. "
                              "If the request explicitly names another note, use that other note. "
                              "Otherwise, use this target note.\n" if target else "")
        # Relative dates ("next Monday") in tasks and events need the user's local date.
        today = datetime.now().astimezone().strftime("%A %Y-%m-%d %H:%M (UTC%z)")
        # The MCP server already carries agent_mcp.INSTRUCTIONS as its system
        # instructions; repeating them in every user message costs tokens on each
        # turn of a resumed conversation. The policy lives in the conversation
        # folder's AGENTS.md/CLAUDE.md (read once, then cached by the provider).
        full_prompt = ("Mode : " + mode + "\nToday : " + today + "\nWorkspace Kavot : " + str(root) + "\n" + freshness + target_instruction +
                       ("Context chosen by the user for this conversation:\n" + "\n".join(focus) + "\n" if focus else "") +
                       ("Selected sources, as level-1 briefs (deeper: get_note(id, level=2|3), or read_source):\n" + "\n".join(detail) + "\n" if detail else "") +
                       ("\n" + "\n".join(space.brief) + "\n" if space.brief else "") +
                       MODE_RULES[mode] + instructions +
                       "\nDemande :\n" + prompt)
        if not session["messages"]:
            session["title"] = prompt[:64]
        scope = {key: copy.deepcopy(value) for key, value in snapshot.items() if key not in {"sources", "records", "note_catalog", "canvas", "citation_graph"}}
        session["messages"].append({"role": "user", "content": prompt, "context": scope, "at": _now(), "mode": mode})
        session["updated_at"] = _now()
        _write_sessions(sessions)
        run = {"id": str(uuid.uuid4()), "session_id": session_id, "engine": engine,
               "workspace": str(root), "status": "running", "response": None, "error": None,
               "events": [], "event_seq": 0, "resources": resources, "model": config["model"], "effort": config["effort"],
               "context": snapshot, "scope": scope, "mode": mode, "proposals": [], "modified_files": [],
               "baseline": external_agent_actions.baseline(snapshot), "space": space, "draft": "", "usage": {},
               "usage_baseline": _thread_usage(session), "tool_rules_in_agents": bool(session.get("tool_rules_in_agents")), "started_at": _now()}
        _runs[run["id"]] = run
        if timeout or space.timeout:
            run["timeout"] = timeout or space.timeout
        if on_finish:
            run["on_finish"] = on_finish
        vendor_id = None if fresh else session["vendor_session_id"]
        threading.Thread(target=_execute, args=(run, full_prompt, config, vendor_id, session["title"]),
                         daemon=True, name=f"kavot-{engine}-run").start()
        return _public_run(run)


def _public_run(run: dict, *, full: bool = False) -> dict:
    # Polled every ~1 s while the run lasts: the default keeps the payload small
    # (the complete transcript is stored on the session when the run ends).
    events = run.get("events") or []
    if not full:
        events = events[-40:] if len(events) > 40 else events
        events = [{**event, "detail": event.get("detail", "")[:600]} for event in events]
    public = copy.deepcopy({key: run.get(key) for key in
              ("id", "session_id", "status", "response", "error", "resources", "model", "effort", "scope", "mode",
               "proposals", "proposal_errors", "modified_files", "draft", "usage", "started_at")})
    public["events"] = events
    if run.get("mcp_token") and public.get("draft"):
        public["draft"] = public["draft"].replace(run["mcp_token"], "[secret]")
    return public


def get_run(run_id: str) -> dict:
    with _lock:
        run = _runs.get(run_id)
        if not run:
            for session in _read_sessions():
                if session.get("workspace") != str(settings.storage_path.resolve()):
                    continue
                saved = session.get("last_run") or {}
                if saved.get("id") != run_id:
                    # An earlier answer of the conversation: its proposals stay reviewable.
                    answer = next((m for m in session.get("messages") or [] if m.get("run_id") == run_id), None)
                    if not answer:
                        continue
                    saved = {"id": run_id, "session_id": session["id"], "status": answer.get("status") or "completed",
                             "response": answer.get("content"), "error": answer.get("error"), "events": answer.get("events") or [],
                             "mode": answer.get("mode"), "proposals": answer.get("proposals") or [], "usage": {}}
                run = {**saved, "workspace": session["workspace"], "engine": session["engine"],
                       "event_seq": max((e["id"] for e in saved.get("events", [])), default=0)}
                _runs[run_id] = run
                break
        if not run or run["workspace"] != str(settings.storage_path.resolve()):
            raise HTTPException(404, "Run not found.")
        return _public_run(run)


def decide_proposal(run_id: str, proposal_id: str, decision: str) -> dict:
    with _lock:
        get_run(run_id)
        run = _runs[run_id]
        if run["status"] != "completed":
            raise HTTPException(409, "Wait for the answer to finish.")
        proposal = next((p for p in run.get("proposals", []) if p["proposal_id"] == proposal_id), None)
        if not proposal:
            raise HTTPException(404, "Proposition introuvable.")
        if decision == "apply":
            config = configuration()[run["engine"]]
            if not config["enabled"]:
                raise HTTPException(409, "This assistant is disabled in the settings.")
            if run.get("mode") not in {"propose", "auto"}:
                raise HTTPException(409, "This request is in /plan. Switch to /edit and send your request to prepare a change.")
            # A request in /auto changes the data as it runs; other requests only read it or change code.
            if any(r["status"] == "running" and r["workspace"] == run["workspace"] and r.get("mode") == "auto" for r in _runs.values()):
                raise HTTPException(409, "Wait for the running /auto requests to finish before applying a proposal.")
            if proposal["status"] != "applied":
                before_files = _artifact_versions()
                with journal.author("agent", run=run_id, approved_by="user"):
                    result = external_agent_actions.apply(proposal)
                proposal.update(status="applied", result=result)
                after_files = _artifact_versions()
                changed = [path for path in before_files.keys() | after_files.keys() if before_files.get(path) != after_files.get(path)]
                run["modified_files"] = sorted(set(run.get("modified_files", [])) | set(changed))
                from app.core.storage.cloud_sync.routes import notify_local_change
                notify_local_change()
                _append_event(run, "write", "Change applied", proposal["label"] + " — " + proposal["target"])
        elif proposal["status"] == "pending":
            proposal["status"] = "dismissed"
        sessions = _read_sessions()
        session = _session(sessions, run["session_id"])
        if (session.get("last_run") or {}).get("id") == run_id:
            session["last_run"] = _public_run(run, full=True)
        for message in session["messages"]:
            if message.get("run_id") == run_id:
                message["proposals"] = copy.deepcopy(run["proposals"])
        _write_sessions(sessions)
        return _public_run(run)


def _artifact_versions() -> dict:
    root = settings.storage_path.resolve()
    paths = [root / "kavot.state.json"]
    for name in ("notes", "projects", "library", "databases"):
        paths.extend(path for path in (root / name).rglob("*") if path.suffix in {".md", ".html", ".json", ".canvas"})
    return {path.relative_to(root).as_posix(): (path.stat().st_mtime_ns, path.stat().st_size)
            for path in paths if path.is_file() and path.resolve().is_relative_to(root)}


def cancel_run(run_id: str) -> dict:
    with _lock:
        run = _runs.get(run_id)
        if not run or run["workspace"] != str(settings.storage_path.resolve()):
            raise HTTPException(404, "Run not found.")
        if run["status"] == "running":
            run["status"] = "cancelled"
            process = run.get("process")
            if process:
                process.terminate()
        return _public_run(run)

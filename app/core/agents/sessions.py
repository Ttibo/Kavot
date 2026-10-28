"""Local CLI bridges for external agent sessions.

Kavot owns only the session picker and transcript displayed in its UI. Each
agent keeps its own authentication, model configuration and execution loop.
"""
from __future__ import annotations

import atexit
import json
import os
import shutil
import subprocess
import sys
import threading
import uuid
import copy
from contextlib import contextmanager, ExitStack
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import HTTPException

from app.core import journal
from app.core.kernel.config import settings
from app.core.kernel.user_settings import config_dir, load_integrations, save_integration
from app.core.agents import context as external_agent_context, actions as external_agent_actions
from app.core.agents import mcp_server as agent_mcp, install

ENGINES = {
    "codex": {"name": "Codex", "command": "codex"},
    "claude": {"name": "Claude Code", "command": "claude"},
    "opencode": {"name": "OpenCode", "command": "opencode"},
}
_lock = threading.RLock()
_runs: dict[str, dict] = {}
MODE_RULES = {
    "answer": "\nAnswer without any action or structured proposal.",
    "propose": "\nMode /edit: use the write tools to prepare changes; the user reviews each proposal.",
    "auto": "\nMode /auto: the user allowed direct changes. The write tools apply immediately; "
            "do exactly what was asked, nothing more, and summarize every applied change at the end.",
}


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


def list_sessions(engine: str) -> list[dict]:
    if engine not in ENGINES:
        raise HTTPException(404, "Moteur agentique inconnu.")
    with _lock:
        return sorted((_public_session(s) for s in _read_sessions()
                       if s.get("engine") == engine and not s.get("watcher_id") and not s.get("purpose")
                       and s.get("workspace") == str(settings.storage_path.resolve())),
                      key=lambda s: s["updated_at"], reverse=True)


def get_session(session_id: str) -> dict:
    with _lock:
        return _public_session(_session(_read_sessions(), session_id))


def create_session(engine: str, vendor_session_id: str | None = None, watcher_id: int | None = None,
                   purpose: str | None = None) -> dict:
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
                   "created_at": _now(), "updated_at": _now(),
                   **({"watcher_id": watcher_id} if watcher_id is not None else {}),
                   **({"purpose": purpose} if purpose else {})}
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


def _activity(engine: str, event: dict) -> tuple[str, str, str] | None:
    kind = str(event.get("type") or "")
    if engine == "codex":
        if kind == "thread.started":
            return "status", "Session started", ""
        if kind.startswith("turn."):
            return "status", kind.replace("turn.", "Step ").replace("_", " "), ""
        item = event.get("item") or {}
        item_type = str(item.get("type") or "")
        if kind.startswith("item."):
            detail = "\n".join(str(value) for value in (item.get("command"), item.get("aggregated_output"),
                         item.get("text"), item.get("path")) if value)
            if item_type == "agent_message":
                return ("message", "Answer", detail) if kind == "item.completed" else None
            return "tool", item_type.replace("_", " ") or "Action", detail
    elif engine == "claude":
        if kind == "stream_event":
            partial = event.get("event") or {}
            delta = partial.get("delta") or {}
            if delta.get("type") == "text_delta" and delta.get("text"):
                return "message", "Texte en cours", str(delta["text"])
            if partial.get("type") == "content_block_start":
                block = partial.get("content_block") or {}
                if block.get("type") == "tool_use":
                    return "tool", str(block.get("name") or "Outil"), ""
        if kind == "system":
            return "status", "Session started", ""
        if kind == "assistant":
            blocks = (event.get("message") or {}).get("content") or []
            tools = [block for block in blocks if block.get("type") == "tool_use"]
            if tools:
                block = tools[-1]
                return "tool", str(block.get("name") or "Outil"), json.dumps(block.get("input") or {}, ensure_ascii=False)
            text = "\n".join(str(block.get("text") or "") for block in blocks if block.get("type") == "text")
            return ("message", "Answer", text) if text else None
        if kind == "user":
            return "tool", "Tool result", ""
        if kind == "result":
            return "status", "Run finished", ""
    else:
        part = event.get("part") or {}
        if kind == "text" and part.get("text"):
            return "message", "Answer", str(part["text"])
        if kind in {"tool_use", "tool", "step_start", "step_finish", "error"}:
            detail = part.get("state") or part.get("input") or part.get("text") or ""
            return "error" if kind == "error" else "tool", str(part.get("tool") or kind).replace("_", " "), str(detail)
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
            del run["events"][:-500]


def _execute(run: dict, prompt: str, config: dict, vendor_id: str | None, title: str) -> None:
    engine = run["engine"]
    connections = ExitStack()
    try:
        binary = _resolve_executable(engine, config["executable"])
        if not binary:
            raise ValueError("Program not found. Check its path in the settings.")
        # All native clients research in read mode; approved domain changes are
        # applied by Kavot through the proposal endpoint, never by a CLI shell.
        command = _command(engine, binary, {**config, "access": "read"}, vendor_id,
                           "" if engine == "claude" else prompt, title)
        environment = os.environ.copy()
        if engine == "claude":
            command = command[:-1] + ["--tools", "Read,Glob,Grep,WebSearch,WebFetch"]
        if engine == "opencode":
            environment["OPENCODE_PERMISSION"] = json.dumps({"*": "deny", "read": "allow", "glob": "allow",
                "grep": "allow", "list": "allow", "webfetch": "allow", "websearch": "allow", "codesearch": "allow"})
            # Windows limits command-line length. OpenCode reads the frozen
            # request attachment, while Codex and Claude receive it on stdin.
            request_path = config_dir() / f"external-request-{run['id']}.txt"
            request_path.write_text(prompt, encoding="utf-8")
            # --file is variadic: any positional text after it is treated as
            # another filename. Keep the message before the attachment flag.
            command[-1:] = ["Answer the attached Kavot request while following its context and rules.", "--file", str(request_path)]
            run["request_path"] = request_path
        connection = connections.enter_context(agent_mcp.serve_run(run, _lock, _append_event))
        command = agent_mcp.configure_client(engine, command, environment, connection)
        with _lock:
            if run["status"] == "cancelled":
                return
            process = subprocess.Popen(command, cwd=run["workspace"], stdin=subprocess.PIPE,
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
        for line in process.stdout:
            output.append(line)
            try:
                event = json.loads(line)
            except ValueError:
                continue
            activity = _activity(engine, event)
            if activity:
                _append_event(run, *activity)
            elif isinstance(event, dict):
                _append_event(run, "raw", str(event.get("type") or "Event"),
                              json.dumps(event, ensure_ascii=False))
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
            sessions = _read_sessions()
            session = _session(sessions, run["session_id"])
            session["vendor_session_id"] = parsed_id
            session["messages"].append({"role": "assistant", "content": answer or "Review the proposals below."})
            session["updated_at"] = _now()
            run.update(status="completed", response=answer or "Review the proposals below.",
                       proposal_errors=proposal_errors)
            for error in proposal_errors:
                _append_event(run, "error", "Proposal cannot be applied", error)
            _append_event(run, "status", "Done")
            session["last_run"] = _public_run(run)
            _write_sessions(sessions)
    except Exception as error:
        with _lock:
            if run["status"] != "cancelled":
                message = str(error)
                if run.get("mcp_token"):
                    message = message.replace(run["mcp_token"], "[secret]")
                run.update(status="failed", error=message)
                _append_event(run, "error", "Error", message)
    finally:
        connections.close()
        with _lock:
            run.pop("process", None)
            request_path = run.pop("request_path", None)
            if request_path:
                request_path.unlink(missing_ok=True)
            if run["status"] in {"failed", "cancelled"}:
                sessions = _read_sessions()
                for session in sessions:
                    if session["id"] == run["session_id"] and session.get("workspace") == run["workspace"]:
                        session["last_run"] = _public_run(run)
                        _write_sessions(sessions)
                        break
        on_finish = run.pop("on_finish", None)
        if on_finish:
            try:
                on_finish(_public_run(run))
            except Exception as error:  # A watcher bookkeeping failure must not hide the run result.
                _append_event(run, "error", "Watcher update failed", str(error))


def focus_lines(focus) -> list[str]:
    """What the user picked in the chat (project, notes, articles, folders, collection), with addresses to explore."""
    return [f"- {item.get('kind', 'item')}: {str(item.get('title') or '')[:120]}"
            + (f" ({item['count']} items)" if item.get("count") else "") + (f" — {item['ref']}" if item.get("ref") else "")
            for item in (focus or [])[:20] if isinstance(item, dict)]


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
        snapshot, resources, target = external_agent_context.prepare(context, prompt)
        if model is not None:
            session["model"] = model.strip()
        if effort is not None:
            session["effort"] = effort.strip()
        config = {**config, "model": session.get("model", config["model"]), "effort": session.get("effort", config["effort"])}
        detail = [f"- {item['title']} — {item['path']}" for item in resources]
        focus = focus_lines(snapshot.get("focus"))
        explicit_target = bool((context or {}).get("target_note_id") and
                               str((context or {}).get("target_note_id")) != str((context or {}).get("note_id") or ""))
        target_label = "Note cible choisie" if explicit_target else "Default open note"
        target_instruction = (f"{target_label} : {target['title']} — {target['path']}. "
                              "If the request explicitly names another note, use that other note. "
                              "Otherwise, use this target note.\n" if target else "")
        # Relative dates ("next Monday") in tasks and events need the user's local date.
        today = datetime.now().astimezone().strftime("%A %Y-%m-%d %H:%M (UTC%z)")
        full_prompt = (external_agent_context.POLICY + "\nMode : " + mode + "\nToday : " + today + "\nWorkspace Kavot : " + str(root) + "\n" + target_instruction +
                       ("Context chosen by the user for this conversation:\n" + "\n".join(focus) + "\n" if focus else "") +
                       ("Selected sources (read them with read_source through MCP):\n" + "\n".join(detail) + "\n" if detail else "") +
                       "\n" + agent_mcp.INSTRUCTIONS + MODE_RULES[mode] + instructions +
                       "\nDemande :\n" + prompt)
        if not session["messages"]:
            session["title"] = prompt[:64]
        scope = {key: copy.deepcopy(value) for key, value in snapshot.items() if key not in {"sources", "records", "note_catalog", "canvas", "citation_graph"}}
        session["messages"].append({"role": "user", "content": prompt, "context": scope})
        session["updated_at"] = _now()
        _write_sessions(sessions)
        run = {"id": str(uuid.uuid4()), "session_id": session_id, "engine": engine,
               "workspace": str(root), "status": "running", "response": None, "error": None,
               "events": [], "event_seq": 0, "resources": resources, "model": config["model"], "effort": config["effort"],
               "context": snapshot, "scope": scope, "mode": mode, "proposals": [], "modified_files": [],
               "baseline": external_agent_actions.baseline(snapshot)}
        _runs[run["id"]] = run
        if timeout:
            run["timeout"] = timeout
        if on_finish:
            run["on_finish"] = on_finish
        vendor_id = None if fresh else session["vendor_session_id"]
        threading.Thread(target=_execute, args=(run, full_prompt, config, vendor_id, session["title"]),
                         daemon=True, name=f"kavot-{engine}-run").start()
        return _public_run(run)


def _public_run(run: dict) -> dict:
    return copy.deepcopy({key: run.get(key) for key in
            ("id", "session_id", "status", "response", "error", "events", "resources", "model", "effort", "scope", "mode", "proposals", "proposal_errors", "modified_files")})


def get_run(run_id: str) -> dict:
    with _lock:
        run = _runs.get(run_id)
        if not run:
            for session in _read_sessions():
                saved = session.get("last_run") or {}
                if saved.get("id") == run_id and session.get("workspace") == str(settings.storage_path.resolve()):
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
            if any(r["status"] == "running" and r["workspace"] == run["workspace"] for r in _runs.values()):
                raise HTTPException(409, "Wait for the running requests to finish before applying a proposal.")
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
        session["last_run"] = _public_run(run)
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

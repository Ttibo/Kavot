"""Agent conversations of the Agents view, each request run by a local agent CLI.

Kavot owns the conversation list and transcript shown in its UI; each agent CLI keeps
its own authentication, models and execution loop. Every request reaches Kavot's
tools through the MCP server (app/mcp) with a token of its own: its session carries
the view the user was in, the mode and the proposals. Claude Code keeps one process
per conversation between messages (see :mod:`app.core.agents.worker`).

- :mod:`.engines`: the CLIs' settings; :mod:`.cli`: their command lines and JSON streams;
- :mod:`.conversations`: the saved conversations; :mod:`.prompt`: what each request says;
- this module: the requests (runs), from the message sent to the answer saved.
"""
from __future__ import annotations

import atexit
import copy
import json
import shutil
import stat
import subprocess
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from app.core import journal
from app.core.agents import cli, context as agent_context, conversations, engines, prompt as prompts, worker
from app.core.agents.usage import Meter, add as add_usage
from app.core.kernel.config import settings
from app.mcp import actions as agent_actions, memo, server as mcp_server
from app.mcp.session import ConversationSession

# Kinds of events kept with each answer, so a reopened conversation shows what the agent did.
KEPT_EVENTS = {"message", "tool", "thinking", "error", "write", "proposal"}
KEPT_DETAIL = 4000
# Finished requests kept in memory (older ones are read back from their conversation when asked).
KEPT_RUNS = 30
_lock = threading.RLock()
_runs: dict[str, dict] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stop_running() -> None:
    for run in _runs.values():
        if run["status"] != "running":
            continue
        run["status"] = "cancelled"
        if run.get("process"):
            worker.terminate(run["process"])


def shutdown() -> None:
    with _lock:
        _stop_running()
    worker.stop_all()


@contextmanager
def workspace_change():
    worker.stop_all()
    with _lock:
        _stop_running()
        yield


atexit.register(shutdown)


def _active_run(session_id: str) -> str | None:
    return next((run["id"] for run in _runs.values() if run["session_id"] == session_id and run["status"] == "running"), None)


def _public_session(session: dict) -> dict:
    return {key: value for key, value in session.items() if key != "workspace"} | {"active_run_id": _active_run(session["id"])}


def _summary(session: dict) -> dict:
    """A conversation in a list: everything but its transcript."""
    last = session.get("last_run") or {}
    return {key: value for key, value in session.items() if key not in {"workspace", "messages", "last_run"}} | {
        "active_run_id": _active_run(session["id"]),
        "message_count": len(session.get("messages") or []), "last_status": last.get("status")}


def list_sessions(engine: str | None = None, project_id: int | None = None) -> list[dict]:
    """The user's conversations, newest first; internal sessions of retired features are left out."""
    if engine is not None and engine not in engines.ENGINES:
        raise HTTPException(404, "Moteur agentique inconnu.")
    root = conversations.workspace()
    with _lock:
        return sorted((_summary(s) for s in conversations.cached()
                       if (engine is None or s.get("engine") == engine) and not s.get("watcher_id") and not s.get("purpose")
                       and (project_id is None or s.get("project_id") == project_id) and s.get("workspace") == root),
                      key=lambda s: s["updated_at"], reverse=True)


def get_session(session_id: str) -> dict:
    with _lock:
        return _public_session(conversations.find(conversations.cached(), session_id))


def rename_session(session_id: str, title: str) -> dict:
    with _lock:
        sessions = conversations.load()
        session = conversations.find(sessions, session_id)
        session["title"] = title.strip()[:120] or session["title"]
        session["updated_at"] = _now()
        conversations.save(sessions)
        return _public_session(session)


def delete_session(session_id: str) -> None:
    with _lock:
        sessions = conversations.load()
        session = conversations.find(sessions, session_id)
        if _active_run(session_id):
            raise HTTPException(409, "Stop the agent first.")
        worker.stop(session_id)
        memo.forget(session_id)
        conversations.save([item for item in sessions if item is not session])
        if session.get("cwd") and Path(session["cwd"]) == conversations.home(session):
            shutil.rmtree(session["cwd"], ignore_errors=True)
        for run_id in [key for key, run in _runs.items() if run["session_id"] == session_id]:
            _runs.pop(run_id, None)


def create_session(engine: str, vendor_session_id: str | None = None, project_id: int | None = None) -> dict:
    if engine not in engines.ENGINES:
        raise HTTPException(404, "Moteur agentique inconnu.")
    config = engines.configuration()[engine]
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
    root = conversations.workspace()
    session = {"id": str(uuid.uuid4()), "engine": engine,
               "title": f"Session {vendor_session_id[:12]}" if vendor_session_id else "New session",
               "workspace": root, "vendor_session_id": vendor_session_id,
               "messages": [], "model": config["model"], "effort": config["effort"],
               "created_at": _now(), "updated_at": _now(), "usage": {}, "usage_history": [],
               **({"project_id": int(project_id)} if project_id else {}),
               # The CLI keeps its sessions per folder: chosen at the first message (see _cwd).
               # A resumed CLI session lives where it was started; Kavot used to start them in the workspace.
               "cwd": root if vendor_session_id else None}
    with _lock:
        sessions = conversations.load()
        sessions.append(session)
        conversations.save(sessions)
        return _public_session(session)


def _cwd(session: dict, root: Path) -> str:
    """Where this request runs: the CLI keeps its sessions per folder, so a conversation always runs in the
    one of its first message, its own empty folder. Conversations older than this ran in the workspace."""
    if "cwd" not in session:
        session["cwd"] = str(root)
    elif not session["cwd"]:
        session["cwd"] = str(conversations.home(session))
    return session["cwd"]


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


def _consume(run: dict, engine: str, meter: Meter, line: str, output: list[str], tool_names: dict):
    """One line of the CLI's JSON stream: its usage, and what it shows in the conversation. Returns the event."""
    output.append(line)
    try:
        event = json.loads(line)
    except ValueError:
        return None
    if isinstance(event, dict) and "compact" in f"{event.get('type')} {event.get('subtype')}":
        # The CLI summarized the conversation: earlier tool results are no longer in its context.
        memo.forget(run["session_id"])
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
    activities = cli.activity(engine, event, tool_names) if isinstance(event, dict) else []
    if activities is None:
        _append_event(run, "raw", str(event.get("type") or "Event"), json.dumps(event, ensure_ascii=False))
    for activity in activities or []:
        if activity[0] == "message" and activity[1] == cli.STREAMED:
            # Streamed text of the current answer, shown live until the full message arrives.
            with _lock:
                run["draft"] = ((run.get("draft") or "") + activity[2])[-20_000:]
            continue
        if activity[0] == "message":
            with _lock:
                run["draft"] = ""
        _append_event(run, *activity)
    return event


def _run_claude(run: dict, binary: str, config: dict, vendor_id: str | None, prompt: str, title: str) -> tuple[Meter, list[str], str]:
    """A message to the conversation's Claude Code process, started (or resumed) when needed."""
    session_id, cwd, profile = run["session_id"], run["cwd"], run.get("tool_profile", "all")
    command, environment = cli.command(run, binary, config, vendor_id, prompt, title)

    def start() -> worker.ClaudeWorker:
        Path(cwd).mkdir(parents=True, exist_ok=True)
        return worker.ClaudeWorker(session_id, command, environment, cwd, signature, profile, _append_event)

    signature = (binary, config.get("model"), config.get("effort"), cwd, profile)
    process, running = worker.obtain(session_id, signature, start)
    baseline = run.get("usage_baseline") if vendor_id else None
    if running and process.cost is not None:
        baseline = {"cost_usd": process.cost}
    meter = Meter("claude", baseline)
    with _lock:
        if run["status"] == "cancelled":
            return meter, [], ""
        process.session.bind(run)
        run.update(process=process.process, mcp_token=process.connection.token)
    _append_event(run, "tool", "Request sent", prompt)
    process.send(prompt)
    output: list[str] = []
    tool_names: dict = {}
    finished = False
    while not finished:
        line = process.lines.get()
        if line is None:  # The process ended: stopped, or failed.
            worker.stop(session_id, process)
            break
        event = _consume(run, "claude", meter, line, output, tool_names)
        finished = isinstance(event, dict) and event.get("type") == "result"
    if finished:
        process.cost = (meter.cumulative or {}).get("cost_usd", process.cost)
        process.idle()
    return meter, output, "".join(process.errors) if not finished else ""


def _run_process(run: dict, binary: str, config: dict, vendor_id: str | None, prompt: str, title: str,
                 meter: Meter) -> tuple[list[str], str, int] | None:
    """A request to a CLI started for it alone (Codex, OpenCode). None when stopped before it started."""
    engine = run["engine"]
    command, environment = cli.command(run, binary, config, vendor_id, prompt, title)
    conversation = ConversationSession(run, _append_event)
    conversation.profile = run.get("tool_profile", "all")
    connection = mcp_server.attach(conversation)
    try:
        run["mcp_token"] = connection.token
        command = cli.connect(engine, command, environment, connection)
        Path(run["cwd"]).mkdir(parents=True, exist_ok=True)
        with _lock:
            if run["status"] == "cancelled":
                return None
            process = subprocess.Popen(command, cwd=run["cwd"], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                       encoding="utf-8", errors="replace", env=environment,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            run["process"] = process
        _append_event(run, "tool", "Request sent", prompt)
        if engine == "codex":
            process.stdin.write(prompt)
        process.stdin.close()
        errors: list[str] = []
        reader = threading.Thread(target=lambda: errors.extend(process.stderr), daemon=True)
        reader.start()
        output: list[str] = []
        tool_names: dict = {}
        for line in process.stdout:
            _consume(run, engine, meter, line, output, tool_names)
        process.wait()
        reader.join(timeout=2)
        return output, "".join(errors), process.returncode
    finally:
        mcp_server.detach(connection.token)


def _execute(run: dict, prompt: str, config: dict, vendor_id: str | None, title: str) -> None:
    engine = run["engine"]
    meter, started = Meter(engine, run.get("usage_baseline") if vendor_id else None), time.monotonic()
    # The run stays "running" until its answer is saved on the conversation: a view that sees it
    # finished and reloads the conversation then always finds the answer there.
    outcome = None
    try:
        binary = engines.resolve_executable(engine, config["executable"], shims=False)
        if not binary:
            raise ValueError("Program not found. Check its path in the settings.")
        if engine == "claude":
            meter, output, errors = _run_claude(run, binary, config, vendor_id, prompt, title)
            if run["status"] == "cancelled":
                return
            parsed_id, answer = cli.parse_result(engine, "".join(output))
            if errors or not parsed_id:
                raise ValueError((errors or answer or "Claude Code stopped before answering.").strip()[-1200:])
        else:
            result = _run_process(run, binary, config, vendor_id, prompt, title, meter)
            if result is None or run["status"] == "cancelled":
                return
            output, errors, returncode = result
            parsed_id, answer = cli.parse_result(engine, "".join(output))
            if returncode:
                raise ValueError((errors or answer or "The engine failed.").strip()[-1200:])
            if not parsed_id:
                raise ValueError("The engine did not return a session ID; it cannot be resumed.")
        if run.get("mcp_token"):
            answer = answer.replace(run["mcp_token"], "[secret]")
        with _lock:
            run.update(response=answer or ("Review the proposals below." if run["proposals"] else ""), vendor_id=parsed_id)
            outcome = "completed"
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
        with _lock:
            run.pop("process", None)
            request_path = run.pop("request_path", None)
            if request_path:
                request_path.unlink(missing_ok=True)
            if run["status"] == "running":  # Without an outcome: stopped before the CLI started.
                run["status"] = outcome or "cancelled"
            if run["status"] != "completed":
                # Its reads may not have reached the CLI's saved conversation: send them in full next time.
                memo.forget(run["session_id"])
            usage = meter.value()
            if not usage.get("duration_ms"):
                usage["duration_ms"] = int((time.monotonic() - started) * 1000)
            run.update(usage=usage, draft="")
            if meter.cumulative:
                run["thread_usage"] = meter.cumulative
            # What the agent could read and change is no longer needed: it weighs on memory.
            run.pop("context", None)
            run.pop("baseline", None)
            _record(run, usage)


def _record(run: dict, usage: dict) -> None:
    """Save a finished request on its conversation: the answer with what the agent did, and what it cost."""
    sessions = conversations.load()
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
    session["updated_at"] = _now()
    session["last_run"] = _public_run(run, full=True)
    conversations.save(sessions)


def _forget_finished_runs() -> None:
    """Keep the most recent finished requests in memory; the others are read back from their conversation."""
    finished = [run_id for run_id, run in _runs.items() if run["status"] != "running"]
    for run_id in finished[:-KEPT_RUNS]:
        _runs.pop(run_id, None)


def start_message(session_id: str, prompt: str, context: dict | None = None,
                  model: str | None = None, effort: str | None = None, mode: str = "answer") -> dict:
    with _lock:
        sessions = conversations.load()
        session = conversations.find(sessions, session_id)
        if _active_run(session_id):
            raise HTTPException(409, "This session is already running a request.")
        engine = session["engine"]
        config = engines.configuration()[engine]
        if not config["enabled"]:
            raise HTTPException(409, "This engine is disabled in the settings.")
        root = settings.storage_path.resolve()
        root.mkdir(parents=True, exist_ok=True)
        context = dict(context or {})
        if session.get("project_id") and not context.get("project_id"):
            context["project_id"] = session["project_id"]
        snapshot, resources, target = agent_context.prepare(context, prompt)
        cwd = _cwd(session, root)
        prompts.write_instructions(session, cwd)
        if model is not None:
            session["model"] = model.strip()
        if effort is not None:
            session["effort"] = effort.strip()
        config = {**config, **prompts.run_model(config, session, mode)}
        resumed = bool(session["vendor_session_id"])
        full_prompt = prompts.compose(session, prompt, mode, context, snapshot, resources, target, resumed, root)
        if not resumed:
            memo.forget(session_id)  # A new CLI conversation has read nothing yet.
        # The write tools appear once the conversation first asks for changes, and then stay:
        # a different tool list would make the provider reread the whole conversation uncached.
        if mode != "answer":
            session["write_tools"] = True
        if not session["messages"]:
            session["title"] = prompt[:64]
        scope = {key: copy.deepcopy(value) for key, value in snapshot.items() if key not in {"sources", "records", "note_catalog", "canvas", "citation_graph"}}
        session["messages"].append({"role": "user", "content": prompt, "context": scope, "at": _now(), "mode": mode})
        session["updated_at"] = _now()
        conversations.save(sessions)
        run = {"id": str(uuid.uuid4()), "session_id": session_id, "engine": engine,
               "workspace": str(root), "status": "running", "response": None, "error": None,
               "events": [], "event_seq": 0, "resources": resources, "model": config["model"], "effort": config["effort"],
               "context": snapshot, "scope": scope, "mode": mode, "proposals": [], "modified_files": [],
               "baseline": agent_actions.baseline(snapshot), "cwd": cwd, "draft": "", "usage": {},
               "usage_baseline": prompts.thread_usage(session), "tool_profile": "all" if session.get("write_tools") else "read",
               "started_at": _now()}
        _forget_finished_runs()
        _runs[run["id"]] = run
        threading.Thread(target=_execute, args=(run, full_prompt, config, session["vendor_session_id"], session["title"]),
                         daemon=True, name=f"kavot-{engine}-run").start()
        return _public_run(run)


def _public_run(run: dict, *, full: bool = False) -> dict:
    # Polled every ~1 s while the run lasts: the default keeps the payload small
    # (the complete transcript is stored on the session when the run ends).
    events = run.get("events") or []
    if not full:
        events = [{**event, "detail": event.get("detail", "")[:600]} for event in events[-40:]]
    public = copy.deepcopy({key: run.get(key) for key in
              ("id", "session_id", "status", "response", "error", "resources", "model", "effort", "scope", "mode",
               "proposals", "proposal_errors", "modified_files", "draft", "usage", "started_at")})
    public["events"] = events
    if run.get("mcp_token") and public.get("draft"):
        public["draft"] = public["draft"].replace(run["mcp_token"], "[secret]")
    return public


def _saved_run(run_id: str) -> dict | None:
    """A finished request no longer in memory, read back from its conversation (its proposals stay reviewable)."""
    root = conversations.workspace()
    for session in conversations.cached():
        if session.get("workspace") != root:
            continue
        saved = session.get("last_run") or {}
        if saved.get("id") != run_id:
            # An earlier answer of the conversation.
            answer = next((m for m in session.get("messages") or [] if m.get("run_id") == run_id), None)
            if not answer:
                continue
            saved = {"id": run_id, "session_id": session["id"], "status": answer.get("status") or "completed",
                     "response": answer.get("content"), "error": answer.get("error"), "events": answer.get("events") or [],
                     "mode": answer.get("mode"), "proposals": answer.get("proposals") or [], "usage": {}}
        # A copy: the cached conversations are shared, and a decision changes the run's proposals.
        return {**copy.deepcopy(saved), "workspace": session["workspace"], "engine": session["engine"],
                "event_seq": max((e["id"] for e in saved.get("events", [])), default=0)}
    return None


def _find_run(run_id: str) -> dict:
    run = _runs.get(run_id)
    if not run:
        run = _saved_run(run_id)
        if run:
            _forget_finished_runs()
            _runs[run_id] = run
    if not run or run["workspace"] != conversations.workspace():
        raise HTTPException(404, "Run not found.")
    return run


def get_run(run_id: str) -> dict:
    with _lock:
        return _public_run(_find_run(run_id))


def decide_proposal(run_id: str, proposal_id: str, decision: str) -> dict:
    with _lock:
        run = _find_run(run_id)
        if run["status"] != "completed":
            raise HTTPException(409, "Wait for the answer to finish.")
        proposal = next((p for p in run.get("proposals", []) if p["proposal_id"] == proposal_id), None)
        if not proposal:
            raise HTTPException(404, "Proposition introuvable.")
        if decision == "apply":
            if not engines.configuration()[run["engine"]]["enabled"]:
                raise HTTPException(409, "This assistant is disabled in the settings.")
            if run.get("mode") not in {"propose", "auto"}:
                raise HTTPException(409, "This request is in /plan. Switch to /edit and send your request to prepare a change.")
            # A request in /auto changes the data as it runs; other requests only read it or change code.
            if any(r["status"] == "running" and r["workspace"] == run["workspace"] and r.get("mode") == "auto" for r in _runs.values()):
                raise HTTPException(409, "Wait for the running /auto requests to finish before applying a proposal.")
            if proposal["status"] != "applied":
                before_files = _artifact_versions()
                with journal.author("agent", run=run_id, approved_by="user"):
                    result = agent_actions.apply(proposal)
                proposal.update(status="applied", result=result)
                after_files = _artifact_versions()
                changed = [path for path in before_files.keys() | after_files.keys() if before_files.get(path) != after_files.get(path)]
                run["modified_files"] = sorted(set(run.get("modified_files", [])) | set(changed))
                from app.core.storage.cloud_sync.routes import notify_local_change
                notify_local_change()
                _append_event(run, "write", "Change applied", proposal["label"] + " — " + proposal["target"])
        elif proposal["status"] == "pending":
            proposal["status"] = "dismissed"
        sessions = conversations.load()
        session = conversations.find(sessions, run["session_id"])
        if (session.get("last_run") or {}).get("id") == run_id:
            session["last_run"] = _public_run(run, full=True)
        for message in session["messages"]:
            if message.get("run_id") == run_id:
                message["proposals"] = copy.deepcopy(run["proposals"])
        conversations.save(sessions)
        return _public_run(run)


def _artifact_versions() -> dict:
    """(mtime, size) of every data file of the workspace, to name the files a proposal changed."""
    root = settings.storage_path.resolve()
    paths = [root / "kavot.state.json"]
    for name in ("notes", "projects", "library", "databases"):
        paths.extend(path for path in (root / name).rglob("*") if path.suffix in {".md", ".html", ".json", ".canvas"})
    versions = {}
    for path in paths:
        try:
            info = path.stat()
        except OSError:
            continue
        if stat.S_ISREG(info.st_mode) and path.resolve().is_relative_to(root):
            versions[path.relative_to(root).as_posix()] = (info.st_mtime_ns, info.st_size)
    return versions


def cancel_run(run_id: str) -> dict:
    with _lock:
        run = _runs.get(run_id)
        if not run or run["workspace"] != conversations.workspace():
            raise HTTPException(404, "Run not found.")
        if run["status"] == "running":
            run["status"] = "cancelled"
            process = run.get("process")
            if process:
                process.terminate()  # A conversation's Claude Code process: the next message resumes it.
        return _public_run(run)

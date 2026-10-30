"""Development agents on one or more code folders, each folder in its own Git worktree.

An agent may also work without code: a chat about the project, its notes and its
resource folders (documents, data), which it reads but never changes.

A run never touches the user's checkouts: for every folder it works on, Kavot creates a
worktree on a new branch `kavot/agent/<id>` from that folder's current HEAD. The agent CLI
starts in the first (main) worktree and may write in the others; then Kavot shows the
resulting diff of each folder. The user commits it (optionally merging each branch into its
checkout), asks for another iteration in the same session, or discards the worktrees and
their branches. Token usage reported by the agent is counted per run.
"""
from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.core.agents import sessions
from app.core.kernel.user_settings import config_dir
from app.core.projects import code as project_code
from app.core.records.repository import store as records
from app.plugins.atelier import folders, gitview, preview, store

MAX_RUNNING = 3
MAX_EXTRA_FOLDERS = 4
TIMEOUT = 45 * 60
CLAUDE_TOOLS = "Read,Glob,Grep,Edit,Write"
OPENCODE_PERMISSION = {"*": "deny", "read": "allow", "glob": "allow", "grep": "allow", "list": "allow", "edit": "allow"}
REVIEWABLE = {"review", "failed", "cancelled"}
CONTINUABLE = REVIEWABLE | {"answered"}
READ_TOOLS = "Read,Glob,Grep"
USAGE_KEYS = ("input", "output", "cache_read", "cache_write", "reasoning", "cost_usd", "turns", "duration_ms")
SUMMARY_KEYS = ("id", "title", "status", "engine", "model", "folder_id", "branch", "base_branch", "base_sha", "task_id",
                "note_ids", "created_at", "updated_at", "finished_at", "files", "error", "commit", "merged", "usage", "workspaces", "resources")

_live: dict[str, dict[str, Any]] = {}
_lock = threading.RLock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# Workspaces: one per folder the run works on; the first is the main one (the agent's cwd).

def _workspaces(run: dict[str, Any]) -> list[dict[str, Any]]:
    if "workspaces" not in run:
        # Runs made before several folders were supported.
        run["workspaces"] = [{"folder_id": run.get("folder_id"), "name": "", "worktree": run.get("worktree"),
                              "branch": run.get("branch"), "base_sha": run.get("base_sha"), "base_branch": run.get("base_branch"),
                              "files": [f for f in run.get("files") or []], "commit": run.get("commit"), "merged": run.get("merged", False)}]
    return run["workspaces"]


def _sync(run: dict[str, Any]) -> None:
    """Mirror the main workspace and every folder's changed files on the run itself."""
    spaces = _workspaces(run)
    main = spaces[0] if spaces else {"folder_id": None, "branch": None, "base_sha": None, "base_branch": None}
    run.update(folder_id=main["folder_id"], branch=main["branch"], base_sha=main["base_sha"], base_branch=main["base_branch"],
               worktree=main.get("worktree"), commit=main.get("commit"),
               merged=all(space.get("merged") or not space.get("commit") for space in spaces) and any(space.get("commit") for space in spaces),
               files=[{**file, "folder_id": space["folder_id"]} for space in spaces for file in space.get("files") or []])


def _open(space: dict[str, Any]) -> bool:
    return bool(space.get("worktree")) and Path(space["worktree"]).is_dir()


# Token usage, as each engine reports it in its JSON stream.

def _add(first: dict[str, Any], second: dict[str, Any]) -> dict[str, Any]:
    return {key: (first.get(key) or 0) + (second.get(key) or 0) for key in USAGE_KEYS}


class Meter:
    """Usage of one agent invocation."""

    def __init__(self, engine: str):
        self.engine, self.messages, self.total, self.final = engine, {}, {}, None

    def feed(self, event: Any) -> bool:
        if not isinstance(event, dict):
            return False
        kind = event.get("type")
        if self.engine == "claude":
            if kind == "assistant":
                message = event.get("message") or {}
                usage = message.get("usage") or {}
                if not usage:
                    return False
                self.messages[message.get("id") or len(self.messages)] = {
                    "input": usage.get("input_tokens"), "output": usage.get("output_tokens"),
                    "cache_read": usage.get("cache_read_input_tokens"), "cache_write": usage.get("cache_creation_input_tokens")}
                return True
            if kind == "result":
                usage = event.get("usage") or {}
                self.final = {"input": usage.get("input_tokens"), "output": usage.get("output_tokens"),
                              "cache_read": usage.get("cache_read_input_tokens"), "cache_write": usage.get("cache_creation_input_tokens"),
                              "cost_usd": event.get("total_cost_usd"), "turns": event.get("num_turns"), "duration_ms": event.get("duration_ms")}
                return True
        elif self.engine == "codex" and kind == "turn.completed":
            usage = event.get("usage") or {}
            # Codex counts cached tokens inside its input tokens.
            cached = usage.get("cached_input_tokens") or 0
            self.total = _add(self.total, {"input": max(0, (usage.get("input_tokens") or 0) - cached), "cache_read": cached,
                                           "output": usage.get("output_tokens"), "reasoning": usage.get("reasoning_output_tokens"), "turns": 1})
            return True
        elif self.engine == "opencode" and kind == "step_finish":
            part = event.get("part") or {}
            tokens = part.get("tokens") or {}
            cache = tokens.get("cache") or {}
            self.total = _add(self.total, {"input": tokens.get("input"), "output": tokens.get("output"), "reasoning": tokens.get("reasoning"),
                                           "cache_read": cache.get("read"), "cache_write": cache.get("write"), "cost_usd": part.get("cost"), "turns": 1})
            return True
        return False

    def value(self) -> dict[str, Any]:
        if self.final:
            return _add({}, self.final)
        if self.messages:
            total: dict[str, Any] = {}
            for usage in self.messages.values():
                total = _add(total, usage)
            return {**total, "turns": len(self.messages)}
        return _add({}, self.total)


def recover() -> None:
    """Runs left `running` by a previous session lost their process: keep their worktrees for review."""
    try:
        project_ids = store.projects_with_state()
    except OSError:
        return
    for project_id in project_ids:
        with store.lock:
            doc = store.read(project_id)
            changed = False
            for run in doc["runs"]:
                if run["status"] == "running" and run["id"] not in _live:
                    run.update(status="failed", error="Kavot was closed during this run. Its changes are kept for review.")
                    changed = True
            if changed:
                store.write(project_id, doc)


def _stored(project_id: int, run_id: str) -> dict[str, Any]:
    with _lock:
        if run_id in _live and _live[run_id]["project_id"] == project_id:
            return _live[run_id]["run"]
    run = next((item for item in store.read(project_id)["runs"] if item["id"] == run_id), None)
    if not run:
        raise HTTPException(404, "Agent run not found.")
    return run


def _persist(project_id: int, run: dict[str, Any]) -> None:
    with store.lock:
        doc = store.read(project_id)
        doc["runs"] = [run if item["id"] == run["id"] else item for item in doc["runs"]]
        if not any(item["id"] == run["id"] for item in doc["runs"]):
            doc["runs"].insert(0, run)
        doc["runs"] = doc["runs"][:100]
        store.write(project_id, doc)


def _event(run: dict[str, Any], kind: str, label: str, detail: str = "") -> None:
    with _lock:
        run["event_seq"] = run.get("event_seq", 0) + 1
        run.setdefault("events", []).append({"id": run["event_seq"], "kind": kind, "label": label[:160],
                                             "detail": detail[:4000], "at": _now()})
        del run["events"][:-400]
        run["updated_at"] = _now()


def summary(run: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        _workspaces(run)
        return {key: copy.deepcopy(run.get(key)) for key in SUMMARY_KEYS}


def detail(run: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        spaces = _workspaces(run)
        return {**summary(run), **copy.deepcopy({key: run.get(key) for key in ("prompt", "response", "events", "messages", "worktree", "draft", "usage_history")}),
                "worktree_exists": any(_open(space) for space in spaces),
                "workspaces": [{**copy.deepcopy(space), "open": _open(space)} for space in spaces]}


def listing(project: dict[str, Any]) -> list[dict[str, Any]]:
    runs = []
    for run in store.read(project["id"])["runs"]:
        with _lock:
            current = _live.get(run["id"], {}).get("run", run)
        runs.append(summary(current))
    return runs


def get(project: dict[str, Any], run_id: str) -> dict[str, Any]:
    return detail(_stored(project["id"], run_id))


def _engine(engine: str) -> dict[str, Any]:
    if engine not in sessions.ENGINES:
        raise HTTPException(404, "Unknown agent engine.")
    config = sessions.configuration()[engine]
    if not config["enabled"]:
        raise HTTPException(409, f"Enable {sessions.ENGINES[engine]['name']} in Settings → AI and agents.")
    if not sessions._resolve_executable(engine, config["executable"]):
        raise HTTPException(409, f"{sessions.ENGINES[engine]['name']} was not found on this computer.")
    return config


def engines() -> list[dict[str, Any]]:
    return [{"id": item["id"], "name": item["name"], "enabled": item["enabled"], "model": item["model"],
             "available": bool(item["detected_path"])} for item in sessions.public_settings()["engines"]]


def _note_context(note_ids: list[int]) -> list[str]:
    from app.core.records.api import note_text
    blocks, budget = [], 20_000
    for note_id in note_ids[:6]:
        try:
            note, passages = note_text(note_id)
        except ValueError:
            continue
        text = "\n".join(passage["text"] for passage in passages)[:min(6000, budget)]
        budget -= len(text)
        blocks.append(f"### Note: {note.get('title') or 'Untitled'}\n{text}")
        if budget <= 0:
            break
    return blocks


def _folders_brief(run: dict[str, Any]) -> list[str]:
    spaces = _workspaces(run)
    lines = []
    shared = [item for item in run.get("resources") or [] if not item.get("file")]
    if shared:
        lines += ["Resource folders (documents and data) you may read but must never change:",
                  *(f"- {item['name']}: {item['path']}" for item in shared)]
    if not spaces:
        return lines + ["You have no code to change in this conversation: answer, explain, analyse or draft text; do not create or edit files."]
    lines += [f"You work in Git worktrees of the project's code, on the branch {run['branch']} in each of them:"]
    for index, space in enumerate(spaces):
        origin = space.get("base_branch") or str(space.get("base_sha") or "")[:10]
        lines.append(f"- {space['name']}{' (current directory)' if index == 0 else ''}: {space['worktree']} — from {origin}")
    lines.append("Edit files only inside these folders." if len(spaces) > 1 else "Edit files only inside the current directory.")
    lines.append("Edit the files directly to do what is asked. Do not commit, push, merge or switch branches: "
                 "Kavot shows your changes to the user, who reviews them, then commits or discards them.")
    return lines


def _brief(project: dict[str, Any], run: dict[str, Any], prompt: str) -> str:
    lines = [
        "You are a development agent started from Kavot, the user's project workspace.",
        *_folders_brief(run),
        *(["Keep the change focused on the request. Shell commands may be unavailable.",
           "End with a short summary: what you changed, why, and how to test it."] if _workspaces(run) else []),
        "", f"Project: {project.get('name') or 'Project'}" + (f" — {project['description']}" if project.get("description") else ""),
    ]
    if run.get("task_id"):
        task = next((t for t in records.read().get("tasks", []) if t.get("id") == run["task_id"]), None)
        if task:
            checklist = "\n".join(f"- [{'x' if item.get('done') else ' '}] {item.get('text', '')}" for item in task.get("checklist") or [])
            lines += ["", f"## Task: {task.get('title', '')} (status {task.get('status', 'todo')})",
                      str(task.get("description") or "").strip(), checklist]
    notes = _note_context(run.get("note_ids") or [])
    if notes:
        lines += ["", "## Project notes chosen as context", *notes]
    # Linked files are given as their text: the agent does not need, nor get, their folder.
    for item in [item for item in run.get("resources") or [] if item.get("file")]:
        try:
            content = preview.text(Path(item["path"]))
        except (OSError, HTTPException) as error:
            content = f"(Unreadable: {getattr(error, 'detail', error)})"
        lines += ["", f"## File: {item['name']}", content]
    lines += ["", "## Request", prompt]
    return "\n".join(line for line in lines if line is not None)


def _repository(project: dict[str, Any], folder_id: str) -> tuple[dict[str, Any], Path, str]:
    folder = folders.entry(project, folder_id)
    base = project_code.folder(folder["path"])
    if not project_code.inspect(str(base))["is_git"]:
        raise HTTPException(409, f"“{folder['name']}” is not a Git repository: agents work in Git worktrees.")
    try:
        head = gitview.run(base, "rev-parse", "HEAD").strip()
    except ValueError:
        raise HTTPException(409, f"“{folder['name']}” has no commit yet: make a first commit, then start an agent.") from None
    return folder, base, head


def start(project: dict[str, Any], folder_id: str | None, engine: str, prompt: str, task_id: int | None = None,
          note_ids: list[int] | None = None, model: str = "", extra_folder_ids: list[str] | None = None,
          resource_folder_ids: list[str] | None = None) -> dict[str, Any]:
    prompt = prompt.strip()
    if not prompt:
        raise HTTPException(422, "Describe what the agent should do.")
    config = _engine(engine)
    folder_ids = [item for item in dict.fromkeys([folder_id, *(extra_folder_ids or [])]) if item]
    if len(folder_ids) > 1 + MAX_EXTRA_FOLDERS:
        raise HTTPException(422, f"An agent works on at most {1 + MAX_EXTRA_FOLDERS} folders.")
    repositories = [_repository(project, item) for item in folder_ids]
    resources = []
    for item in dict.fromkeys(resource_folder_ids or []):
        if item in folder_ids:
            continue
        folder = folders.entry(project, item)
        if folder.get("file"):
            resources.append({"folder_id": folder["id"], "name": folder["name"], "path": str(folders.linked_file(folder["path"])), "file": True})
        else:
            resources.append({"folder_id": folder["id"], "name": folder["name"], "path": str(project_code.folder(folder["path"]))})
    with _lock:
        if sum(1 for live in _live.values() if live["run"]["status"] == "running") >= MAX_RUNNING:
            raise HTTPException(409, f"At most {MAX_RUNNING} agents can run at the same time.")
    run_id = uuid.uuid4().hex[:10]
    branch = f"kavot/agent/{run_id}"
    spaces: list[dict[str, Any]] = []
    try:
        for index, (folder, base, head) in enumerate(repositories):
            worktree = store.worktrees() / (run_id if index == 0 else f"{run_id}-{index}")
            worktree.parent.mkdir(parents=True, exist_ok=True)
            gitview.run(base, "worktree", "add", "-b", branch, str(worktree), head, timeout=180)
            spaces.append({"folder_id": folder["id"], "name": folder["name"], "worktree": str(worktree), "branch": branch,
                           "base_sha": head, "base_branch": project_code.git(base, "symbolic-ref", "--short", "-q", "HEAD", optional=True).strip(),
                           "files": [], "commit": None, "merged": False, "_base": base})
    except ValueError as error:
        for space in spaces:  # Leave no half-created run behind.
            _remove_worktree(space["_base"], Path(space["worktree"]))
            try:
                gitview.run(space["_base"], "branch", "-D", branch)
            except ValueError:
                pass
        raise HTTPException(409, f"Unable to create the worktree: {error}") from None
    for space in spaces:
        space.pop("_base")
    # A chat runs in its first resource folder, or in an empty folder of its own.
    shared = [item for item in resources if not item.get("file")]
    cwd = spaces[0]["worktree"] if spaces else shared[0]["path"] if shared else str(store.base() / "chats" / run_id)
    Path(cwd).mkdir(parents=True, exist_ok=True)
    run = {"id": run_id, "title": prompt.splitlines()[0][:90], "status": "running", "engine": engine, "cwd": cwd, "resources": resources,
           "model": model.strip() or config["model"], "workspaces": spaces, "task_id": task_id, "note_ids": list(note_ids or [])[:6],
           "prompt": prompt, "messages": [{"role": "user", "content": prompt, "at": _now()}], "events": [], "event_seq": 0,
           "vendor_id": None, "response": None, "error": None, "usage": {}, "usage_history": [],
           "created_at": _now(), "updated_at": _now(), "finished_at": None}
    _sync(run)
    for space in spaces:
        _event(run, "status", "Worktree created", f"{space['name']}: {branch} from {space['base_sha'][:10]}")
    _launch(project, run, _brief(project, run, prompt), {**config, "model": run["model"]})
    return detail(run)


def message(project: dict[str, Any], run_id: str, prompt: str) -> dict[str, Any]:
    prompt = prompt.strip()
    run = _stored(project["id"], run_id)
    if not prompt:
        raise HTTPException(422, "Write the next instruction.")
    spaces = _workspaces(run)
    if run["status"] not in CONTINUABLE or (spaces and not _open(spaces[0])):
        raise HTTPException(409, "This run cannot continue: its worktree is closed.")
    config = _engine(run["engine"])
    run = copy.deepcopy(run)
    run.update(status="running", error=None, finished_at=None, draft="")
    run["messages"].append({"role": "user", "content": prompt, "at": _now()})
    follow_up = prompt if run.get("vendor_id") else _brief(project, run, prompt)
    _launch(project, run, follow_up + "\n\n(Same rules: edit files in the worktrees only, no commit.)", {**config, "model": run["model"]})
    return detail(run)


def _launch(project: dict[str, Any], run: dict[str, Any], prompt: str, config: dict[str, Any]) -> None:
    with _lock:
        _live[run["id"]] = {"project_id": project["id"], "run": run, "process": None}
    _persist(project["id"], run)
    threading.Thread(target=_execute, args=(project["id"], run, prompt, config), daemon=True,
                     name=f"kavot-atelier-{run['id']}").start()


def _command(engine: str, binary: str, config: dict[str, Any], run: dict[str, Any], prompt: str) -> tuple[list[str], dict[str, str], Path | None]:
    """The agent CLI command: write access to every worktree of the run, read access to its resources."""
    spaces = _workspaces(run)
    writes = bool(spaces)
    extra = [space["worktree"] for space in spaces[1:] if _open(space)]
    readable = [item["path"] for item in run.get("resources") or [] if not item.get("file") and item["path"] != run.get("cwd")]
    vendor_id = run.get("vendor_id")
    command = sessions._command(engine, binary, {**config, "access": "write" if writes else "read"}, vendor_id,
                                "" if engine in {"codex", "claude"} else prompt, run["title"])
    environment = os.environ.copy()
    request_path = None
    if engine == "claude":
        command = command[:-1] + ["--tools", CLAUDE_TOOLS if writes else READ_TOOLS] + [part for path in [*extra, *readable] for part in ("--add-dir", path)]
    elif engine == "codex":
        if extra:
            position = command.index(vendor_id) if vendor_id and vendor_id in command else len(command) - 1
            command[position:position] = ["-c", f"sandbox_workspace_write.writable_roots={json.dumps(extra)}"]
    else:
        permission = {**OPENCODE_PERMISSION, "edit": "allow" if writes else "deny"}
        environment["OPENCODE_PERMISSION"] = json.dumps({**permission, **({"external_directory": "allow"} if extra or readable else {})})
        request_path = config_dir() / f"atelier-request-{run['id']}.txt"
        request_path.write_text(prompt, encoding="utf-8")
        command[-1:] = ["Do the attached development request in the current directory.", "--file", str(request_path)]
    return command, environment, request_path


def _execute(project_id: int, run: dict[str, Any], prompt: str, config: dict[str, Any]) -> None:
    engine = run["engine"]
    spaces = _workspaces(run)
    request_path = None
    meter, before, started = Meter(engine), dict(run.get("usage") or {}), time.monotonic()
    try:
        binary = sessions._resolve_executable(engine, config["executable"])
        if not binary:
            raise ValueError("Program not found. Check its path in the settings.")
        command, environment, request_path = _command(engine, binary, config, run, prompt)
        _event(run, "status", f"{sessions.ENGINES[engine]['name']} started", run.get("model") or "")
        process = subprocess.Popen(command, cwd=run.get("cwd") or spaces[0]["worktree"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", env=environment,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        with _lock:
            _live[run["id"]]["process"] = process
        watchdog = threading.Timer(TIMEOUT, lambda: (run.update(timed_out=True), process.terminate()))
        watchdog.daemon = True
        watchdog.start()
        if process.stdin:
            if engine in {"codex", "claude"}:
                process.stdin.write(prompt)
            process.stdin.close()
        errors: list[str] = []
        threading.Thread(target=lambda: errors.extend(process.stderr), daemon=True).start()
        output: list[str] = []
        for line in process.stdout:
            output.append(line)
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if meter.feed(event):
                with _lock:
                    run["usage"] = _add(before, meter.value())
            try:
                activity = sessions._activity(engine, event)
            except AttributeError:
                continue
            if not activity:
                continue
            if activity[0] == "message" and activity[1] == "Texte en cours":
                # Streamed text of the current answer, shown live until the full message arrives.
                with _lock:
                    run["draft"] = ((run.get("draft") or "") + activity[2])[-20_000:]
                continue
            with _lock:
                if activity[0] == "message":
                    run["draft"] = ""
            _event(run, *activity)
        process.wait()
        watchdog.cancel()
        if _live[run["id"]].get("cancelled"):
            raise InterruptedError()
        if run.pop("timed_out", False):
            raise ValueError(f"The agent exceeded {TIMEOUT // 60} minutes and was stopped.")
        vendor_id, answer = sessions._parse_result(engine, "".join(output))
        if process.returncode:
            raise ValueError(("".join(errors) or answer or "The agent failed.").strip()[-1200:])
        run["vendor_id"] = vendor_id or run.get("vendor_id")
        run["response"] = answer or "The agent finished without a summary."
        run["messages"].append({"role": "assistant", "content": run["response"], "at": _now()})
        run["status"], run["draft"] = ("review", "") if spaces else ("answered", "")
        if spaces:
            _event(run, "status", "Ready for review")
    except InterruptedError:
        run.update(status="cancelled", error="Stopped by the user.")
        _event(run, "status", "Stopped")
    except Exception as error:  # Any failure must leave a reviewable run, never a stuck one.
        run.update(status="failed", error=str(error)[:1500])
        _event(run, "error", "Error", str(error))
    finally:
        if request_path:
            request_path.unlink(missing_ok=True)
        usage = meter.value()
        if not usage.get("duration_ms"):
            usage["duration_ms"] = int((time.monotonic() - started) * 1000)
        prompt_text = next((m["content"] for m in reversed(run.get("messages") or []) if m["role"] == "user"), "")
        run.setdefault("usage_history", []).append({"at": _now(), "prompt": prompt_text[:120], **usage})
        run["usage"] = _add(before, usage)
        for space in spaces:
            if not _open(space):
                continue
            try:
                space["files"] = [{k: f[k] for k in ("path", "status", "additions", "deletions")} for f in _changes(Path(space["worktree"]))["files"]]
            except (ValueError, HTTPException) as error:
                _event(run, "error", f"Unable to read the changes of {space['name']}", str(getattr(error, "detail", error)))
        _sync(run)
        run["finished_at"] = run["updated_at"] = _now()
        with _lock:
            _live.pop(run["id"], None)
        _persist(project_id, run)


def _changes(worktree: Path) -> dict[str, Any]:
    # Intent-to-add makes new files part of the diff without staging their content.
    gitview.run(worktree, "add", "--all", "--intent-to-add")
    patch = gitview.run(worktree, "diff", "--no-color", "-M", "HEAD")
    patch, truncated = (patch[:gitview.MAX_DIFF], True) if len(patch) > gitview.MAX_DIFF else (patch, False)
    return {"files": gitview.split_patch(patch), "truncated": truncated}


def diff(project: dict[str, Any], run_id: str) -> dict[str, Any]:
    """The changes of each folder of the run: live in its worktree, or its commit once accepted."""
    run = _stored(project["id"], run_id)
    result = []
    for space in _workspaces(run):
        try:
            if _open(space):
                changes = _changes(Path(space["worktree"]))
            elif space.get("commit"):
                changes = gitview.commit(folders.root(project, space["folder_id"]), space["commit"])
            else:
                changes = {"files": [], "truncated": False}
        except (ValueError, HTTPException) as error:
            changes = {"files": [], "truncated": False, "error": str(getattr(error, "detail", error))}
        result.append({"folder_id": space["folder_id"], "name": space.get("name") or "", "files": changes["files"],
                       "truncated": changes.get("truncated", False), "error": changes.get("error")})
    return {"folders": result, "files": [{**f, "folder_id": item["folder_id"]} for item in result for f in item["files"]],
            "truncated": any(item["truncated"] for item in result)}


def cancel(project: dict[str, Any], run_id: str) -> dict[str, Any]:
    with _lock:
        live = _live.get(run_id)
        if not live or live["project_id"] != project["id"]:
            raise HTTPException(409, "This run is not running.")
        live["cancelled"] = True
        if live.get("process"):
            live["process"].terminate()
        return detail(live["run"])


def _idle(project: dict[str, Any], run_id: str) -> dict[str, Any]:
    run = copy.deepcopy(_stored(project["id"], run_id))
    if run["status"] == "running":
        raise HTTPException(409, "Wait for the agent to finish, or stop it.")
    return run


def _remove_worktree(base: Path, worktree: Path) -> None:
    try:
        gitview.run(base, "worktree", "remove", "--force", str(worktree))
    except ValueError:
        shutil.rmtree(worktree, ignore_errors=True)
        try:
            gitview.run(base, "worktree", "prune")
        except ValueError:
            pass


def _identity(worktree: Path) -> list[str]:
    try:
        if gitview.run(worktree, "config", "user.email").strip():
            return []
    except ValueError:
        pass
    return ["-c", "user.name=Kavot agent", "-c", "user.email=agent@kavot.local"]


def accept(project: dict[str, Any], run_id: str, message_text: str, merge_after: bool = False) -> dict[str, Any]:
    """Commit the changes of every folder on its branch, then close the worktrees."""
    run = _idle(project, run_id)
    spaces = [space for space in _workspaces(run) if _open(space)]
    if run["status"] not in REVIEWABLE or not spaces:
        raise HTTPException(409, "This run has no open changes to accept.")
    try:
        changed = []
        for space in spaces:
            gitview.run(Path(space["worktree"]), "add", "--all")
            if gitview.run(Path(space["worktree"]), "status", "--porcelain").strip():
                changed.append(space)
        if not changed:
            raise HTTPException(409, "The agent did not change any file.")
        text = message_text.strip() or run["title"]
        for space in changed:
            worktree = Path(space["worktree"])
            gitview.run(worktree, *_identity(worktree), "commit", "-m", text, "-m", f"Agent run {run['id']} ({run['engine']}) from Kavot.")
            space["commit"] = gitview.run(worktree, "rev-parse", "HEAD").strip()
    except ValueError as error:
        raise HTTPException(409, f"Unable to commit: {error}") from None
    for space in spaces:
        base = folders.root(project, space["folder_id"])
        _remove_worktree(base, Path(space["worktree"]))
        if not space.get("commit"):  # Nothing changed in this folder: its branch is useless.
            try:
                gitview.run(base, "branch", "-D", space["branch"])
            except ValueError:
                pass
        space["worktree"] = None
        if space.get("commit"):
            _event(run, "write", "Committed", f"{space['name'] or 'folder'}: {space['commit'][:10]} on {space['branch']}")
    _sync(run)
    run.update(status="accepted", finished_at=run.get("finished_at") or _now())
    _persist(project["id"], run)
    return merge(project, run_id) if merge_after else detail(run)


def merge(project: dict[str, Any], run_id: str) -> dict[str, Any]:
    """Merge each committed branch into its folder's checkout; all checkouts are checked first."""
    run = _idle(project, run_id)
    pending = [space for space in _workspaces(run) if space.get("commit") and not space.get("merged")]
    if run["status"] != "accepted" or not pending:
        raise HTTPException(409, "Only an accepted, unmerged run can be merged.")
    targets = []
    for space in pending:
        base = folders.root(project, space["folder_id"])
        current = project_code.git(base, "symbolic-ref", "--short", "-q", "HEAD", optional=True).strip()
        label = space.get("name") or "the folder"
        if not current:
            raise HTTPException(409, f"The checkout of {label} is on a detached HEAD: switch to a branch to merge.")
        if gitview.run(base, "status", "--porcelain", "--untracked-files=no").strip():
            raise HTTPException(409, f"The checkout of {label} ({current}) has uncommitted changes: commit or stash them, then merge.")
        targets.append((space, base, current))
    for space, base, current in targets:
        try:
            gitview.run(base, "merge", "--no-edit", space["branch"], timeout=120)
        except ValueError as error:
            try:
                gitview.run(base, "merge", "--abort")
            except ValueError:
                pass
            _sync(run)
            _persist(project["id"], run)
            raise HTTPException(409, f"The merge into {current} ({space.get('name')}) failed and was cancelled: {error}") from None
        space["merged"] = True
        _event(run, "write", "Merged", f"{space.get('name') or 'folder'}: {space['branch']} into {current}")
    _sync(run)
    run["status"] = "merged"
    _persist(project["id"], run)
    return detail(run)


def discard(project: dict[str, Any], run_id: str) -> dict[str, Any]:
    run = _idle(project, run_id)
    if run["status"] in {"discarded", "merged"}:
        raise HTTPException(409, "This run is already closed.")
    if not _workspaces(run):
        raise HTTPException(409, "This conversation has no code changes to discard.")
    for space in _workspaces(run):
        base = folders.root(project, space["folder_id"])
        if space.get("worktree") and Path(space["worktree"]).exists():
            _remove_worktree(base, Path(space["worktree"]))
        if not space.get("merged"):
            try:
                gitview.run(base, "branch", "-D", space["branch"])
            except ValueError:
                pass  # Already deleted by hand.
        space["worktree"] = None
    _sync(run)
    run["status"] = "discarded"
    _event(run, "status", "Discarded", f"Worktrees and branch {run['branch']} deleted")
    _persist(project["id"], run)
    return detail(run)


def forget(project: dict[str, Any], run_id: str) -> None:
    run = _idle(project, run_id)
    if run["status"] not in {"discarded", "merged", "accepted"} and _workspaces(run):
        raise HTTPException(409, "Accept or discard this run before removing it from the list.")
    if run.get("cwd") and Path(run["cwd"]).is_relative_to(store.base() / "chats"):
        shutil.rmtree(run["cwd"], ignore_errors=True)
    with store.lock:
        doc = store.read(project["id"])
        doc["runs"] = [item for item in doc["runs"] if item["id"] != run_id]
        store.write(project["id"], doc)

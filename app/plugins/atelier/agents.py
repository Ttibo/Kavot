"""The Atelier's part of agent conversations: a project's code in Git worktrees, and its resource folders.

Any conversation (the assistant, the Chat view, the Atelier) may be given a project's code.
Kavot never touches the user's checkouts: for every repository given, it creates a worktree
on a new branch `kavot/agent/<id>` from that folder's current HEAD. The agent CLI edits files
there (in /edit and /auto; /plan only reads), and Kavot shows the resulting diff of each folder.
The user commits it (optionally merging each branch into its checkout), asks for another
iteration in the same conversation, or discards the worktrees and their branches.
Resource folders (documents, data) are read, never changed; a linked single file is given as text.

The code part is stored on the conversation itself (``session["code"]``).
"""
from __future__ import annotations

import copy
import shutil
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.core.agents import sessions
from app.core.agents.workspace import Workspace
from app.core.projects import code as project_code
from app.plugins.atelier import folders, gitview, preview, store

MAX_RUNNING = 3
MAX_FOLDERS = 5
TIMEOUT = 45 * 60
OPEN = {"open", "review"}
CLOSED = {"accepted", "merged", "discarded"}


def _open(space: dict[str, Any]) -> bool:
    return bool(space.get("worktree")) and Path(space["worktree"]).is_dir()


def _short(session: dict[str, Any]) -> str:
    return session["id"].replace("-", "")[:10]


def public(code: dict[str, Any] | None) -> dict[str, Any] | None:
    if not code:
        return None
    result = copy.deepcopy(code)
    for space in result["workspaces"]:
        space["open"] = _open(space)
    result["worktree_exists"] = any(space["open"] for space in result["workspaces"])
    result["files"] = [{**file, "folder_id": space["folder_id"]} for space in result["workspaces"] for file in space.get("files") or []]
    return result


# Hooks of the conversation engine (app.core.kernel.registry.agent_workspaces), called with its lock held.

def prepare(session: dict[str, Any], context: dict[str, Any], mode: str) -> None:
    """Attach the code and resources picked for this message: new worktrees, new folders to read."""
    code_ids = [str(item) for item in context.get("code_folder_ids") or []]
    resource_ids = [str(item) for item in context.get("resource_folder_ids") or []]
    code = session.get("code")
    if not code_ids and not resource_ids:
        if code and mode != "answer" and any(_open(space) for space in code["workspaces"]):
            _check_capacity(session)
        return
    project_id = int(context.get("project_id") or session.get("project_id") or 0)
    if not project_id:
        raise HTTPException(422, "Choose the project of this code.")
    if session.get("project_id") and int(session["project_id"]) != project_id:
        raise HTTPException(409, "This conversation belongs to another project: start a new one for this code.")
    project = folders.project(project_id)
    session["project_id"] = project_id
    if code and code["status"] in CLOSED and code_ids:
        if code["status"] == "accepted" and any(space.get("commit") and not space.get("merged") for space in code["workspaces"]):
            raise HTTPException(409, "Merge or delete the committed changes of this conversation before giving it code again.")
        # A new round of changes, on a new branch.
        code.update(workspaces=[], status="open", generation=code.get("generation", 0) + 1)
    code = session.setdefault("code", {"project_id": project_id, "workspaces": [], "resources": [], "status": "open", "generation": 0})
    known = {space["folder_id"] for space in code["workspaces"] if _open(space)}
    wanted = [item for item in dict.fromkeys(code_ids) if item not in known]
    if len(known) + len(wanted) > MAX_FOLDERS:
        raise HTTPException(422, f"An agent works on at most {MAX_FOLDERS} code folders.")
    for item in dict.fromkeys(resource_ids):
        if item in code_ids or any(entry["folder_id"] == item for entry in code["resources"]):
            continue
        folder = folders.entry(project, item)
        path = folders.linked_file(folder["path"]) if folder.get("file") else project_code.folder(folder["path"])
        code["resources"].append({"folder_id": folder["id"], "name": folder["name"], "path": str(path), **({"file": True} if folder.get("file") else {})})
    if not wanted:
        return
    if mode != "answer":
        _check_capacity(session)
    repositories = [_repository(project, item) for item in wanted]
    branch = f"kavot/agent/{_short(session)}" + (f"-{code['generation']}" if code.get("generation") else "")
    created: list[dict[str, Any]] = []
    try:
        for folder, base, head in repositories:
            index = len(code["workspaces"]) + len(created)
            worktree = store.worktrees() / f"{_short(session)}-{index}"
            worktree.parent.mkdir(parents=True, exist_ok=True)
            if worktree.is_dir() and not any(worktree.iterdir()):
                worktree.rmdir()  # The empty folder an earlier round of this conversation left as its working folder.
            gitview.run(base, "worktree", "add", "-b", branch, str(worktree), head, timeout=180)
            created.append({"folder_id": folder["id"], "name": folder["name"], "worktree": str(worktree), "branch": branch,
                            "base_sha": head, "base_branch": project_code.git(base, "symbolic-ref", "--short", "-q", "HEAD", optional=True).strip(),
                            "files": [], "commit": None, "merged": False, "_base": base})
    except ValueError as error:
        for space in created:  # Leave no half-created worktree behind.
            _remove_worktree(space["_base"], Path(space["worktree"]))
            _delete_branch(space["_base"], branch)
        raise HTTPException(409, f"Unable to create the worktree: {error}") from None
    for space in created:
        space.pop("_base")
    code["workspaces"].extend(created)
    code["status"] = "open"


def launch(session: dict[str, Any], mode: str) -> Workspace | None:
    code = session.get("code")
    if not code:
        return None
    spaces = [space for space in code["workspaces"] if _open(space)]
    readable = [item["path"] for item in code["resources"] if not item.get("file")]
    return Workspace(cwd=spaces[0]["worktree"] if spaces else "", write=mode != "answer" and bool(spaces),
                     writable=[space["worktree"] for space in spaces], readable=readable,
                     brief=_brief(session, code, spaces, mode), timeout=TIMEOUT if spaces else None)


def finish(session: dict[str, Any], run: dict[str, Any]) -> None:
    """Read what the agent changed in each worktree."""
    code = session.get("code")
    if not code or code["status"] not in OPEN:
        return
    for space in code["workspaces"]:
        if _open(space):
            space["files"] = [{key: item[key] for key in ("path", "status", "additions", "deletions")}
                              for item in _changes(Path(space["worktree"]))["files"]]
    code["status"] = "review" if any(space.get("files") for space in code["workspaces"] if _open(space)) else "open"


def forget(session: dict[str, Any]) -> None:
    """A conversation is removed: refuse while it holds changes to review, close its empty worktrees."""
    code = session.get("code")
    if not code:
        return
    spaces = [space for space in code["workspaces"] if _open(space)]
    if any(space.get("files") for space in spaces):
        raise HTTPException(409, "Commit or discard the code changes of this conversation first.")
    for space in spaces:
        base = _base(code, space)
        if base:
            _remove_worktree(base, Path(space["worktree"]))
            if not space.get("commit"):
                _delete_branch(base, space["branch"])


def _check_capacity(session: dict[str, Any]) -> None:
    busy = [run for run in sessions.active_runs() if run["session_id"] != session["id"] and getattr(run.get("space"), "write", False)]
    if len(busy) >= MAX_RUNNING:
        raise HTTPException(409, f"At most {MAX_RUNNING} agents can change code at the same time.")


def _brief(session: dict[str, Any], code: dict[str, Any], spaces: list[dict[str, Any]], mode: str) -> list[str]:
    lines = []
    shared = [item for item in code["resources"] if not item.get("file")]
    if shared:
        lines += ["Resource folders of the project (documents and data) you may read but must never change:",
                  *(f"- {item['name']}: {item['path']}" for item in shared)]
    if spaces:
        branch = spaces[0]["branch"]
        lines += [f"Code of the project, in Git worktrees on the branch {branch}:"]
        for space in spaces:
            origin = space.get("base_branch") or str(space.get("base_sha") or "")[:10]
            lines.append(f"- {space['name']}: {space['worktree']} — from {origin}")
        if mode == "answer":
            lines.append("Mode /plan: read the code to answer or plan; do not change any file.")
        else:
            lines += ["Exception to the read-only rule: you may edit code files directly, only inside these worktrees, "
                      "to do what is asked. Do not commit, push, merge or switch branches: Kavot shows your changes "
                      "to the user, who reviews them, then commits or discards them.",
                      "Keep the change focused on the request. Shell commands may be unavailable. "
                      "End with a short summary: what you changed, why, and how to test it."]
    # A linked file is given as its text, once: a resumed CLI session remembers it.
    if not session.get("vendor_session_id"):
        for item in [item for item in code["resources"] if item.get("file")]:
            try:
                content = preview.text(Path(item["path"]))
            except (OSError, HTTPException) as error:
                content = f"(Unreadable: {getattr(error, 'detail', error)})"
            lines += ["", f"## File: {item['name']}", content]
    return lines


# Git.

def _repository(project: dict[str, Any], folder_id: str) -> tuple[dict[str, Any], Path, str]:
    folder = folders.entry(project, folder_id)
    if folder.get("kind") == "resources" or folder.get("file"):
        raise HTTPException(422, f"“{folder['name']}” is read only: give it as a resource.")
    base = project_code.folder(folder["path"])
    if not project_code.inspect(str(base))["is_git"]:
        raise HTTPException(409, f"“{folder['name']}” is not a Git repository: agents change code in Git worktrees.")
    try:
        head = gitview.run(base, "rev-parse", "HEAD").strip()
    except ValueError:
        raise HTTPException(409, f"“{folder['name']}” has no commit yet: make a first commit, then start an agent.") from None
    return folder, base, head


def _base(code: dict[str, Any], space: dict[str, Any]) -> Path | None:
    try:
        return folders.root(folders.project(code["project_id"]), space["folder_id"])
    except HTTPException:
        return None  # The folder was unlinked or the project removed.


def _changes(worktree: Path) -> dict[str, Any]:
    # Intent-to-add makes new files part of the diff without staging their content.
    gitview.run(worktree, "add", "--all", "--intent-to-add")
    patch = gitview.run(worktree, "diff", "--no-color", "-M", "HEAD")
    patch, truncated = (patch[:gitview.MAX_DIFF], True) if len(patch) > gitview.MAX_DIFF else (patch, False)
    return {"files": gitview.split_patch(patch), "truncated": truncated}


def _remove_worktree(base: Path, worktree: Path) -> None:
    try:
        gitview.run(base, "worktree", "remove", "--force", str(worktree))
    except ValueError:
        shutil.rmtree(worktree, ignore_errors=True)
        try:
            gitview.run(base, "worktree", "prune")
        except ValueError:
            pass


def _delete_branch(base: Path, branch: str) -> None:
    try:
        gitview.run(base, "branch", "-D", branch)
    except ValueError:
        pass  # Already deleted by hand.


def _identity(worktree: Path) -> list[str]:
    try:
        if gitview.run(worktree, "config", "user.email").strip():
            return []
    except ValueError:
        pass
    return ["-c", "user.name=Kavot agent", "-c", "user.email=agent@kavot.local"]


# Review of the changes, by conversation.

def _code(session: dict[str, Any]) -> dict[str, Any]:
    if sessions.running(session["id"]):
        raise HTTPException(409, "Wait for the agent to finish, or stop it.")
    code = session.get("code")
    if not code or not code["workspaces"]:
        raise HTTPException(409, "This conversation has no code.")
    return code


def detail(session_id: str) -> dict[str, Any] | None:
    return public(sessions.get_session(session_id).get("code"))


def diff(session_id: str) -> dict[str, Any]:
    """The changes of each folder: live in its worktree, or its commit once accepted."""
    code = sessions.get_session(session_id).get("code") or {"workspaces": []}
    result = []
    for space in code["workspaces"]:
        try:
            if _open(space):
                changes = _changes(Path(space["worktree"]))
            elif space.get("commit") and (base := _base(code, space)):
                changes = gitview.commit(base, space["commit"])
            else:
                changes = {"files": [], "truncated": False}
        except (ValueError, HTTPException) as error:
            changes = {"files": [], "truncated": False, "error": str(getattr(error, "detail", error))}
        result.append({"folder_id": space["folder_id"], "name": space.get("name") or "", "files": changes["files"],
                       "truncated": changes.get("truncated", False), "error": changes.get("error")})
    return {"folders": result, "files": [{**f, "folder_id": item["folder_id"]} for item in result for f in item["files"]],
            "truncated": any(item["truncated"] for item in result)}


def accept(session_id: str, message_text: str, merge_after: bool = False) -> dict[str, Any] | None:
    """Commit the changes of every folder on its branch, then close the worktrees."""
    with sessions.editing(session_id) as session:
        code = _code(session)
        spaces = [space for space in code["workspaces"] if _open(space)]
        if code["status"] not in OPEN or not spaces:
            raise HTTPException(409, "This conversation has no open changes to commit.")
        try:
            changed = []
            for space in spaces:
                gitview.run(Path(space["worktree"]), "add", "--all")
                if gitview.run(Path(space["worktree"]), "status", "--porcelain").strip():
                    changed.append(space)
            if not changed:
                raise HTTPException(409, "The agent did not change any file.")
            text = message_text.strip() or session["title"]
            for space in changed:
                worktree = Path(space["worktree"])
                gitview.run(worktree, *_identity(worktree), "commit", "-m", text, "-m", f"Agent conversation {session['id']} ({session['engine']}) from Kavot.")
                space["commit"] = gitview.run(worktree, "rev-parse", "HEAD").strip()
        except ValueError as error:
            raise HTTPException(409, f"Unable to commit: {error}") from None
        for space in spaces:
            base = _base(code, space)
            if base:
                _remove_worktree(base, Path(space["worktree"]))
                if not space.get("commit"):  # Nothing changed in this folder: its branch is useless.
                    _delete_branch(base, space["branch"])
            space["worktree"] = None
        code["status"] = "accepted"
    return merge(session_id) if merge_after else detail(session_id)


def merge(session_id: str) -> dict[str, Any] | None:
    """Merge each committed branch into its folder's checkout; all checkouts are checked first."""
    with sessions.editing(session_id) as session:
        code = _code(session)
        pending = [space for space in code["workspaces"] if space.get("commit") and not space.get("merged")]
        if code["status"] != "accepted" or not pending:
            raise HTTPException(409, "Only committed, unmerged changes can be merged.")
        targets = []
        for space in pending:
            base = _base(code, space)
            label = space.get("name") or "the folder"
            if not base:
                raise HTTPException(409, f"{label} is no longer linked to the project.")
            current = project_code.git(base, "symbolic-ref", "--short", "-q", "HEAD", optional=True).strip()
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
                raise HTTPException(409, f"The merge into {current} ({space.get('name')}) failed and was cancelled: {error}") from None
            space["merged"] = True
        code["status"] = "merged"
    return detail(session_id)


def discard(session_id: str) -> dict[str, Any] | None:
    with sessions.editing(session_id) as session:
        code = _code(session)
        if code["status"] in {"discarded", "merged"}:
            raise HTTPException(409, "These changes are already closed.")
        for space in code["workspaces"]:
            base = _base(code, space)
            if space.get("worktree") and Path(space["worktree"]).exists():
                if base:
                    _remove_worktree(base, Path(space["worktree"]))
                else:
                    shutil.rmtree(space["worktree"], ignore_errors=True)
            if base and not space.get("merged"):
                _delete_branch(base, space["branch"])
            space["worktree"] = None
        code["status"] = "discarded"
    return detail(session_id)


def in_use(project_id: int, folder_id: str) -> bool:
    """A folder given to a conversation that still has changes to review."""
    for summary in sessions.list_sessions(project_id=project_id):
        code = summary.get("code") or {}
        if code.get("status") in OPEN and any(space["folder_id"] == folder_id and _open(space) for space in code.get("workspaces") or []):
            return True
    return False


def drop_legacy_runs() -> None:
    """Agent runs of the first Atelier (before conversations were shared) are deleted, with their worktrees.

    A committed branch is kept in its repository; uncommitted changes of an open worktree are lost.
    """
    try:
        project_ids = store.projects_with_state()
    except OSError:
        return
    for project_id in project_ids:
        with store.lock:
            doc = store.read(project_id)
            if "runs" not in doc:
                continue
            runs = doc.pop("runs") or []
            for run in runs:
                spaces = run.get("workspaces") or [{"folder_id": run.get("folder_id"), "worktree": run.get("worktree"),
                                                    "branch": run.get("branch"), "commit": run.get("commit")}]
                for space in spaces:
                    folder = next((item for item in doc["folders"] if item["id"] == space.get("folder_id")), None)
                    base = None
                    if folder:
                        try:
                            base = project_code.folder(folder["path"])
                        except HTTPException:
                            pass
                    if space.get("worktree") and Path(space["worktree"]).exists():
                        if base:
                            _remove_worktree(base, Path(space["worktree"]))
                        else:
                            shutil.rmtree(space["worktree"], ignore_errors=True)
                    if base and space.get("branch") and not space.get("commit"):
                        _delete_branch(base, space["branch"])
            store.write(project_id, doc)
    shutil.rmtree(store.base() / "chats", ignore_errors=True)

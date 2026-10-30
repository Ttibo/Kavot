"""Git history and diffs of a code folder (read-only), plus the few writes agent runs need."""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.core.projects import code as project_code

MAX_DIFF = 600_000
SHA = re.compile(r"^[0-9a-fA-F]{7,40}$")
FIELD, RECORD = "\x1f", "\x1e"


def log(base: Path, limit: int = 50, skip: int = 0) -> list[dict[str, Any]]:
    output = project_code.git(base, "log", f"--max-count={max(1, min(limit, 200))}", f"--skip={max(0, skip)}",
                              f"--format=%H{FIELD}%h{FIELD}%an{FIELD}%aI{FIELD}%D{FIELD}%s{RECORD}", optional=True)
    commits = []
    for record in output.split(RECORD):
        parts = record.strip("\n").split(FIELD)
        if len(parts) == 6:
            sha, short, author, date, refs, subject = parts
            commits.append({"sha": sha, "short": short, "author": author, "date": date,
                            "refs": [ref.strip() for ref in refs.split(",") if ref.strip()], "subject": subject})
    return commits


def split_patch(patch: str) -> list[dict[str, Any]]:
    """One entry per file of a unified diff, with its line counts."""
    files = []
    for chunk in re.split(r"(?m)^(?=diff --git )", patch):
        if not chunk.startswith("diff --git "):
            continue
        header = chunk.split("\n", 1)[0]
        match = re.match(r'diff --git "?a/(.+?)"? "?b/(.+?)"?$', header)
        old, new = (match.group(1), match.group(2)) if match else (header, header)
        status = "added" if "\nnew file mode" in chunk else "deleted" if "\ndeleted file mode" in chunk \
            else "renamed" if "\nrename from" in chunk else "modified"
        lines = chunk.split("\n")
        files.append({"path": new if status != "deleted" else old, "old_path": old, "status": status,
                      "binary": "\nBinary files" in chunk,
                      "additions": sum(1 for line in lines if line.startswith("+") and not line.startswith("+++")),
                      "deletions": sum(1 for line in lines if line.startswith("-") and not line.startswith("---")),
                      "patch": chunk})
    return files


def _limited(patch: str) -> tuple[str, bool]:
    return (patch[:MAX_DIFF], True) if len(patch) > MAX_DIFF else (patch, False)


def commit(base: Path, sha: str) -> dict[str, Any]:
    if not SHA.match(sha):
        raise HTTPException(422, "Invalid commit.")
    meta = project_code.git(base, "show", "-s", f"--format=%H{FIELD}%an{FIELD}%aI{FIELD}%B", sha).split(FIELD)
    patch, truncated = _limited(project_code.git(base, "show", "--no-color", "--format=", "--patch", "-M", sha))
    return {"sha": meta[0].strip(), "author": meta[1] if len(meta) > 1 else "", "date": meta[2] if len(meta) > 2 else "",
            "message": meta[3].strip() if len(meta) > 3 else "", "files": split_patch(patch), "truncated": truncated}


def working(base: Path) -> dict[str, Any]:
    """Uncommitted changes of the checkout, including new files (shown without staging them)."""
    has_head = bool(project_code.git(base, "rev-parse", "--verify", "-q", "HEAD", optional=True).strip())
    patch = project_code.git(base, "diff", "--no-color", "-M", *(["HEAD"] if has_head else ["--cached"]), optional=True)
    untracked = [name for name in project_code.git(base, "ls-files", "--others", "--exclude-standard", "-z",
                                                   optional=True).split("\0") if name][:200]
    patch, truncated = _limited(patch)
    files = split_patch(patch)
    files += [{"path": name, "old_path": name, "status": "untracked", "binary": False, "additions": 0, "deletions": 0,
               "patch": ""} for name in untracked]
    return {"files": files, "truncated": truncated}


def run(base: Path, *args: str, timeout: int = 60) -> str:
    """A Git command that may write (worktrees, commits). Raises ValueError with Git's message."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_TERMINAL_PROMPT="0")
    try:
        result = subprocess.run(["git", "--no-pager", "-c", "core.quotePath=false", "-C", str(base), *args],
                                capture_output=True, timeout=timeout, env=env,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError(f"Git did not answer: {error}") from None
    if result.returncode:
        message = (result.stderr or result.stdout).decode("utf-8", errors="replace").strip()
        raise ValueError(message[-800:] or "Git failed.")
    return result.stdout.decode("utf-8", errors="replace")

"""Install, update and sign in to the agent CLIs from the settings screen.

Commands come from a fixed table of official installers; nothing the user types
reaches a shell. The installers write to per-user folders, so no elevation is
needed. Signing in is interactive (browser or terminal UI), so Kavot opens a
terminal window and lets the user finish there.
"""
from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

WINDOWS = sys.platform == "win32"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
POWERSHELL = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]
MAX_LINES = 400
TIMEOUT = 900

# Ordered candidates per engine: the first whose program is available wins.
RECIPES = {
    "claude": {
        "win32": [{"needs": "powershell", "label": "official installer",
                   "command": [*POWERSHELL, "irm https://claude.ai/install.ps1 | iex"]}],
        "posix": [{"needs": "curl", "label": "official installer",
                   "command": ["bash", "-c", "curl -fsSL https://claude.ai/install.sh | bash"]}],
    },
    "codex": {
        "win32": [{"needs": "powershell", "label": "official installer", "env": {"CODEX_NON_INTERACTIVE": "1"},
                   "command": [*POWERSHELL, "irm https://chatgpt.com/codex/install.ps1 | iex"]}],
        "posix": [{"needs": "curl", "label": "official installer", "env": {"CODEX_NON_INTERACTIVE": "1"},
                   "command": ["sh", "-c", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"]},
                  {"needs": "npm", "label": "npm", "command": ["npm", "install", "-g", "@openai/codex@latest"]}],
    },
    "opencode": {
        "win32": [{"needs": "npm", "label": "npm", "command": ["npm", "install", "-g", "opencode-ai@latest"]},
                  {"needs": "scoop", "label": "Scoop", "command": ["scoop", "install", "opencode"]}],
        "posix": [{"needs": "curl", "label": "official installer",
                   "command": ["bash", "-c", "curl -fsSL https://opencode.ai/install | bash"]},
                  {"needs": "npm", "label": "npm", "command": ["npm", "install", "-g", "opencode-ai@latest"]}],
    },
}
MISSING = {
    "claude": "PowerShell or curl is required to run the Claude Code installer.",
    "codex": "PowerShell, curl or npm is required to install Codex.",
    "opencode": "Install Node.js (npm) or Scoop first; OpenCode has no native Windows installer."
                if WINDOWS else "curl or npm is required to install OpenCode.",
}
LOGIN = {"claude": ["auth", "login"], "codex": ["login"], "opencode": ["auth", "login"]}

_lock = threading.Lock()
_jobs: dict[str, dict] = {}
_ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")


def search_path() -> str:
    """PATH plus the folders the installers write to.

    Kavot keeps the PATH it started with, so a program installed since then is
    found only through the user's saved PATH or these known folders.
    """
    home = Path.home()
    folders = [home / ".local" / "bin", home / ".opencode" / "bin", home / "bin", home / ".npm-global" / "bin"]
    if WINDOWS:
        local, roaming = os.getenv("LOCALAPPDATA"), os.getenv("APPDATA")
        folders += [Path(local) / "Programs" / "OpenAI" / "Codex" / "bin"] if local else []
        folders += [Path(roaming) / "npm"] if roaming else []
        folders += [home / "scoop" / "shims"]
    else:
        folders += [Path("/opt/homebrew/bin"), Path("/usr/local/bin")]
    return os.pathsep.join([os.environ.get("PATH", ""), *_saved_user_path(), *map(str, folders)])


def _saved_user_path() -> list[str]:
    if not WINDOWS:
        return []
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            value, _ = winreg.QueryValueEx(key, "Path")
        return [os.path.expandvars(part) for part in str(value).split(os.pathsep) if part]
    except OSError:
        return []


def which(command: str) -> str | None:
    return shutil.which(command, path=search_path())


def recipe(engine: str) -> dict | None:
    for candidate in RECIPES[engine]["win32" if WINDOWS else "posix"]:
        program = which(candidate["command"][0])
        if program and which(candidate["needs"]):
            return {**candidate, "command": [program, *candidate["command"][1:]]}
    return None


def plan(engine: str) -> dict:
    """What the Install button will run, shown to the user before confirming."""
    chosen = recipe(engine)
    if not chosen:
        return {"engine": engine, "available": False, "message": MISSING[engine]}
    return {"engine": engine, "available": True, "method": chosen["label"],
            "command": " ".join([Path(chosen["command"][0]).stem, *chosen["command"][1:]])}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _public(job: dict) -> dict:
    return {key: value for key, value in job.items() if key != "process"}


def start(engine: str) -> dict:
    with _lock:
        running = next((job for job in _jobs.values() if job["engine"] == engine and job["status"] == "running"), None)
        if running:
            return _public(running)
        chosen = recipe(engine)
        if not chosen:
            raise HTTPException(422, MISSING[engine])
        job = {"id": uuid.uuid4().hex, "engine": engine, "status": "running", "method": chosen["label"],
               "lines": [], "path": None, "error": "", "started_at": _now(), "finished_at": None}
        _jobs[job["id"]] = job
    threading.Thread(target=_run, args=(job, chosen), daemon=True).start()
    return _public(job)


def _run(job: dict, chosen: dict) -> None:
    from app.core.agents import sessions
    environment = {**os.environ, "PATH": search_path(), **chosen.get("env", {})}
    try:
        process = subprocess.Popen(chosen["command"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                                   env=environment, creationflags=NO_WINDOW)
        job["process"] = process
        timer = threading.Timer(TIMEOUT, process.kill)
        timer.start()
        try:
            for line in process.stdout:
                line = _ansi.sub("", line).rstrip()
                if line.strip():
                    job["lines"] = [*job["lines"], line][-MAX_LINES:]
            code = process.wait()
        finally:
            timer.cancel()
        if code:
            raise RuntimeError(f"The installer stopped with code {code}.")
        path = sessions._resolve_executable(job["engine"])
        if not path:
            raise RuntimeError("The installer finished but the program was not found. Restart Kavot or give its path.")
        job.update(status="done", path=path)
    except (OSError, RuntimeError) as error:
        job.update(status="failed", error=str(error))
    finally:
        job.pop("process", None)
        job["finished_at"] = _now()


def get(job_id: str) -> dict:
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Installation not found.")
    return _public(job)


def login(engine: str) -> dict:
    """Open a terminal window running the CLI's sign-in command."""
    from app.core.agents import sessions
    binary = sessions._resolve_executable(engine)
    if not binary:
        raise HTTPException(422, "Install the program before signing in.")
    arguments = LOGIN[engine]
    shown = " ".join([Path(binary).stem, *arguments])
    try:
        if WINDOWS:
            quoted = "'" + binary.replace("'", "''") + "'"
            subprocess.Popen(["powershell", "-NoProfile", "-NoExit", "-Command", f"& {quoted} {' '.join(arguments)}"],
                             creationflags=subprocess.CREATE_NEW_CONSOLE, env={**os.environ, "PATH": search_path()})
        elif sys.platform == "darwin":
            script = shlex.join([binary, *arguments]).replace("\\", "\\\\").replace('"', '\\"')
            subprocess.Popen(["osascript", "-e", f'tell application "Terminal" to do script "{script}"',
                              "-e", 'tell application "Terminal" to activate'])
        else:
            terminal = next((which(name) for name in ("x-terminal-emulator", "gnome-terminal", "konsole", "xterm")
                             if which(name)), None)
            if not terminal:
                raise OSError("No terminal found.")
            command = f"{shlex.join([binary, *arguments])}; exec \"${{SHELL:-sh}}\""
            separator = ["--"] if Path(terminal).name == "gnome-terminal" else ["-e"]
            subprocess.Popen([terminal, *separator, "sh", "-c", command])
    except OSError:
        raise HTTPException(422, f"Unable to open a terminal. Run “{shown}” yourself.") from None
    return {"engine": engine, "command": shown}

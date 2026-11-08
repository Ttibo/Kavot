"""The agent CLIs Kavot drives (Codex, Claude Code, OpenCode): their settings and executables."""
from __future__ import annotations

import shutil
import subprocess
import sys
import threading
from pathlib import Path

from fastapi import HTTPException

from app.core.agents import install
from app.core.kernel.config import settings
from app.core.kernel.user_settings import load_integrations, save_integration

ENGINES = {
    "codex": {"name": "Codex", "command": "codex"},
    "claude": {"name": "Claude Code", "command": "claude"},
    "opencode": {"name": "OpenCode", "command": "opencode"},
}
SHIMS = {".cmd", ".bat", ".ps1"}
_lock = threading.Lock()


def resolve_executable(engine: str, configured: str = "", *, shims: bool = True) -> str | None:
    """The program to run: the configured path, else the one found on the PATH and installer folders.

    Without ``shims`` (programs that receive the user's text as arguments), a Windows batch
    shim is refused, so prompts never pass through cmd.exe expansion; OpenCode's npm shim is
    replaced by its native executable.
    """
    candidate = configured.strip() or install.which(ENGINES[engine]["command"])
    if not candidate:
        return None
    path = Path(candidate).expanduser()
    if not shims and sys.platform == "win32":
        if engine == "opencode" and path.suffix.lower() in {".cmd", ".ps1"}:
            native = path.parent / "node_modules" / "opencode-ai" / "bin" / "opencode.exe"
            if native.is_file():
                path = native
        if path.suffix.lower() in SHIMS:
            return None
    if not path.is_file():
        found = install.which(str(path)) if shims else shutil.which(str(path))
        if not found:
            return None
        path = Path(found)
    return str(path.resolve())


def configuration() -> dict:
    stored = load_integrations().get("external_agents") or {}
    result = {}
    for engine in ENGINES:
        values = stored.get(engine, {})
        result[engine] = {
            "enabled": bool(values.get("enabled", False)),
            "executable": str(values.get("executable", "")),
            "model": str(values.get("model", "")),
            "effort": str(values.get("effort", "")),
            # A lighter model and effort for questions (/answer), and the model that writes note summaries in the background.
            "answer_model": str(values.get("answer_model", "")),
            "answer_effort": str(values.get("answer_effort", "")),
            "digest_model": str(values.get("digest_model", "")),
            "access": values.get("access", "read"),
        }
    return result


def public_settings() -> dict:
    config = configuration()
    return {"engines": [{
        "id": engine, "name": meta["name"], **config[engine],
        "detected_path": resolve_executable(engine, config[engine]["executable"], shims=False),
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
    binary = resolve_executable(engine, executable or configuration()[engine]["executable"], shims=False)
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


def models(engine: str, executable: str = "", refresh: bool = False) -> dict:
    """The models the installed CLI offers (cached a few minutes)."""
    from app.core.agents.models import discover
    binary = resolve_executable(engine, executable or configuration()[engine]["executable"], shims=False)
    if not binary:
        raise HTTPException(422, "Program not found. Check its path in the settings.")
    settings.storage_path.mkdir(parents=True, exist_ok=True)
    return discover(engine, binary, str(settings.storage_path.resolve()), refresh)

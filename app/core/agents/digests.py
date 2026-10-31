"""Note summaries written in the background by a light model, so the chat model never spends output on them.

When an enabled engine has a summary model (``digest_model``), notes an agent reads
in full, or gets as briefs, without a current digest are queued here instead of
asking the chat agent to call save_digest. The CLI runs without any tool, with a
one-line system prompt; a digest is saved only if the note did not change meanwhile.
"""
from __future__ import annotations

import json
import logging
import subprocess
import threading
from pathlib import Path
from typing import Any

from app.core.kernel.config import settings
from app.core.kernel.user_settings import config_dir

logger = logging.getLogger(__name__)
NOTE_CHARS = 60_000
TIMEOUT = 180
SYSTEM = "You summarize research notes for an index. Reply with one JSON object only, no prose."
COMMANDS = {
    "claude": lambda binary, model: [binary, "-p", "--output-format", "json", "--model", model, "--tools", "",
                                     "--strict-mcp-config", "--setting-sources", "project", "--disable-slash-commands",
                                     "--no-session-persistence", "--system-prompt", SYSTEM],
    "codex": lambda binary, model: [binary, "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only",
                                    "-c", 'approval_policy="never"', "-c", 'model_reasoning_effort="low"', "--model", model, "-"],
}
_lock = threading.Lock()
_queue: dict[str, Path] = {}  # note ref -> the workspace it belongs to
_worker: threading.Thread | None = None


def engine() -> tuple[str, dict] | None:
    """The first enabled engine with a summary model."""
    from app.core.agents.sessions import configuration
    return next(((name, config) for name, config in configuration().items()
                 if config.get("enabled") and config.get("digest_model") and name in COMMANDS), None)


def queue(*refs: str) -> bool:
    """Summarize these notes in the background; False when no summary model is configured."""
    global _worker
    if not refs or engine() is None:
        return False
    with _lock:
        for ref in refs:
            _queue.setdefault(ref, settings.storage_path.resolve())
        if _worker is None:
            _worker = threading.Thread(target=_drain, daemon=True, name="kavot-digests")
            _worker.start()
    return True


def _drain() -> None:
    global _worker
    while True:
        with _lock:
            if not _queue:
                _worker = None
                return
            ref, workspace = next(iter(_queue.items()))
        try:
            if workspace == settings.storage_path.resolve():  # Not after switching workspace.
                summarize(ref)
        except Exception as error:  # One failed note must not stop the others.
            logger.warning("Background summary of %s failed: %s", ref, error)
        finally:
            with _lock:
                _queue.pop(ref, None)


def summarize(ref: str) -> dict[str, Any] | None:
    """Write the digest of a note, unless it has a current one or changes while being summarized."""
    from app.core.digest import levels, store
    from app.core.records.api import note_text
    found = engine()
    if found is None or not levels.needs_digest(ref):
        return None
    note_id = ref.rsplit("/", 1)[-1]
    version = store.content_version("notes", note_id)
    note, passages = note_text(note_id)
    if not passages:
        return None
    text = "\n\n".join(f"[{passage['anchor']}] {passage['text']}" for passage in passages)[:NOTE_CHARS]
    prompt = (f'Note "{note.get("title") or ""}". Its passages follow, each after its [anchor].\n'
              'Return {"summary": "...", "sections": {"<anchor>": "one sentence"}, "keywords": ["..."]}: '
              f"a summary of 2 to 5 sentences (at most {store.SUMMARY_CHARS} characters) of what the note says, "
              f"one sentence for each substantial passage (at most {store.MAX_SECTIONS}), at most {store.MAX_KEYWORDS} keywords. "
              "Only what the note says, in the note's language.\n\n" + text)
    name, config = found
    answer, usage = _run(name, config, prompt)
    data = _object(answer)
    anchors = {passage["anchor"] for passage in passages}
    sections = data.get("sections") if isinstance(data.get("sections"), dict) else {}
    sections = dict(list({k: v for k, v in sections.items() if k in anchors}.items())[:store.MAX_SECTIONS])
    keywords = [str(k) for k in data.get("keywords") or [] if k] if isinstance(data.get("keywords"), list) else []
    if store.content_version("notes", note_id) != version:
        return None
    return store.save(ref, str(data.get("summary") or "")[:store.SUMMARY_CHARS], sections=sections, keywords=keywords,
                      author={"kind": "agent", "engine": name, "model": config["digest_model"], "background": True, "usage": usage})


def _run(name: str, config: dict, prompt: str) -> tuple[str, dict]:
    from app.core.agents.sessions import _parse_result, _resolve_executable
    from app.core.agents.usage import Meter
    binary = _resolve_executable(name, config["executable"])
    if not binary:
        raise ValueError("Program not found.")
    # An empty folder of its own: nothing to read there, and no project instructions.
    cwd = config_dir() / "digest-runs"
    cwd.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(COMMANDS[name](binary, config["digest_model"]), input=prompt, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", cwd=cwd, timeout=TIMEOUT,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise ValueError((result.stderr or result.stdout or "The engine failed.").strip()[-600:])
    meter = Meter(name)
    for line in result.stdout.splitlines():
        try:
            meter.feed(json.loads(line))
        except ValueError:
            continue
    return _parse_result(name, result.stdout)[1], meter.value()


def _object(answer: str) -> dict:
    """The JSON object of an answer, even wrapped in a code fence or a sentence."""
    start, end = answer.find("{"), answer.rfind("}")
    try:
        value = json.loads(answer[start:end + 1]) if 0 <= start < end else None
    except ValueError:
        value = None
    if not isinstance(value, dict):
        raise ValueError("The summary is not a JSON object.")
    return value

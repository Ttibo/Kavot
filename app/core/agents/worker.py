"""One Claude Code process per conversation, kept between its messages.

Messages go in on stdin (stream-json), so the process does not start again, reload its
configuration and replay the conversation for every message. It stops after IDLE_SECONDS
without a message (the provider's prompt cache lasts minutes), when its settings change,
or when a request is stopped; the next message resumes the conversation (--resume).
"""
from __future__ import annotations

import json
import queue
import subprocess
import threading
from collections import deque

from app.core.agents import cli
from app.mcp import server as mcp_server
from app.mcp.session import ConversationSession

# A conversation's Claude Code process stops after this long without a message.
IDLE_SECONDS = 10 * 60

_lock = threading.Lock()
_workers: dict[str, "ClaudeWorker"] = {}


def terminate(process: subprocess.Popen) -> None:
    try:
        process.terminate()
        process.wait(timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        try:
            process.kill()
        except OSError:
            pass


class ClaudeWorker:
    def __init__(self, session_id: str, command: list[str], environment: dict, cwd: str, signature: tuple,
                 profile: str, emit):
        self.session_id, self.signature = session_id, signature
        self.session = ConversationSession({"status": "ended", "workspace": ""}, emit)
        self.session.profile = profile  # Claude Code lists the tools once, when the process starts.
        self.connection = mcp_server.attach(self.session)
        command = cli.connect("claude", command, environment, self.connection)
        self.process = subprocess.Popen(command + ["--input-format", "stream-json"], cwd=cwd, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                        errors="replace", env=environment,
                                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.lines: queue.Queue = queue.Queue()
        self.errors: deque[str] = deque(maxlen=200)
        self.cost: float | None = None  # The running cost the process reported after its last message.
        self.timer: threading.Timer | None = None
        threading.Thread(target=self._read, args=(self.process.stdout, self.lines.put), daemon=True).start()
        threading.Thread(target=self._read, args=(self.process.stderr, self.errors.append), daemon=True).start()

    @staticmethod
    def _read(stream, put) -> None:
        for line in stream:
            put(line)
        put(None)

    def alive(self) -> bool:
        return self.process.poll() is None

    def send(self, prompt: str) -> None:
        if self.timer:
            self.timer.cancel()
        message = {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": prompt}]}}
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def idle(self) -> None:
        self.timer = threading.Timer(IDLE_SECONDS, lambda: stop(self.session_id, self))
        self.timer.daemon = True
        self.timer.start()

    def close(self) -> None:
        if self.timer:
            self.timer.cancel()
        mcp_server.detach(self.connection.token)
        if self.alive():
            terminate(self.process)


def obtain(session_id: str, signature: tuple, start) -> tuple[ClaudeWorker, bool]:
    """The conversation's process, started with ``start()`` when it has none or its settings changed.

    Returns the worker and whether it was already running.
    """
    with _lock:
        worker = _workers.get(session_id)
    if worker and (not worker.alive() or worker.signature != signature):
        stop(session_id, worker)
        worker = None
    if worker is not None:
        return worker, True
    worker = start()
    with _lock:
        _workers[session_id] = worker
    return worker, False


def stop(session_id: str, worker: ClaudeWorker | None = None) -> None:
    """Stop the conversation's process (only ``worker`` when given: not a newer one)."""
    with _lock:
        current = _workers.get(session_id)
        if current is None or (worker is not None and current is not worker):
            return
        _workers.pop(session_id, None)
    current.close()


def stop_all() -> None:
    for session_id in list(_workers):
        stop(session_id)

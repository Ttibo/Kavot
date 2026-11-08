"""Terminals inside the app: an agent CLI in a pseudo-terminal, shown by xterm.js through a WebSocket.

Each console runs one agent CLI (connected to Kavot's MCP server like an external
terminal) for as long as the app runs or until the CLI exits. Its recent output is
kept, so a page that opens again (another tab, a reload) shows the screen back.
"""
from __future__ import annotations

import asyncio
import codecs
import os
import sys
import threading
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

WINDOWS = sys.platform == "win32"
BACKLOG_CHARS = 400_000
_lock = threading.Lock()
_consoles: dict[str, "Console"] = {}


class _Pty:
    """The pseudo-terminal of one process: pywinpty's ConPTY on Windows, the pty module elsewhere."""

    def __init__(self, argv: list[str], cwd: str, env: dict[str, str], cols: int, rows: int):
        if WINDOWS:
            from winpty import PtyProcess
            program = Path(argv[0])
            # Batch shims (npm installs) need their interpreter; the arguments are Kavot's own, never user text.
            if program.suffix.lower() in {".cmd", ".bat"}:
                argv = [os.environ.get("COMSPEC", "cmd.exe"), "/c", *argv]
            elif program.suffix.lower() == ".ps1":
                argv = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", *argv]
            self.process = PtyProcess.spawn(argv, cwd=cwd, env=env, dimensions=(rows, cols))
            return
        import pty
        self.pid, self.fd = pty.fork()
        if self.pid == 0:  # The child: become the program.
            try:
                os.chdir(cwd)
                os.execvpe(argv[0], argv, env)
            finally:
                os._exit(127)
        self.resize(cols, rows)
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

    def read(self) -> str:
        """Blocking; an empty string at the end of the process."""
        if WINDOWS:
            try:
                return self.process.read(65536) or ("" if not self.process.isalive() else "\0")
            except EOFError:
                return ""
        try:
            data = os.read(self.fd, 65536)
        except OSError:
            data = b""
        return self._decoder.decode(data, final=not data) if data else ""

    def write(self, data: str) -> None:
        if WINDOWS:
            self.process.write(data)
        else:
            os.write(self.fd, data.encode("utf-8"))

    def resize(self, cols: int, rows: int) -> None:
        if WINDOWS:
            self.process.setwinsize(rows, cols)
            return
        import fcntl
        import struct
        import termios
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def exit_code(self) -> int | None:
        if WINDOWS:
            return self.process.exitstatus
        try:
            _, status = os.waitpid(self.pid, os.WNOHANG)
            return os.waitstatus_to_exitcode(status) if status else None
        except ChildProcessError:
            return None

    def terminate(self) -> None:
        try:
            if WINDOWS:
                if self.process.isalive():
                    self.process.terminate(force=True)
            else:
                import signal
                os.kill(self.pid, signal.SIGHUP)
                os.close(self.fd)
        except OSError:
            pass


class Console:
    def __init__(self, engine: str, name: str, argv: list[str], cwd: str, env: dict[str, str], cols: int, rows: int):
        self.id = uuid.uuid4().hex
        self.engine, self.name, self.cwd = engine, name, cwd
        self.started_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self.status, self.exit_code = "running", None
        self._backlog: deque[str] = deque()
        self._size = 0
        self._listeners: set[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = set()
        self._lock = threading.Lock()
        self._pty = _Pty(argv, cwd, env, cols, rows)
        threading.Thread(target=self._pump, daemon=True, name=f"kavot-console-{engine}").start()

    def public(self) -> dict:
        return {"id": self.id, "engine": self.engine, "name": self.name, "cwd": self.cwd,
                "started_at": self.started_at, "status": self.status, "exit_code": self.exit_code}

    def _emit(self, message: dict | None) -> None:
        for loop, queue in list(self._listeners):
            try:
                loop.call_soon_threadsafe(queue.put_nowait, message)
            except RuntimeError:  # That page's loop is closed.
                self._listeners.discard((loop, queue))

    def _pump(self) -> None:
        while True:
            chunk = self._pty.read()
            if not chunk:
                break
            if chunk == "\0":
                continue
            with self._lock:
                self._backlog.append(chunk)
                self._size += len(chunk)
                while self._size > BACKLOG_CHARS and len(self._backlog) > 1:
                    self._size -= len(self._backlog.popleft())
                self._emit({"type": "output", "data": chunk})
        with self._lock:
            self.status, self.exit_code = "exited", self._pty.exit_code()
            self._emit({"type": "exit", "code": self.exit_code})

    def subscribe(self, loop: asyncio.AbstractEventLoop) -> tuple[str, asyncio.Queue]:
        """The screen so far, and a queue of what comes next (taken atomically: nothing lost or repeated)."""
        queue: asyncio.Queue = asyncio.Queue()
        with self._lock:
            self._listeners.add((loop, queue))
            if self.status == "exited":
                queue.put_nowait({"type": "exit", "code": self.exit_code})
            return "".join(self._backlog), queue

    def unsubscribe(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue) -> None:
        self._listeners.discard((loop, queue))

    def write(self, data: str) -> None:
        if self.status == "running":
            self._pty.write(data)

    def resize(self, cols: int, rows: int) -> None:
        if self.status == "running":
            self._pty.resize(max(2, min(cols, 1000)), max(2, min(rows, 500)))

    def terminate(self) -> None:
        self._pty.terminate()


def open_console(engine: str, cols: int = 120, rows: int = 32) -> dict:
    """Start an agent CLI in a new console, in the workspace folder, with Kavot's tools."""
    from app.core.agents import terminal
    argv, cwd, environment = terminal.agent_command(engine)
    env = {**os.environ, "PATH": terminal.install.search_path(), "TERM": "xterm-256color", "COLORTERM": "truecolor", **environment}
    try:
        console = Console(engine, terminal.ENGINES[engine]["name"], argv, str(cwd), env, cols, rows)
    except (OSError, ImportError) as error:
        raise HTTPException(500, f"Unable to start {terminal.ENGINES[engine]['name']}: {error}") from None
    with _lock:
        _consoles[console.id] = console
    return console.public()


def get(console_id: str) -> Console:
    console = _consoles.get(console_id)
    if console is None:
        raise HTTPException(404, "This agent terminal is closed.")
    return console


def list_consoles() -> list[dict]:
    return [console.public() for console in _consoles.values()]


def close(console_id: str) -> None:
    with _lock:
        console = _consoles.pop(console_id, None)
    if console:
        console.terminate()


def shutdown() -> None:
    with _lock:
        consoles = list(_consoles.values())
        _consoles.clear()
    for console in consoles:
        console.terminate()

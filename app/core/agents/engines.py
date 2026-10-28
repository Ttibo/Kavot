"""Discover models from the installed clients, without sending an inference request."""
from __future__ import annotations

import json
import queue
import re
import subprocess
import threading
import time
from contextlib import contextmanager

from fastapi import HTTPException

_cache: dict[tuple, tuple[float, dict]] = {}
_lock = threading.Lock()


@contextmanager
def _protocol(command: list[str], cwd: str):
    process = subprocess.Popen(command, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace",
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    messages: queue.Queue = queue.Queue()

    def read():
        try:
            for line in process.stdout:
                try:
                    messages.put(json.loads(line))
                except ValueError:
                    pass
        finally:
            messages.put(None)

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    deadline = time.monotonic() + 25

    def exchange(request: dict, accepts):
        process.stdin.write(json.dumps(request) + "\n")
        process.stdin.flush()
        while True:
            try:
                value = messages.get(timeout=max(.01, deadline - time.monotonic()))
            except queue.Empty:
                raise ValueError("The program does not answer the model request.") from None
            if value is None:
                raise ValueError("The program closed the model discovery connection.")
            if isinstance(value, dict) and accepts(value):
                if value.get("error"):
                    raise ValueError(str(value["error"]))
                return value

    try:
        yield process, exchange
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)
        reader.join(timeout=1)
        process.stdin.close()
        process.stdout.close()


def _codex(binary: str, cwd: str) -> list[dict]:
    with _protocol([binary, "app-server"], cwd) as (process, exchange):
        exchange({"id": 1, "method": "initialize", "params": {
            "clientInfo": {"name": "kavot", "version": "0.1.0"}}}, lambda m: m.get("id") == 1)
        process.stdin.write('{"method":"initialized"}\n')
        process.stdin.flush()
        models, cursor = [], None
        for index in range(100):
            result = exchange({"id": index + 2, "method": "model/list", "params": {
                "limit": 100, "cursor": cursor, "includeHidden": False}},
                lambda m: m.get("id") == index + 2)["result"]
            models.extend({"id": m.get("model") or m["id"], "name": m.get("displayName") or m["id"],
                           "efforts": [e["reasoningEffort"] for e in m.get("supportedReasoningEfforts", [])],
                           "default_effort": m.get("defaultReasoningEffort", ""),
                           "description": m.get("description", "")} for m in result["data"] if not m.get("hidden"))
            cursor = result.get("nextCursor")
            if not cursor:
                return models
        raise ValueError("The model catalog is too large.")


def _claude(binary: str, cwd: str) -> list[dict]:
    with _protocol([binary, "--print", "--input-format", "stream-json", "--output-format", "stream-json",
                    "--verbose", "--permission-mode", "plan", "--no-session-persistence"], cwd) as (_, exchange):
        reply = exchange({"type": "control_request", "request_id": "kavot-models",
                          "request": {"subtype": "initialize"}},
                         lambda m: m.get("type") == "control_response" and
                         m.get("response", {}).get("request_id") == "kavot-models")["response"]
        if reply.get("subtype") == "error":
            raise ValueError(str(reply.get("error", "Claude catalog unavailable.")))
        return [{"id": m["value"], "name": m.get("displayName") or m["value"],
                 "efforts": m.get("supportedEffortLevels", []), "description": m.get("description", "")}
                for m in reply.get("response", {}).get("models", [])]


def _opencode(binary: str, cwd: str, refresh: bool) -> list[dict]:
    result = subprocess.run([binary, "models", "--verbose", *(["--refresh"] if refresh else [])],
                            cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                            stdin=subprocess.DEVNULL, timeout=30,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise ValueError((result.stderr or "OpenCode catalog unavailable.")[-500:])
    output = re.sub(r"\x1b\[[0-9;]*m", "", result.stdout)
    models = []
    decoder = json.JSONDecoder()
    for match in re.finditer(r"(?m)^([\w.-]+/[^\s]+)\s*$", output):
        metadata = {}
        try:
            metadata, _ = decoder.raw_decode(output[match.end():].lstrip())
        except ValueError:
            pass
        models.append({"id": match[1], "name": metadata.get("name") or match[1],
                       "efforts": list((metadata.get("variants") or {}).keys()),
                       "description": match[1]})
    return models


def discover(engine: str, binary: str, cwd: str, refresh: bool = False) -> dict:
    key = (engine, binary, cwd)
    with _lock:
        cached = _cache.get(key)
        if cached and not refresh and time.monotonic() - cached[0] < 300:
            return cached[1]
    try:
        models = _codex(binary, cwd) if engine == "codex" else _claude(binary, cwd) if engine == "claude" else _opencode(binary, cwd, refresh)
        models = list({m["id"]: m for m in models}.values())
        if not models:
            raise ValueError("No models returned. Check the program’s connection to your account or provider.")
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        raise HTTPException(502, f"Unable to load models: {error}") from None
    value = {"engine": engine, "models": models, "source": "installed-client"}
    with _lock:
        _cache[key] = (time.monotonic(), value)
    return value

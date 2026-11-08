"""The MCP server: built once, served on loopback for as long as the app runs.

Agent CLIs started from Kavot receive its URL and a bearer token through their
launch configuration: the workspace token for terminal agents (it changes at every
app start), one token per chat conversation (see attach). Tokens never reach
browser code; browser origins are refused.
"""
from __future__ import annotations

import contextvars
import hashlib
import secrets
import socket
import sys
import threading
import time
from dataclasses import dataclass
from functools import wraps

import uvicorn
from fastapi import HTTPException
from starlette.responses import JSONResponse

from app.mcp import memo
from app.mcp.instructions import INSTRUCTIONS
from app.mcp.schemas import compact_schema, dumps
from app.mcp.session import SESSION, Session
from app.mcp.tools import ToolContext, install_all

TOKEN_ENV = "KAVOT_MCP_TOKEN"


def _sdk():
    """Load either SDK lazily so opening the desktop does not require MCP."""
    try:
        try:
            from mcp.server.mcpserver import MCPServer
        except ModuleNotFoundError as error:
            if error.name != "mcp.server.mcpserver":
                raise
            from mcp.server.fastmcp import FastMCP
            from mcp.types import ToolAnnotations
            return FastMCP, ToolAnnotations, False
        from mcp_types import ToolAnnotations
        return MCPServer, ToolAnnotations, True
    except ModuleNotFoundError as error:
        if error.name and not error.name.startswith("mcp"):
            raise
        raise RuntimeError(
            "The MCP SDK is missing or incomplete in this Python environment. Install it with the same interpreter:\n"
            f'"{sys.executable}" -m pip install "mcp>=2.3,<3"\nThen restart Kavot.'
        ) from error


def _transport_options():
    from mcp.server.transport_security import TransportSecuritySettings
    return {"stateless_http": True, "json_response": True,
            "transport_security": TransportSecuritySettings(allowed_hosts=["127.0.0.1:*"], allowed_origins=[])}


# Tool calls one chat request may make: every call rereads the whole conversation, so a
# runaway loop is stopped and the agent answers with what it has. Terminal agents (run id
# "mcp") are not limited: their CLI asks the user before each call.
TOOL_BUDGET = {"answer": 25, "propose": 60, "auto": 80}
# Hidden from a conversation that has only asked questions (/answer): it cannot change
# anything, so their definitions would only weigh on every model call.
CHANGE_HELPERS = {"list_actions", "get_action_schema"}
ANSWER_WRITES = {"save_digest"}


def _plain_arguments(kwargs: dict) -> str:
    return dumps({key: value.model_dump() if hasattr(value, "model_dump") else value for key, value in kwargs.items()})


def _call_key(name: str, arguments: str) -> str:
    return name + ":" + hashlib.sha1(arguments.encode("utf-8", "replace")).hexdigest()[:16]


def _admit(run: dict, name: str, key: str) -> None:
    """Refuse a call that already failed unchanged in this request, and calls past the request's budget."""
    if run.get("id") == "mcp":
        return
    failed = run.get("failed_calls") or {}
    if key in failed:
        raise ValueError(f"This exact {name} call already failed in this request ({failed[key]}). "
                         "Do not repeat it: change the arguments, use another tool, or tell the user what blocks.")
    limit = TOOL_BUDGET.get(run.get("mode"), max(TOOL_BUDGET.values()))
    run["tool_calls"] = run.get("tool_calls", 0) + 1
    if run["tool_calls"] > limit:
        raise ValueError(f"Tool budget of this request reached ({limit} calls). Stop calling tools: answer with "
                         "what you have and say what remains to do (the user can ask you to continue).")


def _hint(annotations, name: str):
    """An annotation hint under SDK 2's snake_case name or SDK 1's camelCase one."""
    camel = name.split("_")[0] + "".join(part.capitalize() for part in name.split("_")[1:])
    return getattr(annotations, name, getattr(annotations, camel, None))


def _writes(tools) -> set[str]:
    """Names of the tools that change the workspace (and the helpers only they need)."""
    names = set(CHANGE_HELPERS)
    for registered in tools:
        if _hint(getattr(registered, "annotations", None), "read_only_hint") is False and registered.name not in ANSWER_WRITES:
            names.add(registered.name)
    return names


# The session of the agent making the current call, set from its token (LocalAuth).
CURRENT: contextvars.ContextVar[Session | None] = contextvars.ContextVar("kavot_mcp_session", default=None)


def create_server(default: Session = SESSION):
    """Every tool of the core and the plugins; each call works in its caller's session."""
    Server, ToolAnnotations, v2 = _sdk()
    # v2 moves transport settings from the constructor to the ASGI app factory.
    server = Server("Kavot", instructions=INSTRUCTIONS, log_level="WARNING", **({} if v2 else _transport_options()))
    if v2:
        from mcp.server.mcpserver.exceptions import ToolError
    else:
        from mcp.server.fastmcp.exceptions import ToolError

    def tool(**options):
        """Run with the session lock, report expected domain errors to the agent, return one compact JSON text block."""
        def decorate(function):
            annotations = options.get("annotations")
            # Local reads give the same result for the same call while the item is unchanged.
            remembered = _hint(annotations, "read_only_hint") is True and not _hint(annotations, "open_world_hint")

            @wraps(function)
            def checked(*args, **kwargs):
                session = CURRENT.get() or default
                token = CURRENT.set(session)  # Plugins and tools read it through ctx.session.
                arguments = _plain_arguments(kwargs)
                run, key = None, _call_key(function.__name__, arguments)
                try:
                    with session.lock:
                        admitted = session.current()
                        # A tool call's arguments, short, for the conversation's activity.
                        session.emit("tool", function.__name__.replace("_", " ").capitalize(),
                                     arguments if len(arguments) <= 300 else arguments[:300] + "…")
                        _admit(admitted, function.__name__, key)
                        run = admitted
                        result = function(*args, **kwargs)
                except (ValueError, HTTPException, FileNotFoundError) as error:
                    message = str(getattr(error, "detail", error))
                    if run is not None and run.get("id") != "mcp":
                        # Remembered for this request: the same call again is refused without running.
                        run.setdefault("failed_calls", {})[key] = message[:300]
                    raise ToolError(message) from None
                finally:
                    CURRENT.reset(token)
                text = result if isinstance(result, str) else dumps(result)
                if remembered and run.get("id") != "mcp":
                    text = memo.recall(run.get("session_id"), run.get("id"), function.__name__, key, result, text)
                return text
            try:
                return server.tool(structured_output=False, **options)(checked)
            except TypeError:  # SDKs without structured output keep their default.
                return server.tool(**options)(checked)
        return decorate

    install_all(ToolContext(
        default=default, tool=tool, annotations=ToolAnnotations,
        read_only=ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False),
        network_read=ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=True)))
    manager = getattr(server, "_tool_manager", None)
    if manager is None or not hasattr(manager, "list_tools"):
        return server
    for registered in manager.list_tools():
        if isinstance(getattr(registered, "parameters", None), dict):
            registered.parameters = compact_schema(registered.parameters)
    writes = _writes(manager.list_tools())
    listed = manager.list_tools

    def list_tools(*args, **kwargs):
        """The tools the calling session may use: a read-only conversation does not see the write tools."""
        tools = listed(*args, **kwargs)
        session = CURRENT.get() or default
        return [item for item in tools if item.name not in writes] if session.profile == "read" else tools
    manager.list_tools = list_tools
    return server


# Capability tokens given only to the agent CLIs Kavot starts, never to browser code: token -> session.
_tokens: dict[str, Session] = {}


def _session_of(header: bytes) -> Session | None:
    presented = header.decode("latin-1").removeprefix("Bearer ").encode()
    for token, session in list(_tokens.items()):
        if secrets.compare_digest(presented, token.encode()):
            return session
    return None


class LocalAuth:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope["headers"])
            if b"origin" in headers:
                await JSONResponse({"error": "Browser origins are not allowed."}, status_code=403)(scope, receive, send)
                return
            session = _session_of(headers.get(b"authorization", b""))
            if session is None:
                await JSONResponse({"error": "Unauthorized"}, status_code=401)(scope, receive, send)
                return
            CURRENT.set(session)
        await self.app(scope, receive, send)


@dataclass(frozen=True)
class Connection:
    url: str
    token: str


_lock = threading.Lock()
_worker: uvicorn.Server | None = None
_thread: threading.Thread | None = None
_connection: Connection | None = None


def start() -> Connection:
    """Serve the tools on an OS-selected loopback port; idempotent."""
    global _worker, _thread, _connection
    with _lock:
        if _connection is not None and _thread is not None and _thread.is_alive():
            return _connection
        token = secrets.token_urlsafe(32)
        server = create_server()
        _, _, v2 = _sdk()
        app = LocalAuth(server.streamable_http_app(**(_transport_options() if v2 else {})))
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        url = f"http://127.0.0.1:{listener.getsockname()[1]}/mcp"
        worker = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", log_config=None, access_log=False,
                                               lifespan="on", loop="asyncio", timeout_graceful_shutdown=2))
        thread = threading.Thread(target=worker.run, kwargs={"sockets": [listener]}, daemon=True, name="kavot-mcp")
        thread.start()
        deadline = time.monotonic() + 10
        while not worker.started:
            if not thread.is_alive() or time.monotonic() >= deadline:
                worker.should_exit = True
                listener.close()
                raise RuntimeError("Unable to start the Kavot MCP server.")
            time.sleep(0.01)
        _tokens.clear()
        _tokens[token] = SESSION
        _worker, _thread, _connection = worker, thread, Connection(url, token)
        return _connection


def attach(session: Session) -> Connection:
    """A token of its own for a session (a chat conversation); detach it when the agent process ends."""
    base = start()
    token = secrets.token_urlsafe(32)
    with _lock:
        _tokens[token] = session
    return Connection(base.url, token)


def detach(token: str) -> None:
    with _lock:
        _tokens.pop(token, None)


def connection() -> Connection:
    """The running server's address, starting it when needed (a test client, a failed start)."""
    return start()


def stop() -> None:
    global _worker, _thread, _connection
    with _lock:
        if _worker is not None:
            _worker.should_exit = True
        if _thread is not None:
            _thread.join(timeout=5)
        _worker = _thread = _connection = None
        _tokens.clear()

"""Agent CLIs in a terminal inside the app (advanced). Conversations are in external_agents."""
import asyncio
import contextlib
import json
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from app.core.agents import consoles

router = APIRouter(prefix="/agents", tags=["agents"])
Engine = Literal["claude", "codex", "opencode"]


class ConsoleCreate(BaseModel):
    engine: Engine
    cols: int = Field(default=120, ge=20, le=1000)
    rows: int = Field(default=32, ge=5, le=500)


@router.get("/consoles")
def list_consoles():
    return consoles.list_consoles()


@router.post("/consoles", status_code=201)
def open_console(payload: ConsoleCreate):
    """Start the agent in a terminal inside the app."""
    return consoles.open_console(payload.engine, payload.cols, payload.rows)


@router.delete("/consoles/{console_id}", status_code=204)
def close_console(console_id: str) -> None:
    consoles.close(console_id)


LOOPBACK = {"127.0.0.1", "localhost", "::1"}


def _local_page(websocket: WebSocket) -> bool:
    """Only the app's own page may drive a terminal: a WebSocket is not bound by the same-origin policy,
    so a page from any website could otherwise type commands into it."""
    origin = websocket.headers.get("origin")
    return bool(origin) and urlsplit(origin).hostname in LOOPBACK


@router.websocket("/consoles/{console_id}/ws")
async def console_socket(websocket: WebSocket, console_id: str):
    """Output as {"type": "output"|"exit"}; input as {"type": "input", "data"} and {"type": "resize", "cols", "rows"}."""
    if not _local_page(websocket):
        await websocket.close(code=4403)
        return
    try:
        console = consoles.get(console_id)
    except Exception:  # noqa: BLE001 - an unknown or closed console
        await websocket.close(code=4404)
        return
    await websocket.accept()
    loop = asyncio.get_running_loop()
    screen, queue = console.subscribe(loop)

    async def send_output():
        if screen:
            await websocket.send_text(json.dumps({"type": "output", "data": screen}))
        while True:
            message = await queue.get()
            await websocket.send_text(json.dumps(message))

    sender = asyncio.create_task(send_output())
    try:
        while True:
            message = json.loads(await websocket.receive_text())
            if message.get("type") == "input" and isinstance(message.get("data"), str):
                await asyncio.to_thread(console.write, message["data"])
            elif message.get("type") == "resize":
                console.resize(int(message.get("cols") or 80), int(message.get("rows") or 24))
    except (WebSocketDisconnect, ValueError, TypeError):
        pass
    finally:
        console.unsubscribe(loop, queue)
        sender.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await sender

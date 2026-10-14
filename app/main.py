import asyncio
import contextlib
import json
import logging
import os
import re
import secrets
import socket
from contextlib import asynccontextmanager
from pathlib import Path

import redis.asyncio as redis
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .crdt import CLIENT_ID
from .rooms import Client, DuplicateClient, Limits, RoomFull, RoomManager
from .store import MemoryBus, MemoryStore, RedisBus, RedisStore

log = logging.getLogger("whiteboard")
STATIC = Path(__file__).parent / "static"
ROOM_ID = re.compile(r"^[a-z0-9-]{3,40}$")
MAX_MESSAGE = 256 * 1024
ADJECTIVES = ["amber", "brisk", "calm", "coral", "dusky", "ember", "frosty", "golden", "hazel", "ivory", "jade", "lunar"]
NOUNS = ["otter", "heron", "lynx", "maple", "comet", "fjord", "pebble", "willow", "falcon", "harbor", "meadow", "quartz"]


def new_room_id() -> str:
    return f"{secrets.choice(ADJECTIVES)}-{secrets.choice(NOUNS)}-{secrets.randbelow(9000) + 1000}"


def clean_name(raw: str) -> str:
    name = "".join(ch for ch in raw if ch.isprintable()).strip()[:24]
    return name or "Guest"


def build_backends():
    url = os.environ.get("REDIS_URL") or os.environ.get("KV_URL")
    if not url:
        return MemoryStore(), MemoryBus()
    client = redis.from_url(url, decode_responses=True, socket_connect_timeout=2)
    return RedisStore(client), RedisBus(client)


def create_app(store=None, bus=None, limits: Limits = Limits(), instance_id: str | None = None) -> FastAPI:
    if store is None or bus is None:
        default_store, default_bus = build_backends()
        store, bus = store or default_store, bus or default_bus
    instance = instance_id or f"{socket.gethostname()}-{secrets.token_hex(3)}"
    manager = RoomManager(store, bus, instance, limits)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        log.info("instance=%s store=%s", instance, type(store).__name__)
        yield
        await manager.close()
        await bus.close()
        await store.close()

    app = FastAPI(title="Canvas", description="A collaborative whiteboard built on a hand-written CRDT.",
                  version="1.0.0", lifespan=lifespan)
    app.state.manager = manager
    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/", include_in_schema=False)
    async def index() -> RedirectResponse:
        return RedirectResponse(f"/r/{new_room_id()}", status_code=302)

    @app.get("/r/{room_id}", include_in_schema=False)
    async def board(room_id: str):
        if not ROOM_ID.match(room_id):
            return RedirectResponse("/", status_code=302)
        return FileResponse(STATIC / "board.html")

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok", "instance": instance, "rooms": len(manager.rooms)}

    @app.get("/api/rooms/{room_id}")
    async def room_info(room_id: str) -> JSONResponse:
        room = manager.rooms.get(room_id)
        if room is None:
            return JSONResponse({"error": "That room isn't open on this instance."}, status_code=404)
        return JSONResponse({"id": room_id, "clients": len(room.clients), "shapes": room.doc.visible()})

    @app.websocket("/ws/{room_id}")
    async def socket_endpoint(ws: WebSocket, room_id: str, client: str = "", name: str = "") -> None:
        if not ROOM_ID.match(room_id) or not CLIENT_ID.match(client):
            await ws.close(code=1008, reason="Bad room or client id")
            return
        await ws.accept()
        me = Client(id=client, name=clean_name(name))
        try:
            room = await manager.join(room_id, me)
        except RoomFull:
            await ws.close(code=1013, reason="This board is full right now")
            return
        except DuplicateClient:
            await ws.close(code=1008, reason="Already connected")
            return

        async def pump() -> None:
            # One writer per socket: everything this client should see goes through its outbox.
            while True:
                message = await me.outbox.get()
                await ws.send_text(json.dumps(message, separators=(",", ":")))

        await ws.send_text(json.dumps(manager.welcome(room, me), separators=(",", ":")))
        sender = asyncio.create_task(pump())
        dropped = asyncio.create_task(me.dropped.wait())
        try:
            while True:
                receive = asyncio.create_task(ws.receive_text())
                done, _ = await asyncio.wait({receive, dropped}, return_when=asyncio.FIRST_COMPLETED)
                if dropped in done:
                    receive.cancel()
                    await ws.close(code=1013, reason="Too far behind; reconnecting will resync")
                    break
                text = receive.result()
                if len(text) > MAX_MESSAGE:
                    await ws.close(code=1009, reason="Message too large")
                    break
                try:
                    message = json.loads(text)
                except ValueError:
                    continue
                if isinstance(message, dict):
                    await manager.handle(room, me, message)
        except WebSocketDisconnect:
            pass
        finally:
            for task in (sender, dropped):
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
            await manager.leave(room, me)

    return app


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
app = create_app()

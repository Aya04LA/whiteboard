"""Rooms: who's connected, the merged doc, fan-out, and the per-connection limits.

Fan-out rules:
  - Document ops are never dropped. A client too slow to keep up is
    disconnected instead; on reconnect it gets a full snapshot, and the CRDT
    makes catching up a plain merge.
  - Cursor updates are disposable: when a client's outbox is backing up,
    cursors for it are skipped (the next one supersedes them anyway).
"""

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass, field

from .crdt import Doc, InvalidOp, Op, validate_op

log = logging.getLogger("whiteboard.rooms")

CURSOR_COLORS = ["#0a84ff", "#ff375f", "#30d158", "#ff9f0a", "#bf5af2", "#64d2ff", "#ffd60a", "#ac8e68"]


@dataclass(frozen=True)
class Limits:
    max_clients: int = 30
    max_shapes: int = 5000
    ops_per_second: float = 30.0
    ops_burst: float = 60.0
    cursors_per_second: float = 30.0
    max_ops_per_message: int = 200
    outbox_limit: int = 1000  # messages; past this the client is dropped
    cursor_skip_at: int = 50  # outbox depth past which cursors are skipped
    compact_every: int = 200  # log entries
    idle_room_seconds: float = 30.0


class TokenBucket:
    def __init__(self, rate: float, burst: float) -> None:
        self.rate, self.burst = rate, burst
        self.tokens, self.at = burst, time.monotonic()

    def take(self) -> bool:
        now = time.monotonic()
        self.tokens = min(self.burst, self.tokens + (now - self.at) * self.rate)
        self.at = now
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False


class RoomFull(Exception):
    pass


class DuplicateClient(Exception):
    pass


@dataclass
class Client:
    id: str
    name: str
    color: str = ""
    cursor: list | None = None
    outbox: asyncio.Queue = field(default_factory=asyncio.Queue)
    ops_bucket: TokenBucket | None = None
    cursor_bucket: TokenBucket | None = None
    dropped: asyncio.Event = field(default_factory=asyncio.Event)

    def peer(self) -> dict:
        return {"id": self.id, "name": self.name, "color": self.color, "cursor": self.cursor}


@dataclass
class Room:
    id: str
    doc: Doc = field(default_factory=Doc)
    clients: dict[str, Client] = field(default_factory=dict)
    remote_peers: dict[str, dict] = field(default_factory=dict)  # peers on other instances
    log_length: int = 0
    evict_task: asyncio.Task | None = None


class RoomManager:
    def __init__(self, store, bus, instance_id: str, limits: Limits = Limits(), clock=time.time) -> None:
        self.store = store
        self.bus = bus
        self.instance = instance_id
        self.limits = limits
        self.clock = clock
        self.rooms: dict[str, Room] = {}
        self._loading: dict[str, asyncio.Lock] = {}
        self._handlers: dict[str, object] = {}  # room id -> its bus subscription

    async def _room(self, room_id: str) -> Room:
        room = self.rooms.get(room_id)
        if room:
            return room
        lock = self._loading.setdefault(room_id, asyncio.Lock())
        async with lock:  # two clients joining at once load the room once
            if room_id not in self.rooms:
                room = Room(room_id)
                room.doc.apply(await self.store.load(room_id))
                self.rooms[room_id] = room
                await self.bus.subscribe(room_id, self._handler(room_id))
                # People who joined on other instances before we subscribed never
                # sent us a "join". Ask them to announce themselves again.
                await self.bus.publish(room_id, {"t": "who", "origin": self.instance})
            return self.rooms[room_id]

    def _handler(self, room_id: str):
        async def on_message(message: dict) -> None:
            await self._from_bus(room_id, message)

        self._handlers[room_id] = on_message
        return on_message

    # ---------- Membership ----------

    async def join(self, room_id: str, client: Client) -> Room:
        room = await self._room(room_id)
        if room.evict_task:
            room.evict_task.cancel()
            room.evict_task = None
        if len(room.clients) >= self.limits.max_clients:
            raise RoomFull(room_id)
        if client.id in room.clients:
            raise DuplicateClient(client.id)
        used = {c.color for c in room.clients.values()} | {p["color"] for p in room.remote_peers.values()}
        client.color = next((c for c in CURSOR_COLORS if c not in used), CURSOR_COLORS[hash(client.id) % 8])
        client.ops_bucket = TokenBucket(self.limits.ops_per_second, self.limits.ops_burst)
        client.cursor_bucket = TokenBucket(self.limits.cursors_per_second, self.limits.cursors_per_second)
        room.clients[client.id] = client
        await self._fan_out(room, {"t": "join", "peer": client.peer()}, exclude=client.id)
        return room

    def welcome(self, room: Room, client: Client) -> dict:
        now = self.clock()
        peers = [c.peer() for c in room.clients.values() if c.id != client.id]
        peers += [p for p in room.remote_peers.values() if now - p.get("seen", now) < 60]
        return {
            "t": "welcome",
            "you": client.peer(),
            "doc": room.doc.to_ops(),
            "peers": [{k: v for k, v in p.items() if k != "seen"} for p in peers],
        }

    async def leave(self, room: Room, client: Client) -> None:
        if room.clients.get(client.id) is client:
            del room.clients[client.id]
        await self._fan_out(room, {"t": "leave", "id": client.id})
        if not room.clients:
            room.evict_task = asyncio.create_task(self._evict_later(room))

    async def _evict_later(self, room: Room) -> None:
        # Keep an empty room warm briefly: people reload, or reconnect after a blip.
        await asyncio.sleep(self.limits.idle_room_seconds)
        if not room.clients and self.rooms.get(room.id) is room:
            del self.rooms[room.id]
            await self.bus.unsubscribe(room.id, self._handlers.pop(room.id))

    # ---------- Messages from clients ----------

    async def handle(self, room: Room, client: Client, message: dict) -> None:
        kind = message.get("t")
        if kind == "ops":
            await self._ops(room, client, message.get("ops"))
        elif kind == "cursor":
            if client.cursor_bucket.take():  # over the limit: silently skip, cursors are disposable
                x, y = message.get("x"), message.get("y")
                client.cursor = [x, y] if _finite(x) and _finite(y) else None
                await self._fan_out(room, {"t": "cursor", "id": client.id, "cursor": client.cursor}, exclude=client.id)
        else:
            self._send(client, {"t": "error", "message": "Unknown message type."})

    async def _ops(self, room: Room, client: Client, raw) -> None:
        if not client.ops_bucket.take():
            self._send(client, {"t": "error", "message": "Slow down: too many updates per second."})
            return
        if not isinstance(raw, list) or not 0 < len(raw) <= self.limits.max_ops_per_message:
            self._send(client, {"t": "error", "message": "An update must contain 1–200 changes."})
            return
        now_ms = int(self.clock() * 1000)
        try:
            ops = [validate_op(op, now_ms) for op in raw]
        except InvalidOp as e:
            self._send(client, {"t": "error", "message": f"Rejected update: {e}."})
            return
        new_ids = {op["id"] for op in ops if op["id"] not in room.doc.records}
        if new_ids and len(room.doc) + len(new_ids) > self.limits.max_shapes:
            self._send(client, {"t": "error", "message": "This board is full. Start a new one."})
            return
        effective = room.doc.apply(ops)
        if not effective:
            return  # stale or duplicate: nothing to store or tell anyone
        await self._persist(room, effective)
        await self._fan_out(room, {"t": "ops", "ops": effective, "from": client.id}, exclude=client.id)

    async def _persist(self, room: Room, ops: list[Op]) -> None:
        room.log_length = await self.store.append(room.id, ops)
        if room.log_length >= self.limits.compact_every:
            room.log_length = 0
            asyncio.create_task(self._compact(room.id))

    async def _compact(self, room_id: str) -> None:
        try:
            await self.store.compact(room_id)
        except Exception:
            log.exception("compaction failed for %s", room_id)

    # ---------- Fan-out ----------

    async def _fan_out(self, room: Room, message: dict, exclude: str | None = None) -> None:
        self._deliver_local(room, message, exclude)
        try:
            await self.bus.publish(room.id, {**message, "origin": self.instance})
        except Exception:
            log.warning("bus publish failed; other instances will resync from the log", exc_info=True)

    def _deliver_local(self, room: Room, message: dict, exclude: str | None = None) -> None:
        for client in room.clients.values():
            if client.id != exclude:
                self._send(client, message)

    def _send(self, client: Client, message: dict) -> None:
        depth = client.outbox.qsize()
        if message.get("t") == "cursor" and depth >= self.limits.cursor_skip_at:
            return
        if depth >= self.limits.outbox_limit:
            client.dropped.set()  # too slow: disconnect; it resyncs from a snapshot on reconnect
            return
        client.outbox.put_nowait(message)

    async def _from_bus(self, room_id: str, message: dict) -> None:
        if message.get("origin") == self.instance:
            return
        room = self.rooms.get(room_id)
        if room is None:
            return
        kind = message.get("t")
        if kind == "ops":
            effective = room.doc.apply(message.get("ops", []))
            if effective:  # already persisted by the origin instance
                self._deliver_local(room, {"t": "ops", "ops": effective, "from": message.get("from")})
            return
        if kind == "who":
            for client in room.clients.values():
                await self.bus.publish(room_id, {"t": "join", "peer": client.peer(), "origin": self.instance})
            return
        if kind == "join":
            room.remote_peers[message["peer"]["id"]] = {**message["peer"], "seen": self.clock()}
        elif kind == "leave":
            room.remote_peers.pop(message.get("id"), None)
        elif kind == "cursor":
            peer = room.remote_peers.get(message.get("id"))
            if peer is not None:
                peer["cursor"], peer["seen"] = message.get("cursor"), self.clock()
        self._deliver_local(room, {k: v for k, v in message.items() if k != "origin"})

    async def close(self) -> None:
        for room in self.rooms.values():
            if room.evict_task:
                room.evict_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await room.evict_task


def _finite(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and abs(v) < 1e7

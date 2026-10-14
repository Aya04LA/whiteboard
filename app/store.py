"""Persistence (op log + snapshot) and the cross-instance bus (pub/sub).

Each room is stored as a snapshot plus an append-only log of deltas. Loading
a room merges the snapshot with every logged delta. Because the merge is
idempotent and order-independent, the log can contain duplicates or overlap
the snapshot and the result is still correct, so instances never need to
coordinate writes. Compaction (folding the log into the snapshot) takes a
short Redis lock so that only one instance trims the log at a time.
"""

import asyncio
import json
import logging
from collections import defaultdict
from collections.abc import Awaitable, Callable

import redis.asyncio as redis

from .crdt import Doc, Op

log = logging.getLogger("whiteboard.store")

ROOM_TTL = 7 * 24 * 3600  # demo boards expire after a week of inactivity


def merged(*batches: list[Op]) -> list[Op]:
    doc = Doc()
    for batch in batches:
        doc.apply(batch)
    return doc.to_ops()


class MemoryStore:
    def __init__(self) -> None:
        self._log: dict[str, list[list[Op]]] = defaultdict(list)
        self._snap: dict[str, list[Op]] = {}

    async def load(self, room: str) -> list[Op]:
        return merged(self._snap.get(room, []), *self._log.get(room, []))

    async def append(self, room: str, ops: list[Op]) -> int:
        self._log[room].append(ops)
        return len(self._log[room])

    async def compact(self, room: str) -> None:
        self._snap[room] = merged(self._snap.get(room, []), *self._log.pop(room, []))

    async def close(self) -> None:
        pass


class RedisStore:
    def __init__(self, client: redis.Redis) -> None:
        self._r = client

    def _keys(self, room: str) -> tuple[str, str, str]:
        return f"wb:{room}:log", f"wb:{room}:snap", f"wb:{room}:compacting"

    async def load(self, room: str) -> list[Op]:
        log_key, snap_key, _ = self._keys(room)
        async with self._r.pipeline(transaction=False) as p:
            p.get(snap_key)
            p.lrange(log_key, 0, -1)
            snap, entries = await p.execute()
        return merged(json.loads(snap) if snap else [], *(json.loads(e) for e in entries))

    async def append(self, room: str, ops: list[Op]) -> int:
        log_key, snap_key, _ = self._keys(room)
        async with self._r.pipeline(transaction=False) as p:
            p.rpush(log_key, json.dumps(ops, separators=(",", ":")))
            p.expire(log_key, ROOM_TTL)
            p.expire(snap_key, ROOM_TTL)
            length, *_ = await p.execute()
        return length

    async def compact(self, room: str) -> None:
        log_key, snap_key, lock_key = self._keys(room)
        if not await self._r.set(lock_key, "1", nx=True, ex=10):
            return  # another instance is compacting this room
        try:
            # Fold exactly the first n entries into the snapshot, then trim those n.
            # Entries appended meanwhile (by any instance) sit after n and survive.
            n = await self._r.llen(log_key)
            snap = await self._r.get(snap_key)
            entries = await self._r.lrange(log_key, 0, n - 1)
            folded = merged(json.loads(snap) if snap else [], *(json.loads(e) for e in entries))
            async with self._r.pipeline(transaction=True) as p:
                p.set(snap_key, json.dumps(folded, separators=(",", ":")), ex=ROOM_TTL)
                p.ltrim(log_key, n, -1)
                await p.execute()
        finally:
            await self._r.delete(lock_key)

    async def close(self) -> None:
        await self._r.aclose()


Handler = Callable[[dict], Awaitable[None]]


class MemoryBus:
    """In-process pub/sub. Several app instances can share one to simulate a cluster."""

    def __init__(self) -> None:
        self._subs: dict[str, set[Handler]] = defaultdict(set)

    async def publish(self, room: str, message: dict) -> None:
        for handler in list(self._subs.get(room, ())):
            await handler(message)

    async def subscribe(self, room: str, handler: Handler) -> None:
        self._subs[room].add(handler)

    async def unsubscribe(self, room: str, handler: Handler) -> None:
        self._subs[room].discard(handler)

    async def close(self) -> None:
        pass


class RedisBus:
    """Redis pub/sub, one channel per room. Fire-and-forget by design: anything
    missed while an instance was disconnected is recovered from the op log when
    clients resync, so the bus never has to be reliable."""

    def __init__(self, client: redis.Redis) -> None:
        self._r = client
        self._pubsub = client.pubsub()
        self._handlers: dict[str, set[Handler]] = defaultdict(set)
        self._task: asyncio.Task | None = None

    @staticmethod
    def _channel(room: str) -> str:
        return f"wb:bus:{room}"

    async def publish(self, room: str, message: dict) -> None:
        await self._r.publish(self._channel(room), json.dumps(message, separators=(",", ":")))

    async def subscribe(self, room: str, handler: Handler) -> None:
        first = not self._handlers[room]
        self._handlers[room].add(handler)
        if first:
            await self._pubsub.subscribe(self._channel(room))
        if self._task is None:
            self._task = asyncio.create_task(self._listen())

    async def unsubscribe(self, room: str, handler: Handler) -> None:
        self._handlers[room].discard(handler)
        if not self._handlers[room]:
            del self._handlers[room]
            await self._pubsub.unsubscribe(self._channel(room))

    async def _listen(self) -> None:
        while True:
            try:
                msg = await self._pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if msg is None:
                    if not self._handlers:
                        await asyncio.sleep(0.1)
                    continue
                room = msg["channel"].split(":", 2)[2]
                payload = json.loads(msg["data"])
                for handler in list(self._handlers.get(room, ())):
                    await handler(payload)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("bus listener error")
                await asyncio.sleep(0.5)

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        await self._pubsub.aclose()

"""Room logic in one event loop: fan-out, multiple instances, backpressure, persistence."""

import asyncio
import time

import fakeredis
import pytest

from app.rooms import Client, DuplicateClient, Limits, RoomFull, RoomManager
from app.store import MemoryBus, MemoryStore, RedisBus, RedisStore

NOW_MS = int(time.time() * 1000)


def op(shape="s1", ts_ms=None, client="a", **fields) -> dict:
    ts = [ts_ms or NOW_MS, 0, client]
    return {"id": shape, "f": {k: [v, ts] for k, v in fields.items()}}


def drain(client: Client) -> list[dict]:
    out = []
    while not client.outbox.empty():
        out.append(client.outbox.get_nowait())
    return out


@pytest.fixture
def cluster():
    """Two instances sharing a store and a bus, like two servers behind a load balancer."""
    store, bus = MemoryStore(), MemoryBus()
    return RoomManager(store, bus, "i1"), RoomManager(store, bus, "i2"), store


async def test_ops_reach_everyone_except_the_sender(cluster):
    m, _, _ = cluster
    a, b = Client("a", "Ada"), Client("b", "Bo")
    room = await m.join("room", a)
    await m.join("room", b)
    drain(a)
    await m.handle(room, a, {"t": "ops", "ops": [op(type="rect", x=1)]})
    assert drain(a) == []
    [msg] = drain(b)
    assert msg["t"] == "ops" and msg["from"] == "a" and msg["ops"][0]["f"]["x"][0] == 1


async def test_stale_updates_are_not_rebroadcast(cluster):
    m, _, _ = cluster
    a, b = Client("a", "Ada"), Client("b", "Bo")
    room = await m.join("room", a)
    await m.join("room", b)
    await m.handle(room, a, {"t": "ops", "ops": [op(ts_ms=NOW_MS, x=5)]})
    drain(b)
    await m.handle(room, a, {"t": "ops", "ops": [op(ts_ms=NOW_MS - 1000, x=1)]})  # older: loses
    assert drain(b) == []
    assert room.doc.records["s1"]["x"][0] == 5


async def test_two_instances_share_a_room(cluster):
    m1, m2, _ = cluster
    a, b = Client("a", "Ada"), Client("b", "Bo")
    room1 = await m1.join("room", a)
    room2 = await m2.join("room", b)  # joins on the other server
    assert any(m["t"] == "join" and m["peer"]["id"] == "b" for m in drain(a))
    await m1.handle(room1, a, {"t": "ops", "ops": [op(type="note", text="hello")]})
    await m1.handle(room1, a, {"t": "cursor", "x": 10, "y": 20})
    got = drain(b)
    assert [m["t"] for m in got] == ["ops", "cursor"]
    assert room2.doc.records == room1.doc.records
    assert any(p["id"] == "a" for p in m2.welcome(room2, b)["peers"])  # remote presence


async def test_late_joiner_gets_the_board_from_storage(cluster):
    m1, m2, _ = cluster
    a = Client("a", "Ada")
    room = await m1.join("room", a)
    await m1.handle(room, a, {"t": "ops", "ops": [op(type="rect", x=3), op("s2", type="note", text="hi")]})
    c = Client("c", "Cy")
    room_c = await m2.join("room", c)
    welcome = m2.welcome(room_c, c)
    assert {o["id"] for o in welcome["doc"]} == {"s1", "s2"}


async def test_rejects_bad_input_and_enforces_limits():
    m = RoomManager(MemoryStore(), MemoryBus(), "i1", Limits(ops_per_second=0.001, ops_burst=3, max_shapes=2, max_clients=2))
    a = Client("a", "Ada")
    room = await m.join("room", a)
    await m.handle(room, a, {"t": "ops", "ops": [{"id": "s1", "f": {"color": ["red", [NOW_MS, 0, "a"]]}}]})
    assert "Rejected" in drain(a)[0]["message"]
    await m.handle(room, a, {"t": "ops", "ops": [op("s1", type="rect"), op("s2", type="rect"), op("s3", type="rect")]})
    assert "full" in drain(a)[0]["message"]
    await m.handle(room, a, {"t": "ops", "ops": [op("s1", type="rect")]})  # 3rd: the last token
    assert drain(a) == []
    await m.handle(room, a, {"t": "ops", "ops": [op("s1", type="rect", x=1)]})  # 4th: over the rate
    assert "Slow down" in drain(a)[0]["message"]

    await m.join("room", Client("b", "Bo"))
    with pytest.raises(RoomFull):
        await m.join("room", Client("c", "Cy"))
    with pytest.raises(DuplicateClient):
        m2 = RoomManager(MemoryStore(), MemoryBus(), "i2")
        await m2.join("r2", Client("a", "Ada"))
        await m2.join("r2", Client("a", "Ada again"))


async def test_slow_clients_lose_cursors_first_then_get_disconnected():
    m = RoomManager(MemoryStore(), MemoryBus(), "i1", Limits(cursor_skip_at=2, outbox_limit=4, cursors_per_second=1000))
    slow, fast = Client("slow", "Slow"), Client("fast", "Fast")
    room = await m.join("room", slow)
    await m.join("room", fast)
    drain(slow)
    for i in range(3):
        await m.handle(room, fast, {"t": "cursor", "x": i, "y": i})
    assert slow.outbox.qsize() == 2  # the third cursor was skipped
    for i in range(3):
        await m.handle(room, fast, {"t": "ops", "ops": [op(f"n{i}", client="fast", type="rect")]})
    assert slow.outbox.qsize() == 4 and slow.dropped.is_set()  # never drops ops: disconnects instead


async def test_distinct_cursor_colors_and_leave_events(cluster):
    m, _, _ = cluster
    clients = [Client(c, c) for c in "abc"]
    room = None
    for c in clients:
        room = await m.join("room", c)
    assert len({c.color for c in clients}) == 3
    drain(clients[0])
    await m.leave(room, clients[2])
    assert drain(clients[0]) == [{"t": "leave", "id": "c"}]


@pytest.fixture
def fake_redis():
    server = fakeredis.FakeServer()
    return lambda: fakeredis.FakeAsyncRedis(server=server, decode_responses=True)


async def test_redis_store_compaction_keeps_concurrent_appends(fake_redis):
    store = RedisStore(fake_redis())
    for i in range(5):
        await store.append("room", [op(f"s{i}", type="rect", x=i)])
    before = await store.load("room")
    await store.compact("room")
    assert await store.load("room") == before
    await store.append("room", [op("late", type="note")])
    assert {o["id"] for o in await store.load("room")} == {f"s{i}" for i in range(5)} | {"late"}
    await store.close()


async def test_redis_bus_delivers_between_instances(fake_redis):
    bus1, bus2 = RedisBus(fake_redis()), RedisBus(fake_redis())
    received = asyncio.Queue()

    async def handler(msg):
        await received.put(msg)

    await bus2.subscribe("room", handler)
    await asyncio.sleep(0.1)
    await bus1.publish("room", {"t": "ops", "origin": "i1"})
    assert await asyncio.wait_for(received.get(), 3) == {"t": "ops", "origin": "i1"}
    await bus1.close()
    await bus2.close()

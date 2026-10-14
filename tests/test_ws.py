"""End-to-end over real WebSockets (Starlette's test client)."""

import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import create_app
from app.rooms import Limits
from app.store import MemoryBus, MemoryStore

NOW_MS = int(time.time() * 1000)


def rect(shape="s1", x=0, client="a", ts_ms=None):
    ts = [ts_ms or NOW_MS, 0, client]
    return {"id": shape, "f": {"type": ["rect", ts], "x": [x, ts], "y": [0, ts], "w": [50, ts], "h": [40, ts]}}


@pytest.fixture
def make():
    def build(**limits):
        return TestClient(create_app(MemoryStore(), MemoryBus(), Limits(**limits), instance_id="test"))

    return build


def test_two_people_draw_together(make):
    with make() as tc:
        with tc.websocket_connect("/ws/demo-room?client=a&name=Ada") as a:
            welcome = a.receive_json()
            assert welcome["t"] == "welcome" and welcome["you"]["name"] == "Ada" and welcome["doc"] == []
            with tc.websocket_connect("/ws/demo-room?client=b&name=Bo") as b:
                assert b.receive_json()["peers"][0]["name"] == "Ada"
                assert a.receive_json() == {"t": "join", "peer": {"id": "b", "name": "Bo", "color": b_color(tc), "cursor": None}}

                a.send_json({"t": "ops", "ops": [rect(x=10)]})
                msg = b.receive_json()
                assert msg["t"] == "ops" and msg["from"] == "a" and msg["ops"][0]["f"]["x"][0] == 10

                b.send_json({"t": "cursor", "x": 5, "y": 6})
                # a's next message is b's cursor, not an echo of a's own ops
                assert a.receive_json() == {"t": "cursor", "id": "b", "cursor": [5, 6]}


def b_color(tc):
    room = tc.app.state.manager.rooms["demo-room"]
    return room.clients["b"].color


def test_reload_gets_the_whole_board(make):
    with make() as tc:
        with tc.websocket_connect("/ws/demo-room?client=a&name=Ada") as a:
            a.receive_json()
            a.send_json({"t": "ops", "ops": [rect("s1", 1), rect("s2", 2)]})
            a.send_json({"t": "cursor", "x": 0, "y": 0})  # round trip so the ops are surely applied
            with tc.websocket_connect("/ws/demo-room?client=c&name=Cy") as c:
                assert {o["id"] for o in c.receive_json()["doc"]} == {"s1", "s2"}


def test_errors_are_reported_to_the_sender(make):
    with make() as tc:
        with tc.websocket_connect("/ws/demo-room?client=a&name=Ada") as a:
            a.receive_json()
            a.send_json({"t": "ops", "ops": [rect(ts_ms=NOW_MS + 3_600_000)]})
            assert "timestamp" in a.receive_json()["message"]
            a.send_json({"t": "teleport"})
            assert a.receive_json()["t"] == "error"


def test_full_rooms_and_duplicate_ids_are_refused(make):
    with make(max_clients=1) as tc:
        with tc.websocket_connect("/ws/demo-room?client=a&name=Ada") as a:
            a.receive_json()
            with tc.websocket_connect("/ws/demo-room?client=b&name=Bo") as b:
                with pytest.raises(WebSocketDisconnect) as info:
                    b.receive_json()
                assert info.value.code == 1013
    with make() as tc:
        with tc.websocket_connect("/ws/demo-room?client=a&name=Ada") as a:
            a.receive_json()
            with tc.websocket_connect("/ws/demo-room?client=a&name=Twin") as twin:
                with pytest.raises(WebSocketDisconnect) as info:
                    twin.receive_json()
                assert info.value.code == 1008


def test_bad_ids_are_rejected_before_accepting(make):
    with make() as tc:
        with pytest.raises(WebSocketDisconnect):
            with tc.websocket_connect("/ws/demo-room?client=bad id&name=x") as ws:
                ws.receive_json()


def test_pages(make):
    with make() as tc:
        r = tc.get("/", follow_redirects=False)
        assert r.status_code == 302 and r.headers["location"].startswith("/r/")
        assert "text/html" in tc.get(r.headers["location"]).headers["content-type"]
        assert tc.get("/r/BAD ROOM!", follow_redirects=False).status_code == 302
        assert tc.get("/health").json()["status"] == "ok"

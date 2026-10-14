import json
import random
from pathlib import Path

import pytest

from app.crdt import Doc, InvalidOp, validate_op

CASES = json.loads((Path(__file__).parent / "fixtures" / "crdt_cases.json").read_text())
FIELDS = {
    "x": lambda r: r.randint(-500, 500),
    "y": lambda r: r.randint(-500, 500),
    "color": lambda r: r.choice(["#ff0000", "#00ff00", "#0000ff"]),
    "text": lambda r: r.choice(["", "hi", "todo", "ship it"]),
    "deleted": lambda r: r.random() < 0.3,
    "z": lambda r: r.random(),
}


def doc_of(ops) -> dict:
    d = Doc()
    d.apply(ops)
    return d.records


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_cases(case):
    """The same file is run against static/crdt.js in CI, so both sides agree."""
    assert doc_of(case["ops"]) == case["expected"]
    assert doc_of(list(reversed(case["ops"]))) == case["expected"]


def random_ops(rng: random.Random, n: int, clients: str = "abc") -> list[dict]:
    """Edits from several clients with independent (and imperfectly synced) clocks.

    Like real clients, each never reuses a timestamp, so two different values
    never carry the same timestamp (the one thing the merge can't order).
    """
    clocks = {c: [rng.randint(0, 50), 0] for c in clients}
    ops = []
    for _ in range(n):
        client = rng.choice(clients)
        clock = clocks[client]
        if rng.random() < 0.6:
            clock[0] += rng.randint(1, 20)
            clock[1] = 0
        else:
            clock[1] += 1  # same millisecond, so the counter breaks the tie
        ts = [clock[0], clock[1], client]
        names = rng.sample(sorted(FIELDS), rng.randint(1, 3))
        ops.append({"id": f"s{rng.randint(1, 6)}", "f": {name: [FIELDS[name](rng), ts] for name in names}})
    return ops


@pytest.mark.parametrize("seed", range(200))
def test_replicas_converge_whatever_the_delivery_order(seed):
    """Shuffled, duplicated and arbitrarily batched delivery: every replica ends up equal."""
    rng = random.Random(seed)
    ops = random_ops(rng, 40)
    reference = doc_of(ops)
    for _ in range(5):
        delivery = ops + rng.sample(ops, rng.randint(0, len(ops)))  # duplicates
        rng.shuffle(delivery)
        replica = Doc()
        i = 0
        while i < len(delivery):  # random batch sizes
            step = rng.randint(1, 7)
            replica.apply(delivery[i:i + step])
            i += step
        assert replica.records == reference


@pytest.mark.parametrize("seed", range(50))
def test_merge_is_associative_and_commutative(seed):
    rng = random.Random(1000 + seed)
    a, b, c = (random_ops(rng, 15, clients) for clients in ("ab", "cd", "ef"))
    assert doc_of(a + b + c) == doc_of(c + a + b) == doc_of(b + c + a)


def test_effective_delta_contains_only_changes():
    d = Doc()
    first = [{"id": "s1", "f": {"x": [1, [10, 0, "a"]], "y": [2, [10, 0, "a"]]}}]
    assert d.apply(first) == first
    assert d.apply(first) == []  # a duplicate changes nothing
    stale_and_fresh = [{"id": "s1", "f": {"x": [9, [5, 0, "b"]], "y": [7, [20, 0, "b"]]}}]
    assert d.apply(stale_and_fresh) == [{"id": "s1", "f": {"y": [7, [20, 0, "b"]]}}]


def test_relaying_effective_deltas_reaches_the_same_state():
    """What the server broadcasts (effective deltas) is enough for others to converge."""
    rng = random.Random(7)
    ops = random_ops(rng, 60)
    server, follower = Doc(), Doc()
    for op in ops:
        follower.apply(server.apply([op]))
    assert follower.records == server.records == doc_of(ops)


NOW = 1_800_000_000_000
GOOD = {"id": "shape-1", "f": {"type": ["rect", [NOW, 0, "c1"]], "x": [10.5, [NOW, 0, "c1"]]}}


def test_accepts_a_valid_op():
    assert validate_op(GOOD, NOW) == GOOD


@pytest.mark.parametrize(
    "op",
    [
        {"id": "bad id!", "f": GOOD["f"]},
        {"id": "s", "f": {}},
        {"id": "s", "f": {"owner": ["me", [NOW, 0, "c1"]]}},
        {"id": "s", "f": {"color": ["red", [NOW, 0, "c1"]]}},
        {"id": "s", "f": {"x": [True, [NOW, 0, "c1"]]}},
        {"id": "s", "f": {"x": [1e9, [NOW, 0, "c1"]]}},
        {"id": "s", "f": {"points": [[1, 2, 3], [NOW, 0, "c1"]]}},
        {"id": "s", "f": {"type": ["circle", [NOW, 0, "c1"]]}},
        {"id": "s", "f": {"text": ["x" * 3000, [NOW, 0, "c1"]]}},
        {"id": "s", "f": {"x": [1, [NOW, 0, "bad client!"]]}},
        {"id": "s", "f": {"x": [1, [NOW + 3_600_000, 0, "c1"]]}},  # an hour in the future
        {"id": "s", "f": {"x": [1, "not a timestamp"]}},
    ],
)
def test_rejects_invalid_ops(op):
    with pytest.raises(InvalidOp):
        validate_op(op, NOW)

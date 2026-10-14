"""The board's data type: a map of shapes, each a set of last-writer-wins fields.

    doc = { shape_id: { field: [value, ts], ... }, ... }

A timestamp is a hybrid logical clock reading [wall_ms, counter, client_id],
compared as a tuple. Merging two docs keeps, for every field, the value with
the larger timestamp. Because that is a max() per field, merging is:

  - commutative: merge(a, b) == merge(b, a)
  - associative: grouping doesn't matter
  - idempotent:  merge(a, a) == a

so replicas that have seen the same updates hold the same doc, regardless of
delivery order, duplicates, or how long one of them was offline. The browser
implements the identical rules in static/crdt.js; both are checked against the
shared cases in tests/fixtures/crdt_cases.json.

Deletion is a field too (deleted: true). A move and a delete that happen
concurrently touch different fields, so both apply and the shape stays
deleted ("delete wins"). Undo is just a newer write.
"""

import re
from typing import Any

Ts = list  # [wall_ms: int, counter: int, client_id: str]
Op = dict  # {"id": shape_id, "f": {field: [value, ts]}}

SHAPE_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
CLIENT_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
TYPES = {"stroke", "rect", "ellipse", "note"}
MAX_POINTS = 4000  # numbers, i.e. 2000 x/y pairs per stroke
MAX_TEXT = 2000
COORD = 1e7  # the canvas is big, not infinite


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and -COORD <= v <= COORD


def _points(v: Any) -> bool:
    return isinstance(v, list) and len(v) <= MAX_POINTS and len(v) % 2 == 0 and all(_num(p) for p in v)


VALIDATORS = {
    "type": lambda v: v in TYPES,
    "x": _num, "y": _num, "w": _num, "h": _num, "z": _num,
    "points": _points,
    "width": lambda v: _num(v) and 0.5 <= v <= 64,
    "color": lambda v: isinstance(v, str) and bool(COLOR.match(v)),
    "text": lambda v: isinstance(v, str) and len(v) <= MAX_TEXT,
    "deleted": lambda v: isinstance(v, bool),
}


class InvalidOp(ValueError):
    pass


def ts_key(ts: Ts) -> tuple[int, int, str]:
    return (ts[0], ts[1], ts[2])


def valid_ts(ts: Any, now_ms: int | None = None, max_drift_ms: int = 60_000) -> bool:
    """A well-formed timestamp, not too far in the future.

    The drift bound matters: with last-writer-wins, a client whose clock (or
    malicious payload) says "the year 2100" would win every conflict forever.
    """
    if not (isinstance(ts, list) and len(ts) == 3):
        return False
    ms, counter, client = ts
    if not (isinstance(ms, int) and not isinstance(ms, bool) and ms >= 0):
        return False
    if not (isinstance(counter, int) and not isinstance(counter, bool) and 0 <= counter < 1_000_000):
        return False
    if not (isinstance(client, str) and CLIENT_ID.match(client)):
        return False
    return now_ms is None or ms <= now_ms + max_drift_ms


def validate_op(op: Any, now_ms: int | None = None) -> Op:
    if not isinstance(op, dict) or not isinstance(op.get("id"), str) or not SHAPE_ID.match(op["id"]):
        raise InvalidOp("bad shape id")
    fields = op.get("f")
    if not isinstance(fields, dict) or not fields:
        raise InvalidOp("no fields")
    for name, entry in fields.items():
        check = VALIDATORS.get(name)
        if check is None:
            raise InvalidOp(f"unknown field {name!r}")
        if not (isinstance(entry, list) and len(entry) == 2):
            raise InvalidOp(f"field {name!r} must be [value, ts]")
        value, ts = entry
        if not check(value):
            raise InvalidOp(f"bad value for {name!r}")
        if not valid_ts(ts, now_ms):
            raise InvalidOp(f"bad timestamp for {name!r}")
    return {"id": op["id"], "f": fields}


class Doc:
    def __init__(self) -> None:
        self.records: dict[str, dict[str, list]] = {}

    def apply(self, ops: list[Op]) -> list[Op]:
        """Merge ops in. Returns only the parts that changed something (the effective delta),
        which is what's worth persisting and broadcasting."""
        effective: dict[str, dict[str, list]] = {}
        for op in ops:
            record = self.records.setdefault(op["id"], {})
            for name, (value, ts) in op["f"].items():
                current = record.get(name)
                if current is None or ts_key(ts) > ts_key(current[1]):
                    record[name] = [value, ts]
                    effective.setdefault(op["id"], {})[name] = [value, ts]
        return [{"id": sid, "f": f} for sid, f in effective.items()]

    def to_ops(self) -> list[Op]:
        return [{"id": sid, "f": dict(f)} for sid, f in self.records.items()]

    def visible(self) -> int:
        return sum(1 for r in self.records.values() if "type" in r and not r.get("deleted", [False])[0])

    def __len__(self) -> int:
        return len(self.records)

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Doc) and self.records == other.records

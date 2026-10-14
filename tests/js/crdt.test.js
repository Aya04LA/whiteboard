// The browser CRDT against the same cases as the Python one (tests/fixtures/crdt_cases.json).
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Clock, Doc, compact, compareTs } from "../../app/static/crdt.js";

const cases = JSON.parse(readFileSync(new URL("../fixtures/crdt_cases.json", import.meta.url), "utf8"));
const records = (doc) => Object.fromEntries(doc.records);

for (const c of cases) {
  test(`shared case: ${c.name}`, () => {
    const forward = new Doc(); forward.apply(c.ops);
    const backward = new Doc(); backward.apply([...c.ops].reverse());
    assert.deepEqual(records(forward), c.expected);
    assert.deepEqual(records(backward), c.expected);
  });
}

// Small seeded PRNG so failures are reproducible.
function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test("replicas converge under shuffled, duplicated, batched delivery", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const r = rng(seed);
    const clocks = { a: [10, 0], b: [20, 0], c: [5, 0] };
    const ops = [];
    for (let i = 0; i < 40; i++) {
      const client = "abc"[Math.floor(r() * 3)];
      const clk = clocks[client];
      if (r() < 0.6) { clk[0] += 1 + Math.floor(r() * 20); clk[1] = 0; } else clk[1] += 1;
      const ts = [clk[0], clk[1], client];
      ops.push({ id: `s${Math.floor(r() * 5)}`, f: { x: [Math.floor(r() * 100), ts], deleted: [r() < 0.3, ts] } });
    }
    const reference = new Doc(); reference.apply(ops);
    const delivery = [...ops, ...ops.filter(() => r() < 0.4)].sort(() => r() - 0.5);
    const replica = new Doc();
    for (let i = 0; i < delivery.length; i += 3) replica.apply(delivery.slice(i, i + 3));
    assert.deepEqual(records(replica), records(reference));
  }
});

test("the hybrid clock never goes backwards and moves past what it observes", () => {
  let wall = 1000;
  const clock = new Clock("me", () => wall);
  const a = clock.tick();
  const b = clock.tick(); // same millisecond: the counter moves
  assert.equal(compareTs(b, a), 1);
  wall = 900; // the machine's clock jumped back
  const c = clock.tick();
  assert.equal(compareTs(c, b), 1);
  clock.observe([5000, 3, "them"]); // a peer far ahead
  assert.equal(compareTs(clock.tick(), [5000, 3, "them"]), 1);
});

test("compact keeps only the newest value per field", () => {
  const ops = [
    { id: "s", f: { points: [[0, 0], [1, 0, "a"]] } },
    { id: "s", f: { points: [[0, 0, 4, 4], [2, 0, "a"]] } },
    { id: "s", f: { points: [[0, 0, 4, 4, 9, 9], [3, 0, "a"]] } },
  ];
  assert.deepEqual(compact(ops), [{ id: "s", f: { points: [[0, 0, 4, 4, 9, 9], [3, 0, "a"]] } }]);
});

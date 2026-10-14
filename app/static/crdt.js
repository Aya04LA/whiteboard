// The board's CRDT, browser side. Identical rules to app/crdt.py; both are checked
// against tests/fixtures/crdt_cases.json (pytest locally, `node --test` in CI).
//
//   doc = Map(shapeId -> { field: [value, ts] })
//   ts  = [wallMs, counter, clientId], compared as a tuple
//
// Merge keeps the larger timestamp per field: commutative, associative and
// idempotent, so every replica converges whatever order updates arrive in.

export function compareTs(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

// Hybrid logical clock: wall time when it moves forward, a counter when it
// doesn't, and it never runs behind a timestamp it has seen. Ordering stays
// sensible across machines even when their clocks disagree a little.
export class Clock {
  constructor(clientId, now = () => Date.now()) {
    this.client = clientId;
    this.now = now;
    this.ms = 0;
    this.counter = 0;
  }
  tick() {
    const wall = this.now();
    if (wall > this.ms) { this.ms = wall; this.counter = 0; }
    else this.counter += 1;
    return [this.ms, this.counter, this.client];
  }
  observe(ts) {
    if (ts[0] > this.ms || (ts[0] === this.ms && ts[1] > this.counter)) {
      this.ms = ts[0];
      this.counter = ts[1];
    }
  }
}

export class Doc {
  constructor() {
    this.records = new Map();
  }
  // Merge ops in; returns the effective delta (only what changed).
  apply(ops) {
    const effective = new Map();
    for (const op of ops) {
      let record = this.records.get(op.id);
      if (!record) { record = {}; this.records.set(op.id, record); }
      for (const [name, entry] of Object.entries(op.f)) {
        const current = record[name];
        if (!current || compareTs(entry[1], current[1]) > 0) {
          record[name] = entry;
          if (!effective.has(op.id)) effective.set(op.id, {});
          effective.get(op.id)[name] = entry;
        }
      }
    }
    return [...effective].map(([id, f]) => ({ id, f }));
  }
  toOps() {
    return [...this.records].map(([id, f]) => ({ id, f: { ...f } }));
  }
  // A plain view of one shape: { field: value }.
  shape(id) {
    const record = this.records.get(id);
    if (!record || !record.type || (record.deleted && record.deleted[0])) return null;
    const out = { id };
    for (const [k, [v]] of Object.entries(record)) out[k] = v;
    return out;
  }
  shapes() {
    const out = [];
    for (const id of this.records.keys()) {
      const s = this.shape(id);
      if (s) out.push(s);
    }
    return out.sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || (a.id < b.id ? -1 : 1));
  }
}

// Fold many ops into one delta per shape, keeping the newest value per field.
// Used to coalesce the offline queue before sending it.
export function compact(ops) {
  const doc = new Doc();
  doc.apply(ops);
  return doc.toOps();
}

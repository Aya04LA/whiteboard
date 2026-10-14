import { Clock, Doc, compact } from "/static/crdt.js";

const { Spring, animate, rubberband, segmented, toast, reducedMotion } = window.UI;
const $ = (s) => document.querySelector(s);

// ---------- Identity ----------
// A fresh client id per page load: two tabs (even a duplicated one) never share
// a clock id, so no two different values can ever carry the same timestamp.
const roomId = decodeURIComponent(location.pathname.split("/").pop());
const clientId = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, "0")).join("");
const ADJ = ["Teal", "Amber", "Coral", "Indigo", "Sage", "Saffron", "Slate", "Rose"];
const ANIMAL = ["Otter", "Heron", "Lynx", "Fox", "Wren", "Koala", "Orca", "Ibis"];
let myName;
try { myName = localStorage.getItem("canvas.name"); } catch {}
if (!myName) {
  myName = `${ADJ[Math.floor(Math.random() * 8)]} ${ANIMAL[Math.floor(Math.random() * 8)]}`;
  try { localStorage.setItem("canvas.name", myName); } catch {}
}

const clock = new Clock(clientId);
const doc = new Doc();
$("#room").textContent = roomId;
document.title = `${roomId} · Canvas`;

// ---------- Canvas & camera ----------
const canvas = $("#board"), ctx = canvas.getContext("2d");
const cam = { x: 0, y: 0, zoom: 1 }; // the world point shown at the screen's top-left
const ZOOM_MIN = 0.1, ZOOM_MAX = 8;
let dpr = 1, dirty = true;
const invalidate = () => { dirty = true; };
const toWorld = (sx, sy) => ({ x: sx / cam.zoom + cam.x, y: sy / cam.zoom + cam.y });
const toScreen = (wx, wy) => ({ x: (wx - cam.x) * cam.zoom, y: (wy - cam.y) * cam.zoom });

function resize() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  invalidate();
}
addEventListener("resize", resize);
resize();
cam.x = -innerWidth / 2; cam.y = -innerHeight / 2; // world origin in the middle

function zoomAt(z, sx, sy) {
  const before = toWorld(sx, sy);
  cam.zoom = z;
  cam.x = before.x - sx / z;
  cam.y = before.y - sy / z;
  $("#zoom-reset").textContent = `${Math.round(z * 100)}%`;
  invalidate();
  syncEditor();
}

// ---------- Colors ----------
const INK = "#1d1d1f";
const COLORS = [INK, "#0a84ff", "#ff375f", "#30d158", "#ff9f0a", "#bf5af2"];
const NAMES = ["Ink", "Blue", "Pink", "Green", "Orange", "Purple"];
const dark = matchMedia("(prefers-color-scheme: dark)");
dark.addEventListener("change", invalidate);
const paint = (c) => (c === INK && dark.matches ? "#f5f5f7" : c);
let color = COLORS[0];

const swatches = $("#swatches");
COLORS.forEach((c, i) => {
  const b = document.createElement("button");
  b.type = "button"; b.className = "swatch"; b.setAttribute("role", "radio");
  b.setAttribute("aria-label", NAMES[i]); b.title = NAMES[i];
  b.style.setProperty("--c", c === INK ? "var(--text)" : c);
  b.setAttribute("aria-checked", String(i === 0));
  b.tabIndex = i === 0 ? 0 : -1;
  b.addEventListener("click", () => {
    color = c;
    swatches.querySelectorAll(".swatch").forEach((s) => { s.setAttribute("aria-checked", String(s === b)); s.tabIndex = s === b ? 0 : -1; });
    if (selected && doc.shape(selected)) change(selected, { color: c });
  });
  swatches.appendChild(b);
});

// ---------- Tools ----------
let tool = "pen";
const setToolClass = () => { canvas.className = { select: "select", hand: "hand", eraser: "erase" }[tool] || ""; };
segmented($("#tools"), (value) => { tool = value; if (tool !== "select") select(null); setToolClass(); });
function pickTool(value) { $(`#tools [data-value="${value}"]`)?.click(); }

// ---------- Local changes, undo ----------
let zTop = 0;
const nextZ = () => (zTop += 1);
let selected = null;
const undoStack = [], redoStack = [];

function current(id, names) {
  const record = doc.records.get(id) || {};
  return Object.fromEntries(names.map((n) => [n, record[n] ? record[n][0] : n === "deleted" ? true : undefined]));
}

// Every local edit: one clock tick, one op, merged locally and queued for the server.
function change(id, fields, { history = true, group = null } = {}) {
  const before = current(id, Object.keys(fields));
  const ts = clock.tick();
  const op = { id, f: {} };
  for (const [k, v] of Object.entries(fields)) op.f[k] = [v, ts];
  doc.apply([op]);
  send(op);
  invalidate();
  if (history) {
    const entry = { id, before, after: fields };
    if (group) group.push(entry);
    else pushUndo([entry]);
  }
}
function pushUndo(entries) {
  if (!entries.length) return;
  undoStack.push(entries);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  syncUndoButtons();
}
// Undo is just another write with a newer timestamp, so it merges like any edit.
function replay(from, to, key) {
  const entries = from.pop();
  if (!entries) return;
  for (const e of [...entries].reverse()) change(e.id, Object.fromEntries(Object.entries(e[key]).filter(([, v]) => v !== undefined)), { history: false });
  to.push(entries);
  syncUndoButtons();
}
const undo = () => replay(undoStack, redoStack, "before");
const redo = () => replay(redoStack, undoStack, "after");
function syncUndoButtons() { $("#undo").disabled = !undoStack.length; $("#redo").disabled = !redoStack.length; }
$("#undo").addEventListener("click", undo);
$("#redo").addEventListener("click", redo);

function select(id) { selected = id; invalidate(); }
let shapeSeq = 0;
const newId = () => `${clientId}-${(shapeSeq++).toString(36)}`;

// ---------- Network ----------
let ws = null, wantOnline = true, connected = false, retry = 0;
let outbox = []; // ops not yet sent; compacted before sending
const peers = new Map();

function send(op) {
  outbox.push(op);
}
// Flush every 50 ms: rapid edits (a stroke growing point by point) coalesce
// into one op per shape per flush, keeping only the newest value per field.
setInterval(() => {
  if (outbox.length > 64) outbox = compact(outbox); // keep the offline queue small
  if (!connected || !outbox.length) { updateStatus(); return; }
  const ops = compact(outbox);
  outbox = [];
  for (let i = 0; i < ops.length; i += 200) ws.send(JSON.stringify({ t: "ops", ops: ops.slice(i, i + 200) }));
}, 50);

function connect() {
  if (!wantOnline) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(roomId)}?client=${clientId}&name=${encodeURIComponent(myName)}`);
  ws.onmessage = (e) => receive(JSON.parse(e.data));
  ws.onclose = (e) => {
    connected = false;
    ws = null;
    for (const p of peers.values()) p.el.remove();
    peers.clear();
    renderAvatars();
    updateStatus();
    if (!wantOnline) return;
    if (e.code === 1013 && e.reason.includes("full")) { toast("This board is full right now. Trying again shortly."); }
    // Exponential backoff with jitter, so a server restart isn't met by every client at once.
    const delay = Math.min(10000, 500 * 2 ** retry) * (0.5 + Math.random() / 2);
    retry += 1;
    setTimeout(connect, delay);
  };
  updateStatus();
}

function observe(ops) {
  for (const op of ops) for (const entry of Object.values(op.f)) clock.observe(entry[1]);
}

function receive(msg) {
  if (msg.t === "welcome") {
    connected = true;
    retry = 0;
    observe(msg.doc);
    doc.apply(msg.doc); // merge the server's board with ours: offline edits survive, nothing is overwritten
    for (const s of doc.shapes()) zTop = Math.max(zTop, s.z || 0);
    for (const p of msg.peers) addPeer(p);
    renderAvatars();
    invalidate();
    updateStatus();
  } else if (msg.t === "ops") {
    observe(msg.ops);
    doc.apply(msg.ops);
    for (const op of msg.ops) if (op.f.z) zTop = Math.max(zTop, op.f.z[0]);
    invalidate();
  } else if (msg.t === "join") {
    addPeer(msg.peer);
    renderAvatars();
  } else if (msg.t === "leave") {
    peers.get(msg.id)?.el.remove();
    peers.delete(msg.id);
    renderAvatars();
  } else if (msg.t === "cursor") {
    const p = peers.get(msg.id);
    if (p) moveCursor(p, msg.cursor);
  } else if (msg.t === "error") {
    toast(msg.message);
  }
}

$("#offline").addEventListener("click", () => {
  wantOnline = !wantOnline;
  $("#offline").textContent = wantOnline ? "Go offline" : "Go online";
  $("#offline").setAttribute("aria-pressed", String(!wantOnline));
  if (wantOnline) connect();
  else ws?.close(1000, "offline by choice");
  updateStatus();
});

function updateStatus() {
  const el = $("#status");
  const waiting = new Set(outbox.map((op) => op.id)).size;
  if (!wantOnline) {
    el.className = "status offline";
    el.textContent = waiting ? `Offline · ${waiting} ${waiting === 1 ? "change" : "changes"} waiting` : "Offline";
  } else if (connected) {
    el.className = "status live";
    el.textContent = `Live · ${peers.size + 1} here`;
  } else {
    el.className = "status";
    el.textContent = retry ? "Reconnecting…" : "Connecting…";
  }
}

// ---------- Presence ----------
const ARROW = '<svg viewBox="0 0 18 18"><path d="M2 1.5l13 7-6 1.6L6.3 16z" fill="currentColor" stroke="white" stroke-width="1.2" stroke-linejoin="round"/></svg>';

function addPeer(p) {
  if (p.id === clientId || peers.has(p.id)) { const existing = peers.get(p.id); if (existing && p.cursor) moveCursor(existing, p.cursor); return; }
  const el = document.createElement("div");
  el.className = "peer";
  el.style.setProperty("--c", p.color);
  el.style.color = p.color;
  el.innerHTML = ARROW + "<span></span>";
  el.querySelector("span").textContent = p.name;
  el.style.opacity = "0";
  $("#cursors").appendChild(el);
  // Independent springs per axis: network updates arrive ~20 times a second,
  // the springs fill in every frame between them.
  const peer = { ...p, el, sx: new Spring(0, { damping: 1, response: 0.12 }), sy: new Spring(0, { damping: 1, response: 0.12 }), seen: 0, placed: false };
  peers.set(p.id, peer);
  if (p.cursor) moveCursor(peer, p.cursor);
}

function moveCursor(peer, cursor) {
  peer.cursor = cursor;
  peer.seen = performance.now();
  if (!cursor) return;
  if (!peer.placed || reducedMotion.matches) { peer.sx.jump(cursor[0]); peer.sy.jump(cursor[1]); peer.placed = true; }
  else { peer.sx.target = cursor[0]; peer.sy.target = cursor[1]; }
}

function renderAvatars() {
  const root = $("#avatars");
  root.textContent = "";
  const all = [{ name: myName + " (you)", color: "var(--accent)" }, ...peers.values()];
  for (const p of all.slice(0, 4)) {
    const a = document.createElement("span");
    a.className = "avatar";
    a.style.setProperty("--c", p.color);
    a.textContent = p.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    a.title = p.name;
    root.appendChild(a);
  }
  if (all.length > 4) {
    const more = document.createElement("span");
    more.className = "avatar more";
    more.textContent = `+${all.length - 4}`;
    root.appendChild(more);
  }
  root.setAttribute("aria-label", `${all.length} ${all.length === 1 ? "person" : "people"} here`);
  updateStatus();
}

let lastCursorSent = 0, cursorTimer = null;
function sendCursor(world) {
  if (!connected) return;
  const now = performance.now();
  const go = () => { lastCursorSent = performance.now(); ws?.send(JSON.stringify({ t: "cursor", x: world ? Math.round(world.x) : null, y: world ? Math.round(world.y) : null })); };
  clearTimeout(cursorTimer);
  if (now - lastCursorSent > 50) go();
  else cursorTimer = setTimeout(go, 50 - (now - lastCursorSent)); // always send the final position
}

// ---------- Drawing ----------
function draw() {
  const w = innerWidth, h = innerHeight, z = cam.zoom;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Dot grid, spaced so dots stay a comfortable distance apart at any zoom.
  let step = 24;
  while (step * z < 14) step *= 4;
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue("--grid").trim() || "rgba(0,0,0,.08)";
  const start = toWorld(0, 0);
  for (let x = Math.floor(start.x / step) * step; x < start.x + w / z; x += step) {
    for (let y = Math.floor(start.y / step) * step; y < start.y + h / z; y += step) {
      const s = toScreen(x, y);
      ctx.fillRect(s.x - 1, s.y - 1, 2, 2);
    }
  }

  ctx.setTransform(dpr * z, 0, 0, dpr * z, -cam.x * z * dpr, -cam.y * z * dpr);
  const textColor = css.getPropertyValue("--text").trim();
  const surface = css.getPropertyValue("--surface").trim();
  let count = 0;
  for (const s of doc.shapes()) {
    count++;
    drawShape(s, textColor, surface);
  }
  if (selected) {
    const s = doc.shape(selected);
    if (s) {
      const b = bounds(s), pad = 6 / z;
      ctx.strokeStyle = css.getPropertyValue("--accent").trim();
      ctx.lineWidth = 1.5 / z;
      ctx.setLineDash([5 / z, 4 / z]);
      ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
      ctx.setLineDash([]);
    } else selected = null;
  }
  $("#hint").classList.toggle("hidden", count > 0);
  canvas.setAttribute("aria-label", `Whiteboard with ${count} ${count === 1 ? "shape" : "shapes"}`);
}

function drawShape(s, textColor, surface) {
  const c = paint(s.color || INK);
  if (s.type === "stroke") {
    const p = s.points || [];
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
    ctx.lineWidth = s.width || 3;
    ctx.lineCap = ctx.lineJoin = "round";
    if (p.length <= 2) {
      ctx.beginPath();
      ctx.arc(s.x + (p[0] || 0), s.y + (p[1] || 0), (s.width || 3) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    // Quadratic curves through segment midpoints: smooth without overshooting the input.
    ctx.beginPath();
    ctx.moveTo(s.x + p[0], s.y + p[1]);
    for (let i = 2; i < p.length - 2; i += 2) {
      const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2;
      ctx.quadraticCurveTo(s.x + p[i], s.y + p[i + 1], s.x + mx, s.y + my);
    }
    ctx.lineTo(s.x + p[p.length - 2], s.y + p[p.length - 1]);
    ctx.stroke();
    return;
  }
  const b = bounds(s);
  if (s.type === "note") {
    ctx.fillStyle = surface;
    roundRect(b, 10); ctx.fill();
    ctx.fillStyle = withAlpha(c === "#f5f5f7" ? "#8e8e93" : c, 0.22);
    roundRect(b, 10); ctx.fill();
    if (s.id !== editing) {
      ctx.fillStyle = textColor;
      ctx.font = "16px system-ui, -apple-system, sans-serif";
      wrapText(s.text || "", b.x + 12, b.y + 12 + 16, b.w - 24, 21.6, b.y + b.h - 8);
    }
    return;
  }
  ctx.strokeStyle = c;
  ctx.fillStyle = withAlpha(c, 0.08);
  ctx.lineWidth = 2.5;
  if (s.type === "rect") roundRect(b, 6);
  else { ctx.beginPath(); ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2); }
  ctx.fill();
  ctx.stroke();
}

function roundRect(b, r) {
  ctx.beginPath();
  ctx.roundRect(b.x, b.y, b.w, b.h, Math.min(r, b.w / 2, b.h / 2));
}
function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
function wrapText(text, x, y, maxW, lineH, maxY) {
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxW && line) {
        if (y > maxY) return;
        ctx.fillText(line, x, y); y += lineH; line = word;
      } else line = test;
    }
    if (y > maxY) return;
    ctx.fillText(line, x, y); y += lineH;
  }
}

function bounds(s) {
  if (s.type === "stroke") {
    const p = s.points || [0, 0];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
    }
    const r = (s.width || 3) / 2;
    return { x: s.x + x0 - r, y: s.y + y0 - r, w: x1 - x0 + 2 * r, h: y1 - y0 + 2 * r };
  }
  const w = s.w || 0, h = s.h || 0;
  return { x: Math.min(s.x, s.x + w), y: Math.min(s.y, s.y + h), w: Math.abs(w), h: Math.abs(h) };
}

function hit(wx, wy) {
  const tol = 6 / cam.zoom;
  const shapes = doc.shapes();
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    const b = bounds(s);
    if (wx < b.x - tol || wx > b.x + b.w + tol || wy < b.y - tol || wy > b.y + b.h + tol) continue;
    if (s.type !== "stroke") return s;
    const p = s.points || [], r = (s.width || 3) / 2 + tol;
    if (p.length <= 2) return s;
    for (let j = 0; j < p.length - 2; j += 2) {
      if (distToSegment(wx - s.x, wy - s.y, p[j], p[j + 1], p[j + 2], p[j + 3]) <= r) return s;
    }
  }
  return null;
}
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ---------- Frame loop ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.064, (now - last) / 1000);
  last = now;
  stepInertia(dt);
  if (dirty) { dirty = false; draw(); }
  for (const p of peers.values()) {
    p.sx.step(dt); p.sy.step(dt);
    const visible = p.cursor && p.placed;
    p.el.style.opacity = visible ? "1" : "0";
    p.el.classList.toggle("idle", now - p.seen > 10000);
    if (visible) {
      const s = toScreen(p.sx.x, p.sy.x);
      p.el.style.transform = `translate(${s.x - 2}px, ${s.y - 2}px)`;
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- Panning with momentum ----------
let velocity = null; // {x, y} in screen px/s while coasting after a flick
function stepInertia(dt) {
  if (!velocity) return;
  // Apple's scroll deceleration: velocity decays by 0.998 per millisecond.
  const decay = Math.pow(0.998, dt * 1000);
  velocity.x *= decay; velocity.y *= decay;
  cam.x -= (velocity.x * dt) / cam.zoom;
  cam.y -= (velocity.y * dt) / cam.zoom;
  invalidate();
  syncEditor();
  if (Math.hypot(velocity.x, velocity.y) < 8) velocity = null;
}

// ---------- Pointer input ----------
const pointers = new Map();
let gesture = null, spaceHeld = false;

canvas.addEventListener("pointerdown", (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch {} // the pointer may already be gone
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  velocity = null; // grabbing the canvas stops any coast, immediately
  zoomSpring.v = 0;
  commitEditor();

  if (pointers.size === 2) { startPinch(); return; }
  const world = toWorld(e.clientX, e.clientY);
  const panRequested = tool === "hand" || spaceHeld || e.button === 1;
  if (panRequested) { startPan(e); return; }
  if (e.button !== 0) return;

  if (tool === "select") {
    const s = hit(world.x, world.y);
    if (!s) { select(null); startPan(e); return; }
    select(s.id);
    // Respect where it was grabbed: move by the pointer's delta, never snap the shape to the pointer.
    gesture = { kind: "move", id: s.id, start: world, from: { x: s.x, y: s.y }, moved: false };
    change(s.id, { z: nextZ() }, { history: false });
  } else if (tool === "pen") {
    const id = newId();
    change(id, { type: "stroke", x: world.x, y: world.y, points: [0, 0], color, width: 3, z: nextZ(), deleted: false });
    gesture = { kind: "stroke", id, origin: world, points: [0, 0] };
  } else if (tool === "rect" || tool === "ellipse") {
    const id = newId();
    change(id, { type: tool, x: world.x, y: world.y, w: 0, h: 0, color, z: nextZ(), deleted: false });
    gesture = { kind: "shape", id, start: world };
  } else if (tool === "note") {
    const id = newId();
    change(id, { type: "note", x: world.x - 100, y: world.y - 70, w: 200, h: 140, color: color === INK ? "#ffd60a" : color, text: "", z: nextZ(), deleted: false });
    select(id);
    pickTool("select");
    requestAnimationFrame(() => openEditor(id));
  } else if (tool === "eraser") {
    gesture = { kind: "erase", group: [] };
    eraseAt(world);
  }
});

canvas.addEventListener("pointermove", (e) => {
  const world = toWorld(e.clientX, e.clientY);
  sendCursor(world);
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!gesture) return;

  if (gesture.kind === "pinch") { updatePinch(); return; }
  if (gesture.kind === "pan") {
    const dx = e.clientX - gesture.last.x, dy = e.clientY - gesture.last.y;
    cam.x -= dx / cam.zoom; cam.y -= dy / cam.zoom;
    gesture.last = { x: e.clientX, y: e.clientY };
    gesture.history.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    while (gesture.history.length > 2 && e.timeStamp - gesture.history[0].t > 100) gesture.history.shift();
    invalidate();
    syncEditor();
  } else if (gesture.kind === "move") {
    gesture.moved = true;
    change(gesture.id, { x: gesture.from.x + world.x - gesture.start.x, y: gesture.from.y + world.y - gesture.start.y }, { history: false });
  } else if (gesture.kind === "stroke") {
    const px = world.x - gesture.origin.x, py = world.y - gesture.origin.y;
    const p = gesture.points;
    if (Math.hypot(px - p[p.length - 2], py - p[p.length - 1]) < 1.5 / cam.zoom) return; // skip sub-pixel noise
    if (p.length >= 3998) return;
    p.push(Math.round(px * 10) / 10, Math.round(py * 10) / 10);
    change(gesture.id, { points: p.slice() }, { history: false });
  } else if (gesture.kind === "shape") {
    let w = world.x - gesture.start.x, h = world.y - gesture.start.y;
    if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
    change(gesture.id, { w, h }, { history: false });
  } else if (gesture.kind === "erase") {
    eraseAt(world);
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (!gesture) return;
  if (gesture.kind === "pinch") { if (pointers.size < 2) endPinch(); return; }
  if (gesture.kind === "pan") {
    canvas.classList.remove("panning");
    // Hand the release velocity to the coast: no seam between dragging and gliding.
    const h = gesture.history, first = h[0], lastPt = h[h.length - 1];
    const dt = (lastPt.t - first.t) / 1000;
    if (dt > 0 && !reducedMotion.matches && performance.now() - lastPt.t < 80) {
      velocity = { x: (lastPt.x - first.x) / dt, y: (lastPt.y - first.y) / dt };
      if (Math.hypot(velocity.x, velocity.y) < 60) velocity = null;
    }
  } else if (gesture.kind === "move" && gesture.moved) {
    const s = doc.shape(gesture.id);
    if (s) pushUndo([{ id: gesture.id, before: gesture.from, after: { x: s.x, y: s.y } }]);
  } else if (gesture.kind === "shape") {
    const s = doc.shape(gesture.id);
    if (s && Math.abs(s.w) < 4 && Math.abs(s.h) < 4) change(gesture.id, { x: s.x - 60, y: s.y - 45, w: 120, h: 90 }, { history: false }); // a click: default size
  } else if (gesture.kind === "erase") {
    pushUndo(gesture.group);
  }
  gesture = null;
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("pointerleave", (e) => { if (!pointers.has(e.pointerId)) sendCursor(null); });

function startPan(e) {
  canvas.classList.add("panning");
  gesture = { kind: "pan", last: { x: e.clientX, y: e.clientY }, history: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }] };
}

function eraseAt(world) {
  const s = hit(world.x, world.y);
  if (s) change(s.id, { deleted: true }, { group: gesture.group });
}

// ---------- Pinch zoom with rubber-banded limits ----------
function pinchState() {
  const [a, b] = [...pointers.values()];
  return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
}
function startPinch() {
  if (gesture && gesture.kind === "stroke") change(gesture.id, { deleted: true }, { history: false }); // first finger began a stroke; it was a pinch
  const st = pinchState();
  gesture = { kind: "pinch", startDist: st.dist, startZoom: cam.zoom, anchor: toWorld(st.mid.x, st.mid.y) };
}
function updatePinch() {
  const st = pinchState();
  let z = gesture.startZoom * (st.dist / gesture.startDist);
  // Past the limits the zoom resists progressively instead of stopping dead (in log space, so it feels even).
  const lz = Math.log(z), lo = Math.log(ZOOM_MIN), hi = Math.log(ZOOM_MAX);
  if (lz > hi) z = Math.exp(hi + rubberband(lz - hi, 1));
  else if (lz < lo) z = Math.exp(lo - rubberband(lo - lz, 1));
  gesture.lastMid = st.mid;
  cam.zoom = z;
  cam.x = gesture.anchor.x - st.mid.x / z;
  cam.y = gesture.anchor.y - st.mid.y / z;
  $("#zoom-reset").textContent = `${Math.round(z * 100)}%`;
  invalidate();
  syncEditor();
}
function endPinch() {
  const mid = gesture.lastMid || { x: innerWidth / 2, y: innerHeight / 2 };
  gesture = null;
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.zoom));
  if (clamped !== cam.zoom) animateZoom(clamped, mid.x, mid.y); // spring back inside the limits
}

// ---------- Zoom controls, wheel, keyboard ----------
const zoomSpring = new Spring(1, { damping: 1, response: 0.3 });
function animateZoom(target, sx = innerWidth / 2, sy = innerHeight / 2) {
  zoomSpring.x = cam.zoom;
  zoomSpring.target = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, target));
  animate("zoom", [zoomSpring], () => zoomAt(zoomSpring.x, sx, sy));
}
$("#zoom-in").addEventListener("click", () => animateZoom(cam.zoom * 1.5));
$("#zoom-out").addEventListener("click", () => animateZoom(cam.zoom / 1.5));
$("#zoom-reset").addEventListener("click", () => animateZoom(1));

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  velocity = null;
  if (e.ctrlKey || e.metaKey) {
    // Trackpad pinch arrives as ctrl+wheel; zoom around the pointer.
    zoomAt(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.zoom * Math.exp(-e.deltaY * 0.01))), e.clientX, e.clientY);
  } else {
    cam.x += e.deltaX / cam.zoom;
    cam.y += e.deltaY / cam.zoom;
    invalidate();
    syncEditor();
  }
}, { passive: false });

addEventListener("keydown", (e) => {
  if (e.target === $("#editor")) {
    if (e.key === "Escape") { commitEditor(); e.preventDefault(); }
    return;
  }
  if (e.target.closest && e.target.closest("button") && (e.key === " " || e.key === "Enter")) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); animateZoom(cam.zoom * 1.5); return; }
  if (mod && e.key === "-") { e.preventDefault(); animateZoom(cam.zoom / 1.5); return; }
  if (mod && e.key === "0") { e.preventDefault(); animateZoom(1); return; }
  if (mod) return;
  if (e.key === " " && !spaceHeld) { spaceHeld = true; canvas.classList.add("panning"); e.preventDefault(); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && selected) { change(selected, { deleted: true }); select(null); return; }
  if (e.key === "Escape") { select(null); return; }
  const shortcut = { v: "select", h: "hand", p: "pen", r: "rect", o: "ellipse", n: "note", e: "eraser" }[e.key.toLowerCase()];
  if (shortcut) pickTool(shortcut);
});
addEventListener("keyup", (e) => { if (e.key === " ") { spaceHeld = false; canvas.classList.remove("panning"); setToolClass(); } });

// ---------- Sticky note editing ----------
let editing = null;
const editor = $("#editor");
canvas.addEventListener("dblclick", (e) => {
  const world = toWorld(e.clientX, e.clientY);
  const s = hit(world.x, world.y);
  if (s && s.type === "note") openEditor(s.id);
});
function openEditor(id) {
  const s = doc.shape(id);
  if (!s) return;
  editing = id;
  editor.value = s.text || "";
  editor.dataset.before = editor.value;
  editor.style.display = "block";
  syncEditor();
  editor.focus();
  invalidate();
}
function syncEditor() {
  if (!editing) return;
  const s = doc.shape(editing);
  if (!s) { editor.style.display = "none"; editing = null; return; }
  const b = bounds(s), p = toScreen(b.x, b.y);
  editor.style.left = `${p.x}px`;
  editor.style.top = `${p.y}px`;
  editor.style.width = `${b.w}px`;
  editor.style.height = `${b.h}px`;
  editor.style.transform = `scale(${cam.zoom})`;
}
let typing = null;
editor.addEventListener("input", () => {
  clearTimeout(typing);
  typing = setTimeout(() => editing && change(editing, { text: editor.value.slice(0, 2000) }, { history: false }), 250);
});
editor.addEventListener("blur", () => commitEditor());
function commitEditor() {
  if (!editing) return;
  clearTimeout(typing);
  const id = editing, before = editor.dataset.before, text = editor.value.slice(0, 2000);
  editing = null;
  editor.style.display = "none";
  if (text !== before) {
    change(id, { text }, { history: false });
    pushUndo([{ id, before: { text: before }, after: { text } }]);
  }
  invalidate();
}

// ---------- Share ----------
$("#share").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast("Link copied. Anyone with it can draw here.");
  } catch {
    toast(location.href);
  }
});

setToolClass();
syncUndoButtons();
connect();
// Debug handle for poking at state from the console (and for automated checks).
window.__canvas = { doc, peers, cam, get connected() { return connected; }, get outbox() { return outbox; }, clientId };

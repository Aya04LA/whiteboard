// Fan-out latency: how long from one client's edit to everyone else seeing it?
//
//   docker compose up --build
//   k6 run loadtest/k6.js
//
// Virtual users join rooms of ROOM_SIZE. Each sends cursor moves at 20/s and
// an edit every second. The edit carries its send time, so receivers measure
// end-to-end latency (through nginx, either instance, Redis pub/sub, and back).
// Every user is both sender and receiver on one k6 machine, so one clock is
// shared and the measurement needs no clock sync. Rooms cap at 5,000 shapes:
// for long runs, restart the stack (or set BASE_URL to a fresh one) between runs.
import ws from "k6/ws";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE = (__ENV.BASE_URL || "http://localhost:8080").replace(/^http/, "ws");
const ROOM_SIZE = Number(__ENV.ROOM_SIZE || 10);
const latency = new Trend("fanout_latency_ms", true);
const received = new Counter("ops_received");

export const options = {
  scenarios: {
    rooms: {
      executor: "ramping-vus",
      startVUs: 10,
      stages: [
        { target: 200, duration: "30s" },
        { target: 500, duration: "1m" },
        { target: 500, duration: "1m" },
      ],
    },
  },
  thresholds: {
    fanout_latency_ms: ["p(95)<100", "p(99)<250"],
    ws_connecting: ["p(95)<500"],
  },
};

export default function () {
  const room = `load-${Math.floor((__VU - 1) / ROOM_SIZE)}`;
  const client = `k6${__VU}x${__ITER}`;
  const url = `${BASE}/ws/${room}?client=${client}&name=Load%20${__VU}`;
  let seq = 0;

  const res = ws.connect(url, {}, (socket) => {
    socket.on("open", () => {
      socket.setInterval(() => {
        socket.send(JSON.stringify({ t: "cursor", x: Math.random() * 1000, y: Math.random() * 800 }));
      }, 50);
      socket.setInterval(() => {
        const now = Date.now();
        const ts = [now, 0, client];
        socket.send(JSON.stringify({
          t: "ops",
          ops: [{ id: `${client}-${seq++}`, f: { type: ["note", ts], x: [0, ts], y: [0, ts], text: [String(now), ts] } }],
        }));
      }, 1000);
      socket.setTimeout(() => socket.close(), 30000);
    });
    socket.on("message", (data) => {
      const msg = JSON.parse(data);
      if (msg.t !== "ops") return;
      for (const op of msg.ops) {
        if (op.f.text) {
          latency.add(Date.now() - Number(op.f.text[0]));
          received.add(1);
        }
      }
    });
  });
  check(res, { "connected (101)": (r) => r && r.status === 101 });
}

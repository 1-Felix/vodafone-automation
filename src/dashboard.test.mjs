import test from "node:test";
import assert from "node:assert/strict";
import { startDashboard } from "./dashboard.mjs";

async function serve(overrides = {}) {
  const calls = { toggles: 0, events: [] };
  const server = startDashboard({
    port: 0,
    getStatus: () => ({ connState: "CABLE_OK", armed: true }),
    toggleArmed: async () => { calls.toggles++; return false; },
    onWanEvent: (e) => calls.events.push(e),
    ...overrides,
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, calls };
}

test("GET /api/status returns status JSON", async () => {
  const { server, base } = await serve();
  const res = await fetch(`${base}/api/status`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { connState: "CABLE_OK", armed: true });
  server.close();
});

test("GET / serves HTML with toggle button", async () => {
  const { server, base } = await serve();
  const html = await (await fetch(base + "/")).text();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /api\/toggle/);
  server.close();
});

test("POST /api/toggle calls toggleArmed", async () => {
  const { server, base, calls } = await serve();
  const res = await fetch(`${base}/api/toggle`, { method: "POST" });
  assert.deepEqual(await res.json(), { armed: false });
  assert.equal(calls.toggles, 1);
  server.close();
});

test("POST /event dispatches wan event", async () => {
  const { server, base, calls } = await serve();
  await fetch(`${base}/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ iface: "wan", action: "ifdown" }),
  });
  assert.deepEqual(calls.events, [{ iface: "wan", action: "ifdown" }]);
  server.close();
});

test("unknown route returns 404, handler errors return 500", async () => {
  const { server, base } = await serve({
    getStatus: () => { throw new Error("boom"); },
  });
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  const res = await fetch(`${base}/api/status`);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "boom" });
  server.close();
});

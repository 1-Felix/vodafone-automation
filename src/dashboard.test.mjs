import test from "node:test";
import assert from "node:assert/strict";
import { startDashboard } from "./dashboard.mjs";

async function serve(overrides = {}) {
  const calls = { toggles: 0, events: [] };
  const server = startDashboard({
    port: 0,
    getStatus: () => ({ connState: "CABLE_OK", armed: true }),
    toggleArmed: async () => { calls.toggles++; return false; },
    toggleGuard: async () => { calls.guards = (calls.guards ?? 0) + 1; return { state: "open", openUntil: "2026-07-27T14:00:00.000Z", openMinutes: 60 }; },
    setBalance: async (eur) => { calls.balances = [...(calls.balances ?? []), eur]; return { eur, anchorEur: eur, anchorTs: "2026-07-27T14:00:00.000Z", low: false }; },
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

test("POST /api/guard calls toggleGuard and returns guard", async () => {
  const { server, base, calls } = await serve();
  const res = await fetch(`${base}/api/guard`, { method: "POST" });
  assert.deepEqual(await res.json(), { guard: { state: "open", openUntil: "2026-07-27T14:00:00.000Z", openMinutes: 60 } });
  assert.equal(calls.guards, 1);
  server.close();
});

test("GET / includes guard and balance UI", async () => {
  const { server, base } = await serve();
  const html = await (await fetch(base + "/")).text();
  assert.match(html, /api\/guard/);
  assert.match(html, /Guthaben/);
  server.close();
});

test("POST /api/balance parses eur and calls setBalance", async () => {
  const { server, base, calls } = await serve();
  const res = await fetch(`${base}/api/balance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eur: 12.34 }),
  });
  assert.equal((await res.json()).balance.eur, 12.34);
  assert.deepEqual(calls.balances, [12.34]);
  server.close();
});

test("POST /api/balance with garbage returns 500", async () => {
  const { server, base } = await serve({
    setBalance: async (eur) => { if (!Number.isFinite(eur)) throw new Error("invalid balance"); return {}; },
  });
  const res = await fetch(`${base}/api/balance`, { method: "POST", body: "not json" });
  assert.equal(res.status, 500);
  server.close();
});

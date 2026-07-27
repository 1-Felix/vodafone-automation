import test from "node:test";
import assert from "node:assert/strict";
import {
  deltaBytes, costEur, deriveConnState, nextSampleDelayMs,
  aggregateUsage, isDrillDue, shouldSendRunningUpdate,
} from "./lte.mjs";

test("deltaBytes: first sample establishes baseline", () => {
  assert.equal(deltaBytes(null, 5000), 0);
  assert.equal(deltaBytes(undefined, 5000), 0);
});

test("deltaBytes: normal monotonic delta", () => {
  assert.equal(deltaBytes(1000, 1500), 500);
});

test("deltaBytes: counter reset returns bytes since reset", () => {
  assert.equal(deltaBytes(900000, 200), 200);
});

test("costEur: 3 ct per MB", () => {
  assert.equal(costEur(1_000_000, 0.03), 0.03);
  assert.equal(costEur(0, 0.03), 0);
});

test("deriveConnState", () => {
  assert.equal(deriveConnState({ wanUp: true, lteUp: true }), "CABLE_OK");
  assert.equal(deriveConnState({ wanUp: false, lteUp: true }), "LTE_ACTIVE");
  assert.equal(deriveConnState({ wanUp: false, lteUp: false }), "ALL_DOWN");
});

test("nextSampleDelayMs: fast only while LTE active", () => {
  assert.equal(nextSampleDelayMs("LTE_ACTIVE"), 60_000);
  assert.equal(nextSampleDelayMs("CABLE_OK"), 600_000);
});

test("aggregateUsage buckets by UTC day and month", () => {
  const entries = [
    { ts: "2026-07-27T10:00:00Z", bytes: 1_000_000 },
    { ts: "2026-07-26T10:00:00Z", bytes: 2_000_000 },
    { ts: "2026-06-01T10:00:00Z", bytes: 4_000_000 },
  ];
  const a = aggregateUsage(entries, "2026-07-27T12:00:00.000Z");
  assert.equal(a.day.bytes, 1_000_000);
  assert.equal(a.month.bytes, 3_000_000);
  assert.equal(a.total.bytes, 7_000_000);
  assert.ok(Math.abs(a.month.costEur - 0.09) < 1e-9);
});

test("isDrillDue: due once per month after ~04:00 Berlin (03 UTC)", () => {
  assert.equal(isDrillDue(null, "2026-07-01T05:00:00.000Z"), true);
  assert.equal(isDrillDue("2026-06-01T05:00:00.000Z", "2026-07-01T05:00:00.000Z"), true);
  assert.equal(isDrillDue("2026-07-01T05:00:00.000Z", "2026-07-15T09:00:00.000Z"), false);
  assert.equal(isDrillDue(null, "2026-07-01T01:00:00.000Z"), false); // before 03 UTC
});

test("shouldSendRunningUpdate: every 30 min while LTE active", () => {
  assert.equal(shouldSendRunningUpdate("LTE_ACTIVE", null, 10_000_000), true);
  assert.equal(shouldSendRunningUpdate("LTE_ACTIVE", 10_000_000, 10_000_000 + 1_800_000), true);
  assert.equal(shouldSendRunningUpdate("LTE_ACTIVE", 10_000_000, 10_000_000 + 60_000), false);
  assert.equal(shouldSendRunningUpdate("CABLE_OK", null, 10_000_000), false);
});

// --- deriveLteAlerts ---

import { deriveLteAlerts } from "./lte.mjs";
import { Color } from "./notify.mjs";

const NOW = 1_800_000_000_000;

test("alert on failover start", () => {
  const { alerts, state } = deriveLteAlerts(
    { connState: "CABLE_OK", armed: true, backupOk: true },
    { connState: "LTE_ACTIVE", armed: true, backupOk: true, closedSession: null },
    NOW,
  );
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /Failover active/);
  assert.equal(alerts[0].color, Color.RED);
  assert.equal(state.connState, "LTE_ACTIVE");
});

test("alert with cost summary on failover end", () => {
  const { alerts } = deriveLteAlerts(
    { connState: "LTE_ACTIVE", armed: true, backupOk: true },
    {
      connState: "CABLE_OK", armed: true, backupOk: true,
      closedSession: {
        startTs: new Date(NOW - 3_600_000).toISOString(),
        endTs: new Date(NOW).toISOString(),
        bytes: 50_000_000,
      },
    },
    NOW,
  );
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /50\.0 MB/);
  assert.match(alerts[0].message, /1\.50 €/);
  assert.equal(alerts[0].color, Color.GREEN);
});

test("alert on disarm and re-arm", () => {
  const a = deriveLteAlerts(
    { connState: "CABLE_OK", armed: true, backupOk: true },
    { connState: "CABLE_OK", armed: false, backupOk: true, closedSession: null }, NOW);
  assert.match(a.alerts[0].message, /disarmed/);
  const b = deriveLteAlerts(a.state,
    { connState: "CABLE_OK", armed: true, backupOk: true, closedSession: null }, NOW);
  assert.match(b.alerts[0].message, /armed/);
});

test("backup-broken alert once per cooldown, only while cable ok", () => {
  const first = deriveLteAlerts(
    { connState: "CABLE_OK", armed: true, backupOk: true },
    { connState: "CABLE_OK", armed: true, backupOk: false, closedSession: null }, NOW);
  assert.equal(first.alerts.length, 1);
  assert.match(first.alerts[0].message, /broken/);
  const second = deriveLteAlerts(first.state,
    { connState: "CABLE_OK", armed: true, backupOk: false, closedSession: null }, NOW + 60_000);
  assert.equal(second.alerts.length, 0);
});

test("no alerts on steady state or first run", () => {
  const steady = deriveLteAlerts(
    { connState: "CABLE_OK", armed: true, backupOk: true },
    { connState: "CABLE_OK", armed: true, backupOk: true, closedSession: null }, NOW);
  assert.equal(steady.alerts.length, 0);
  const first = deriveLteAlerts({},
    { connState: "CABLE_OK", armed: true, backupOk: true, closedSession: null }, NOW);
  assert.equal(first.alerts.length, 0);
});

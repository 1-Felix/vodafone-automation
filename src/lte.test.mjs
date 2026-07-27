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

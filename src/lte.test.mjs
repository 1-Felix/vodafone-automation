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
import { Color, Tier } from "./notify.mjs";

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
  assert.equal(alerts[0].tier, Tier.CRITICAL);
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
  // pairs with failover start — both critical, because a session ending is
  // the all-clear for money burning
  assert.equal(alerts[0].tier, Tier.CRITICAL);
});

test("alert on disarm and re-arm", () => {
  const a = deriveLteAlerts(
    { connState: "CABLE_OK", armed: true, backupOk: true },
    { connState: "CABLE_OK", armed: false, backupOk: true, closedSession: null }, NOW);
  assert.match(a.alerts[0].message, /disarmed/);
  assert.equal(a.alerts[0].tier, Tier.LOG);
  const b = deriveLteAlerts(a.state,
    { connState: "CABLE_OK", armed: true, backupOk: true, closedSession: null }, NOW);
  assert.match(b.alerts[0].message, /armed/);
  assert.equal(b.alerts[0].tier, Tier.LOG);
});

test("backup-broken alert once per cooldown, only while cable ok", () => {
  const first = deriveLteAlerts(
    { connState: "CABLE_OK", armed: true, backupOk: true },
    { connState: "CABLE_OK", armed: true, backupOk: false, closedSession: null }, NOW);
  assert.equal(first.alerts.length, 1);
  assert.match(first.alerts[0].message, /broken/);
  assert.equal(first.alerts[0].tier, Tier.WARN);
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

import { BALANCE_ALERT_REPEAT_MS } from "./lte.mjs";

const STEADY = { connState: "CABLE_OK", armed: true, backupOk: true, closedSession: null };

test("low balance alerts once, repeats after 24 h while low", () => {
  const a = deriveLteAlerts({ ...STEADY }, { ...STEADY, balanceEur: 8.5 }, NOW);
  assert.equal(a.alerts.length, 1);
  assert.match(a.alerts[0].message, /8\.50 €/);
  assert.equal(a.alerts[0].color, Color.YELLOW);
  assert.equal(a.alerts[0].tier, Tier.WARN);
  const b = deriveLteAlerts(a.state, { ...STEADY, balanceEur: 8.4 }, NOW + 60_000);
  assert.equal(b.alerts.length, 0);
  const c = deriveLteAlerts(b.state, { ...STEADY, balanceEur: 8.4 }, NOW + BALANCE_ALERT_REPEAT_MS + 1);
  assert.equal(c.alerts.length, 1);
});

test("healthy balance and null balance never alert", () => {
  assert.equal(deriveLteAlerts({ ...STEADY }, { ...STEADY, balanceEur: 15 }, NOW).alerts.length, 0);
  assert.equal(deriveLteAlerts({ ...STEADY }, { ...STEADY, balanceEur: null }, NOW).alerts.length, 0);
});

test("guard transitions alert: open YELLOW with until-time, relock GREEN, missing RED", () => {
  const open = deriveLteAlerts({ ...STEADY, guardState: "locked" },
    { ...STEADY, guardState: "open", guardOpenUntil: "2026-07-27T13:45:00.000Z" }, NOW);
  assert.equal(open.alerts.length, 1);
  assert.equal(open.alerts[0].color, Color.YELLOW);
  assert.match(open.alerts[0].message, /13:45/);
  // open/locked are self-inflicted dashboard toggles — muted
  assert.equal(open.alerts[0].tier, Tier.LOG);
  const lock = deriveLteAlerts(open.state, { ...STEADY, guardState: "locked" }, NOW);
  assert.equal(lock.alerts.length, 1);
  assert.equal(lock.alerts[0].color, Color.GREEN);
  assert.equal(lock.alerts[0].tier, Tier.LOG);
  const miss = deriveLteAlerts(lock.state, { ...STEADY, guardState: "missing" }, NOW);
  assert.equal(miss.alerts.length, 1);
  assert.equal(miss.alerts[0].color, Color.RED);
  // nobody asked for this one — the guard is gone and LTE is unrestricted
  assert.equal(miss.alerts[0].tier, Tier.CRITICAL);
});

test("guard first observation: locked silent, missing alerts", () => {
  assert.equal(deriveLteAlerts({ ...STEADY }, { ...STEADY, guardState: "locked" }, NOW).alerts.length, 0);
  const miss = deriveLteAlerts({ ...STEADY }, { ...STEADY, guardState: "missing" }, NOW);
  assert.equal(miss.alerts.length, 1);
  assert.equal(miss.alerts[0].color, Color.RED);
  assert.equal(miss.alerts[0].tier, Tier.CRITICAL);
});

test("ALL DOWN alerts critical", () => {
  const { alerts } = deriveLteAlerts(
    { connState: "CABLE_OK", armed: true, backupOk: true },
    { connState: "ALL_DOWN", armed: false, backupOk: false, closedSession: null }, NOW);
  assert.match(alerts[0].message, /ALL DOWN/);
  assert.equal(alerts[0].color, Color.RED);
  assert.equal(alerts[0].tier, Tier.CRITICAL);
});

import {
  backgroundBytes, shouldAutoDisarm, LEAK_ALERT_MB, BALANCE_RESERVE_EUR,
} from "./lte.mjs";

test("backgroundBytes: sums untagged entries for the current day only", () => {
  const entries = [
    { ts: "2026-07-29T01:00:00Z", bytes: 1_000_000 },          // background today
    { ts: "2026-07-29T02:00:00Z", bytes: 2_000_000, s: 1 },    // session traffic — excluded
    { ts: "2026-07-28T02:00:00Z", bytes: 4_000_000 },          // yesterday — excluded
  ];
  assert.equal(backgroundBytes(entries, "2026-07-29T12:00:00.000Z"), 1_000_000);
});

test("shouldAutoDisarm: only armed + cable ok + tracked balance at/below reserve", () => {
  const base = { connState: "CABLE_OK", armed: true, balanceEur: BALANCE_RESERVE_EUR };
  assert.equal(shouldAutoDisarm(base), true);
  assert.equal(shouldAutoDisarm({ ...base, balanceEur: BALANCE_RESERVE_EUR + 0.01 }), false);
  assert.equal(shouldAutoDisarm({ ...base, armed: false }), false);
  assert.equal(shouldAutoDisarm({ ...base, connState: "LTE_ACTIVE" }), false);
  assert.equal(shouldAutoDisarm({ ...base, connState: "ALL_DOWN" }), false);
  assert.equal(shouldAutoDisarm({ ...base, balanceEur: null }), false);
});

test("background leak warns once per day, escalates critical at 5x", () => {
  const warnBytes = LEAK_ALERT_MB * 1e6;
  const a = deriveLteAlerts({ ...STEADY }, { ...STEADY, bgBytes: warnBytes }, NOW);
  assert.equal(a.alerts.length, 1);
  assert.match(a.alerts[0].message, /[Bb]ackground/);
  assert.equal(a.alerts[0].color, Color.YELLOW);
  assert.equal(a.alerts[0].tier, Tier.WARN);
  // same day, still leaking a bit more — silent
  const b = deriveLteAlerts(a.state, { ...STEADY, bgBytes: warnBytes * 2 }, NOW + 60_000);
  assert.equal(b.alerts.length, 0);
  // crosses the critical threshold the same day — escalates once
  const c = deriveLteAlerts(b.state, { ...STEADY, bgBytes: warnBytes * 5 }, NOW + 120_000);
  assert.equal(c.alerts.length, 1);
  assert.equal(c.alerts[0].tier, Tier.CRITICAL);
  // next day, leak persists — warns again
  const d = deriveLteAlerts(c.state, { ...STEADY, bgBytes: warnBytes }, NOW + 86_400_000);
  assert.equal(d.alerts.length, 1);
  assert.equal(d.alerts[0].tier, Tier.WARN);
});

test("background usage below threshold stays silent", () => {
  const { alerts } = deriveLteAlerts(
    { ...STEADY }, { ...STEADY, bgBytes: LEAK_ALERT_MB * 1e6 - 1 }, NOW);
  assert.equal(alerts.length, 0);
});

test("reserve floor during active failover warns critical without disarm intent", () => {
  const active = { connState: "LTE_ACTIVE", armed: true, backupOk: true, closedSession: null };
  const a = deriveLteAlerts({ ...active }, { ...active, balanceEur: BALANCE_RESERVE_EUR }, NOW);
  const reserve = a.alerts.find((x) => /reserve/i.test(x.message));
  assert.ok(reserve, "reserve alert sent");
  assert.equal(reserve.tier, Tier.CRITICAL);
  // repeat within cooldown — silent
  const b = deriveLteAlerts(a.state, { ...active, balanceEur: 0.1 }, NOW + 60_000);
  assert.equal(b.alerts.filter((x) => /reserve/i.test(x.message)).length, 0);
});

import { computeBalance } from "./lte.mjs";

test("computeBalance: anchor minus metered usage since anchor", () => {
  const anchor = { ts: "2026-07-27T10:00:00.000Z", eur: 20 };
  const usage = [
    { ts: "2026-07-27T09:00:00.000Z", bytes: 99_000_000 }, // before anchor — ignored
    { ts: "2026-07-27T11:00:00.000Z", bytes: 5_000_000 },  // 0.15 €
    { ts: "2026-07-27T12:00:00.000Z", bytes: 1_000_000 },  // 0.03 €
  ];
  assert.equal(computeBalance(anchor, usage), 19.82);
});
test("computeBalance: null without anchor, floors at 0", () => {
  assert.equal(computeBalance(null, []), null);
  assert.equal(computeBalance({ ts: "2026-07-27T10:00:00.000Z", eur: 0.05 },
    [{ ts: "2026-07-27T11:00:00.000Z", bytes: 900_000_000 }]), 0);
});

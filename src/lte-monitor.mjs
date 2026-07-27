import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.mjs";
import { notify, Color } from "./notify.mjs";
import * as realFlint from "./flint.mjs";
import {
  aggregateUsage, computeBalance, costEur, deltaBytes, deriveConnState, deriveLteAlerts,
  fmtEur, fmtMb, isDrillDue, nextSampleDelayMs, shouldSendRunningUpdate,
  BALANCE_LOW_EUR, LINK_GRACE_MS, SLOW_SAMPLE_MS,
} from "./lte.mjs";

const DATA_DIR = process.env.DATA_DIR ?? "./data";
const LTE_IFACE = process.env.LTE_IFACE ?? "secondwan";
const USAGE_FILE = join(DATA_DIR, "lte-usage.jsonl");
const SESSIONS_FILE = join(DATA_DIR, "lte-sessions.jsonl");
const STATE_FILE = join(DATA_DIR, "lte-state.json");
const BALANCE_FILE = join(DATA_DIR, "lte-balance.jsonl");
const GUARD_OPEN_MS = parseInt(process.env.GUARD_OPEN_MINUTES ?? "60") * 60_000;
const GUARD_STUCK_ALERT_MS = 30 * 60_000;

function loadJsonl(file) {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return []; // skip corrupt line
      }
    });
  } catch {
    return []; // file doesn't exist yet
  }
}

export function startLteMonitor(deps = {}) {
  const flint = deps.flint ?? realFlint;
  const send = deps.send ?? notify;
  const autoStart = deps.autoStart ?? true;

  mkdirSync(DATA_DIR, { recursive: true });
  const usage = loadJsonl(USAGE_FILE);
  const sessions = loadJsonl(SESSIONS_FILE);
  let persisted = {};
  try {
    persisted = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    // fresh state
  }

  const anchors = loadJsonl(BALANCE_FILE);
  let anchor = anchors.at(-1) ?? null; // {ts, eur, source} — last manual balance sync
  let guardState = null;
  let guardOpenUntil = null; // epoch ms | null (null while open = not ours → relock)
  let lastGuardStuckAlertAt = 0;
  let alertState = {};
  let session = null;
  let lastCounter = null;
  let lastHealthAt = 0;
  let lteDownSince = null;
  let backupOk = undefined;
  let lastRunningUpdateAt = null;
  let lastTickTs = null;
  let timer = null;

  async function tick() {
    const ts = new Date().toISOString();
    const now = Date.now();
    const [wan, lte] = await Promise.all([
      flint.getIfaceStatus("wan"),
      flint.getIfaceStatus(LTE_IFACE),
    ]);
    const armed = !!lte.autostart;

    const counter = await flint.readCountersTotal();
    const delta = counter === null ? 0 : deltaBytes(lastCounter, counter);
    if (counter !== null) lastCounter = counter;
    if (delta > 0) {
      const entry = { ts, bytes: delta };
      appendFileSync(USAGE_FILE, JSON.stringify(entry) + "\n");
      usage.push(entry);
      if (session) session.bytes += delta;
    }

    const connState = deriveConnState({ wanUp: wan.up, lteUp: lte.up });

    let closedSession = null;
    if (connState === "LTE_ACTIVE" && !session) {
      session = { startTs: ts, bytes: 0 };
      lastRunningUpdateAt = now; // first running update 30 min in, not at start
    } else if (connState !== "LTE_ACTIVE" && session) {
      closedSession = { ...session, endTs: ts };
      const rec = { ...closedSession, costEur: costEur(closedSession.bytes) };
      appendFileSync(SESSIONS_FILE, JSON.stringify(rec) + "\n");
      sessions.push(rec);
      session = null;
    }

    // Backup health: link-down (Spitz off/unplugged) counts as broken after a
    // grace period; otherwise ping at slow cadence (active LTE proves itself).
    if (connState === "LTE_ACTIVE") {
      backupOk = true;
      lteDownSince = null;
    } else if (connState === "CABLE_OK" && armed) {
      if (!lte.up) {
        lteDownSince ??= now;
        if (now - lteDownSince >= LINK_GRACE_MS) backupOk = false;
      } else {
        lteDownSince = null;
        if (backupOk === false || now - lastHealthAt >= SLOW_SAMPLE_MS) {
          lastHealthAt = now;
          try {
            backupOk = await flint.healthPing();
          } catch {
            backupOk = false;
          }
        }
      }
    } else {
      lteDownSince = null;
    }

    // LTE guard: read state; relock when the window expired or nobody owns the open
    const firstGuardRead = alertState.guardState === undefined;
    guardState = await flint.getGuardState();
    if (guardState === "open" && (guardOpenUntil === null || now >= guardOpenUntil)) {
      try {
        await flint.relockGuard();
        guardState = await flint.getGuardState();
        if (guardOpenUntil === null && !firstGuardRead) {
          await send("LTE guard was opened outside the dashboard — **re-locked** it.", Color.YELLOW);
        } else if (guardOpenUntil === null) {
          await send("LTE guard **re-locked on startup** (was open).", Color.GREEN);
        }
        guardOpenUntil = null;
      } catch (err) {
        if (now - lastGuardStuckAlertAt >= GUARD_STUCK_ALERT_MS) {
          lastGuardStuckAlertAt = now;
          await send(`LTE guard relock **FAILED** (${err.message}) — guard is stuck OPEN, retrying every tick.`, Color.RED);
        }
      }
    }
    if (guardState !== "open") guardOpenUntil = null;

    const { alerts, state } = deriveLteAlerts(alertState, {
      connState, armed, backupOk, closedSession,
      balanceEur: computeBalance(anchor, usage),
      guardState,
      guardOpenUntil: guardOpenUntil ? new Date(guardOpenUntil).toISOString() : null,
    }, now);
    alertState = state;
    for (const a of alerts) await send(a.message, a.color);

    if (session && shouldSendRunningUpdate(connState, lastRunningUpdateAt, now)) {
      lastRunningUpdateAt = now;
      await send(
        `LTE failover still active — session ${fmtMb(session.bytes)} MB ≈ ${fmtEur(costEur(session.bytes))}.`,
        Color.YELLOW,
      );
    }
    if (!session) lastRunningUpdateAt = null;

    if (connState === "CABLE_OK" && isDrillDue(persisted.lastDrillTs, ts)) {
      persisted.lastDrillTs = ts;
      writeFileSync(STATE_FILE, JSON.stringify(persisted));
      if (armed) {
        try {
          const r = await flint.runDrill();
          const mbit = r.seconds > 0 ? ((r.bytes * 8) / r.seconds / 1e6).toFixed(0) : "?";
          await send(
            r.ok
              ? `Monthly LTE drill OK — ${fmtMb(r.bytes)} MB in ${r.seconds.toFixed(1)} s (~${mbit} Mbit/s), cost ≈ ${fmtEur(costEur(r.bytes))}.`
              : "Monthly LTE drill **FAILED** — check the Spitz/SIM.",
            r.ok ? Color.GREEN : Color.RED,
          );
        } catch (err) {
          await send(`Monthly LTE drill **FAILED**: ${err.message}`, Color.RED);
        }
      } else {
        await send("Monthly LTE drill skipped — fallback is disarmed.", Color.YELLOW);
      }
    }

    lastTickTs = ts;
    if (autoStart) schedule(nextSampleDelayMs(connState));
    return connState;
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      tick().catch((err) => {
        log(`LTE monitor tick failed: ${err.message}`);
        schedule(SLOW_SAMPLE_MS);
      });
    }, ms);
    timer.unref?.();
  }

  async function getStatus() {
    return {
      connState: alertState.connState ?? null,
      armed: alertState.armed ?? null,
      backupOk: backupOk ?? null,
      session: session ? { ...session, costEur: costEur(session.bytes) } : null,
      totals: aggregateUsage(usage, new Date().toISOString()),
      history: sessions.slice(-20).reverse(),
      balance: anchor ? {
        eur: computeBalance(anchor, usage),
        anchorEur: anchor.eur,
        anchorTs: anchor.ts,
        low: computeBalance(anchor, usage) < BALANCE_LOW_EUR,
      } : null,
      guard: {
        state: guardState,
        openUntil: guardOpenUntil ? new Date(guardOpenUntil).toISOString() : null,
        openMinutes: GUARD_OPEN_MS / 60_000,
      },
      updatedAt: lastTickTs,
    };
  }

  async function toggleArmed() {
    const lte = await flint.getIfaceStatus(LTE_IFACE);
    await flint.setLteArmed(!lte.autostart);
    await tick();
    return !lte.autostart;
  }

  async function setBalance(eur) {
    if (!Number.isFinite(eur) || eur < 0 || eur > 1000) throw new Error(`invalid balance: ${eur}`);
    anchor = { ts: new Date().toISOString(), eur, source: "manual" };
    appendFileSync(BALANCE_FILE, JSON.stringify(anchor) + "\n");
    await tick();
    return (await getStatus()).balance;
  }

  async function toggleGuard() {
    const s = await flint.getGuardState();
    if (s === "open") {
      guardOpenUntil = null;
      await flint.relockGuard();
    } else if (s === "locked") {
      guardOpenUntil = Date.now() + GUARD_OPEN_MS;
      await flint.openGuard();
    } else {
      await flint.relockGuard(); // "missing": try to rebuild from the include script
    }
    await tick();
    return (await getStatus()).guard;
  }

  function onWanEvent(evt) {
    log(`WAN event from Flint: ${evt.iface} ${evt.action}`);
    if (autoStart) schedule(2_000);
  }

  if (autoStart) {
    tick().catch((err) => {
      log(`LTE monitor initial tick failed: ${err.message}`);
      schedule(SLOW_SAMPLE_MS);
    });
  }

  return { getStatus, toggleArmed, toggleGuard, setBalance, onWanEvent, tick };
}

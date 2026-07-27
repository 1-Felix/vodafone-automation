import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.mjs";
import { notify, Color } from "./notify.mjs";
import * as realFlint from "./flint.mjs";
import {
  aggregateUsage, costEur, deltaBytes, deriveConnState, deriveLteAlerts,
  fmtEur, fmtMb, isDrillDue, nextSampleDelayMs, shouldSendRunningUpdate,
  LINK_GRACE_MS, SLOW_SAMPLE_MS,
} from "./lte.mjs";

const DATA_DIR = process.env.DATA_DIR ?? "./data";
const LTE_IFACE = process.env.LTE_IFACE ?? "secondwan";
const USAGE_FILE = join(DATA_DIR, "lte-usage.jsonl");
const SESSIONS_FILE = join(DATA_DIR, "lte-sessions.jsonl");
const STATE_FILE = join(DATA_DIR, "lte-state.json");

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

    const { alerts, state } = deriveLteAlerts(alertState, { connState, armed, backupOk, closedSession }, now);
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
      updatedAt: lastTickTs,
    };
  }

  async function toggleArmed() {
    const lte = await flint.getIfaceStatus(LTE_IFACE);
    await flint.setLteArmed(!lte.autostart);
    await tick();
    return !lte.autostart;
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

  return { getStatus, toggleArmed, onWanEvent, tick };
}

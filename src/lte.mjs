import { Color } from "./notify.mjs";

export const RATE_PER_MB = parseFloat(process.env.LTE_COST_PER_MB ?? "0.03");
export const FAST_SAMPLE_MS = 60_000;
export const SLOW_SAMPLE_MS = 600_000;
export const RUNNING_UPDATE_MS = 30 * 60_000;
export const BACKUP_ALERT_COOLDOWN_MS = 6 * 60 * 60_000;
// Grace before an armed-but-linkless secondwan counts as broken (re-arm DHCP window)
export const LINK_GRACE_MS = parseInt(process.env.LTE_LINK_GRACE_MS ?? "120000");

export function deltaBytes(prev, curr) {
  if (prev === null || prev === undefined || !Number.isFinite(curr)) return 0;
  return curr >= prev ? curr - prev : curr; // reset → bytes since reset
}

export function costEur(bytes, ratePerMb = RATE_PER_MB) {
  return (bytes / 1e6) * ratePerMb;
}

export function deriveConnState({ wanUp, lteUp }) {
  if (wanUp) return "CABLE_OK";
  return lteUp ? "LTE_ACTIVE" : "ALL_DOWN";
}

export function nextSampleDelayMs(connState) {
  return connState === "LTE_ACTIVE" ? FAST_SAMPLE_MS : SLOW_SAMPLE_MS;
}

export function aggregateUsage(entries, nowIso) {
  const day = nowIso.slice(0, 10);
  const month = nowIso.slice(0, 7);
  let d = 0, m = 0, t = 0;
  for (const e of entries) {
    t += e.bytes;
    if (e.ts.slice(0, 7) === month) m += e.bytes;
    if (e.ts.slice(0, 10) === day) d += e.bytes;
  }
  const wrap = (bytes) => ({ bytes, costEur: costEur(bytes) });
  return { day: wrap(d), month: wrap(m), total: wrap(t) };
}

// Due when we enter a new calendar month, but only after 03:00 UTC (~04:00 Berlin)
export function isDrillDue(lastDrillTs, nowIso) {
  if (parseInt(nowIso.slice(11, 13), 10) < 3) return false;
  return (lastDrillTs ?? "").slice(0, 7) < nowIso.slice(0, 7);
}

export function shouldSendRunningUpdate(connState, lastUpdateAt, now) {
  return connState === "LTE_ACTIVE" && now - (lastUpdateAt ?? 0) >= RUNNING_UPDATE_MS;
}

export function fmtMb(bytes) {
  return (bytes / 1e6).toFixed(1);
}

export function fmtEur(eur) {
  return eur.toFixed(2) + " €";
}

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://192.168.0.37:8799";

/**
 * Edge-triggered failover alerting, mirroring deriveAlerts in collector.mjs.
 * state: previous {connState?, armed?, backupOk?, lastBackupAlertAt?} ({} on first run)
 * curr:  {connState, armed, backupOk, closedSession}
 */
export function deriveLteAlerts(state, curr, now) {
  const alerts = [];
  const next = { ...state };

  if (state.connState !== undefined && state.connState !== curr.connState) {
    if (curr.connState === "LTE_ACTIVE") {
      alerts.push({
        message: `**Failover active** — traffic is running over LTE at ${(RATE_PER_MB * 100).toFixed(0)} ct/MB. ${DASHBOARD_URL}`,
        color: Color.RED,
      });
    } else if (state.connState === "LTE_ACTIVE" && curr.closedSession) {
      const s = curr.closedSession;
      const mins = Math.max(1, Math.round((Date.parse(s.endTs) - Date.parse(s.startTs)) / 60_000));
      alerts.push({
        message: `Failover ended after ${mins} min — ${fmtMb(s.bytes)} MB ≈ ${fmtEur(costEur(s.bytes))}.`,
        color: Color.GREEN,
      });
    } else if (curr.connState === "ALL_DOWN") {
      alerts.push({
        message: `**ALL DOWN** — cable is down and LTE fallback is ${curr.armed ? "unavailable" : "disarmed"}.`,
        color: Color.RED,
      });
    }
  }

  if (state.armed !== undefined && state.armed !== curr.armed) {
    alerts.push(
      curr.armed
        ? { message: "LTE fallback **armed**.", color: Color.GREEN }
        : { message: "LTE fallback **disarmed** — no automatic failover until re-armed.", color: Color.YELLOW },
    );
  }

  if (
    curr.connState === "CABLE_OK" && curr.armed &&
    curr.backupOk === false && state.backupOk !== false &&
    now - (state.lastBackupAlertAt ?? 0) > BACKUP_ALERT_COOLDOWN_MS
  ) {
    alerts.push({
      message: "LTE backup looks **broken** (health ping via Spitz failed) — failover would not work right now.",
      color: Color.YELLOW,
    });
    next.lastBackupAlertAt = now;
  }

  next.connState = curr.connState;
  next.armed = curr.armed;
  next.backupOk = curr.backupOk;
  return { alerts, state: next };
}

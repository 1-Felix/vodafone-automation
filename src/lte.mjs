import { Color, Tier } from "./notify.mjs";

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

// Warn threshold for the tracked balance. Below the ~5 € top-ups actually in
// use, so a fresh top-up never reads as low on arrival, and still far enough
// above the reserve floor to leave ~2.50 € (≈ 80 MB) of runway before the
// kill switch trips.
export const BALANCE_LOW_EUR = parseFloat(process.env.BALANCE_LOW_EUR ?? "3");
export const BALANCE_ALERT_REPEAT_MS = 24 * 60 * 60_000;

// Tracked balance: last manual anchor minus metered usage since then.
// (USSD on the Spitz is impossible — EG120K is LTE-only without IMS, the
// network times out every *100# — so the SIM's data-only spend is computed
// from our own byte metering instead and re-synced manually after top-ups.)
export function computeBalance(anchor, usageEntries) {
  if (!anchor) return null;
  let bytes = 0;
  for (const e of usageEntries) if (e.ts > anchor.ts) bytes += e.bytes;
  return Math.max(0, Math.round((anchor.eur - costEur(bytes)) * 100) / 100);
}

// Reserve floor: at/below this tracked balance the monitor kills the LTE path
// (disarm + Spitz modem down) so background traffic cannot silently drain a
// top-up to zero again. Recovery is manual: top up, set balance, re-arm.
export const BALANCE_RESERVE_EUR = parseFloat(process.env.BALANCE_RESERVE_EUR ?? "0.5");
export const RESERVE_ALERT_COOLDOWN_MS = 6 * 60 * 60_000;
// Background = metered cellular bytes with no failover session carrying them.
// The SIM should cost ~nothing while the cable is healthy; anything above this
// per day is a leak (kmwan probe storms, GL cloud/timezone loops, DNS drift).
export const LEAK_ALERT_MB = parseFloat(process.env.LEAK_ALERT_MB ?? "3");

export function backgroundBytes(entries, nowIso) {
  const day = nowIso.slice(0, 10);
  let b = 0;
  for (const e of entries) if (!e.s && e.ts.slice(0, 10) === day) b += e.bytes;
  return b;
}

export function shouldAutoDisarm({ connState, armed, balanceEur }) {
  return connState === "CABLE_OK" && !!armed &&
    typeof balanceEur === "number" && balanceEur <= BALANCE_RESERVE_EUR;
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
        tier: Tier.CRITICAL,
      });
    } else if (state.connState === "LTE_ACTIVE" && curr.closedSession) {
      const s = curr.closedSession;
      const mins = Math.max(1, Math.round((Date.parse(s.endTs) - Date.parse(s.startTs)) / 60_000));
      alerts.push({
        message: `Failover ended after ${mins} min — ${fmtMb(s.bytes)} MB ≈ ${fmtEur(costEur(s.bytes))}.`,
        color: Color.GREEN,
        tier: Tier.CRITICAL,
      });
    } else if (curr.connState === "ALL_DOWN") {
      alerts.push({
        message: `**ALL DOWN** — cable is down and LTE fallback is ${curr.armed ? "unavailable" : "disarmed"}.`,
        color: Color.RED,
        tier: Tier.CRITICAL,
      });
    }
  }

  if (state.armed !== undefined && state.armed !== curr.armed) {
    alerts.push(
      curr.armed
        ? { message: "LTE fallback **armed**.", color: Color.GREEN, tier: Tier.LOG }
        : { message: "LTE fallback **disarmed** — no automatic failover until re-armed.", color: Color.YELLOW, tier: Tier.LOG },
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
      tier: Tier.WARN,
    });
    next.lastBackupAlertAt = now;
  }

  if (
    typeof curr.balanceEur === "number" && curr.balanceEur < BALANCE_LOW_EUR &&
    now - (state.lastBalanceAlertAt ?? 0) >= BALANCE_ALERT_REPEAT_MS
  ) {
    alerts.push({
      message: `CallYa balance low: **${fmtEur(curr.balanceEur)}** — top up soon, the LTE fallback dies with the credit.`,
      color: Color.YELLOW,
      tier: Tier.WARN,
    });
    next.lastBalanceAlertAt = now;
  }

  const today = new Date(now).toISOString().slice(0, 10);
  const bgMb = (curr.bgBytes ?? 0) / 1e6;
  if (bgMb >= LEAK_ALERT_MB * 5 && state.lastLeakCritDay !== today) {
    alerts.push({
      message: `Background LTE **leak**: ${fmtMb(curr.bgBytes)} MB today (≈ ${fmtEur(costEur(curr.bgBytes))}) with the cable healthy — something is burning credit over the SIM. ${DASHBOARD_URL}`,
      color: Color.RED,
      tier: Tier.CRITICAL,
    });
    next.lastLeakCritDay = today;
    next.lastLeakWarnDay = today;
  } else if (bgMb >= LEAK_ALERT_MB && state.lastLeakWarnDay !== today) {
    alerts.push({
      message: `Background LTE usage today: **${fmtMb(curr.bgBytes)} MB** (≈ ${fmtEur(costEur(curr.bgBytes))}) with the cable healthy — the SIM should be near-silent. ${DASHBOARD_URL}`,
      color: Color.YELLOW,
      tier: Tier.WARN,
    });
    next.lastLeakWarnDay = today;
  }

  if (
    curr.connState === "LTE_ACTIVE" &&
    typeof curr.balanceEur === "number" && curr.balanceEur <= BALANCE_RESERVE_EUR &&
    now - (state.lastReserveAlertAt ?? 0) >= RESERVE_ALERT_COOLDOWN_MS
  ) {
    alerts.push({
      message: `CallYa balance at the reserve floor (**${fmtEur(curr.balanceEur)}**) while failover is ACTIVE — the connection dies when the credit hits 0. Top up now.`,
      color: Color.RED,
      tier: Tier.CRITICAL,
    });
    next.lastReserveAlertAt = now;
  }

  if (curr.guardState && curr.guardState !== state.guardState &&
      (state.guardState !== undefined || curr.guardState === "missing")) {
    if (curr.guardState === "open") {
      alerts.push({
        message: `LTE guard **opened** — ALL devices may use LTE${curr.guardOpenUntil ? ` until ${curr.guardOpenUntil.slice(11, 16)} UTC` : ""}.`,
        color: Color.YELLOW,
        tier: Tier.LOG,
      });
    } else if (curr.guardState === "locked") {
      alerts.push({
        message: "LTE guard **locked** — only allowlisted devices (NUC, Felix-PC) may use LTE.",
        color: Color.GREEN,
        tier: Tier.LOG,
      });
    } else if (curr.guardState === "missing") {
      alerts.push({
        message: "LTE guard chain **missing** on the Flint — LTE is unrestricted for all devices. Reinstall /etc/firewall.lte_guard.",
        color: Color.RED,
        tier: Tier.CRITICAL,
      });
    }
  }
  if (curr.guardState) next.guardState = curr.guardState;

  next.connState = curr.connState;
  next.armed = curr.armed;
  next.backupOk = curr.backupOk;
  return { alerts, state: next };
}

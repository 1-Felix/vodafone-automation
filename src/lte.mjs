export const RATE_PER_MB = parseFloat(process.env.LTE_COST_PER_MB ?? "0.03");
export const FAST_SAMPLE_MS = 60_000;
export const SLOW_SAMPLE_MS = 600_000;
export const RUNNING_UPDATE_MS = 30 * 60_000;
export const BACKUP_ALERT_COOLDOWN_MS = 6 * 60 * 60_000;

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

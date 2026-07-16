import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.mjs";
import { notify, Color } from "./notify.mjs";
import { checkDeviceMode, getDocsisStatus, getEventLog, login, logout } from "./station.mjs";

const DATA_DIR = process.env.DATA_DIR ?? "./data";
// Vodafone treats sustained upstream TX power above ~51 dBmV as critical
export const US_POWER_WARN_DBMV = parseFloat(process.env.US_POWER_WARN_DBMV ?? "51");
export const US_POWER_CLEAR_DBMV = US_POWER_WARN_DBMV - 2;
export const T3_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // at most one T3 alert per hour

const LEVELS_FILE = join(DATA_DIR, "levels.jsonl");
const EVENTS_FILE = join(DATA_DIR, "events.jsonl");

export function parseDbmv(str) {
  const n = parseFloat(str);
  return Number.isFinite(n) ? n : null;
}

export function summarizeDocsis(data) {
  const ds = (data.downstream ?? []).map((c) => ({
    ch: c.channelid,
    type: c.ChannelType,
    freq: c.CentralFrequency,
    power: parseDbmv(c.power),
    snr: parseDbmv(c.SNR),
    locked: c.locked,
  }));
  const ofdmDs = (data.ofdm_downstream ?? []).map((c) => ({
    ch: c.channelid_ofdm,
    type: c.ChannelType,
    freq: c.CentralFrequency_ofdm,
    power: parseDbmv(c.power_ofdm),
    snr: parseDbmv(c.SNR_ofdm),
    locked: c.locked_ofdm,
  }));
  const us = [...(data.upstream ?? []), ...(data.ofdma_upstream ?? [])].map((c) => ({
    ch: c.channelidup,
    type: c.ChannelType,
    freq: c.CentralFrequency,
    power: parseDbmv(c.power),
    mod: c.FFT,
    ranging: c.RangingStatus,
  }));

  const usPowers = us.map((c) => c.power).filter((p) => p !== null);
  const dsSnrs = [...ds, ...ofdmDs].map((c) => c.snr).filter((s) => s !== null);

  return {
    operational: data.operational,
    usMaxPower: usPowers.length ? Math.max(...usPowers) : null,
    dsMinSnr: dsSnrs.length ? Math.min(...dsSnrs) : null,
    us,
    ds,
    ofdmDs,
  };
}

export function eventKey(table, e) {
  return `${table}|${(e.Time ?? "").trim()}|${e.ID ?? ""}|${e.Message ?? ""}`;
}

export function isRangingFailure(e) {
  // Real messages vary: "T3 time-out", "T4 time out"
  return /T[34] time[- ]?out/i.test(e.Message ?? "");
}

/**
 * Edge-triggered alerting. Takes the previous alert state, the current
 * snapshot and the new (unseen) docsis events; returns alerts to send and the
 * next state. Pure function so it can be unit tested.
 */
export function deriveAlerts(state, snapshot, newDocsisEvents, now) {
  const alerts = [];
  const next = { ...state };

  if (state.firmware && snapshot.firmware && state.firmware !== snapshot.firmware) {
    alerts.push({
      message: `Station firmware changed: \`${state.firmware}\` → \`${snapshot.firmware}\`. Watch for setting resets (bridge mode!).`,
      color: Color.YELLOW,
    });
  }
  next.firmware = snapshot.firmware ?? state.firmware;

  const online = snapshot.operational === "Docsis_Online";
  if (state.online === true && !online) {
    alerts.push({
      message: `DOCSIS no longer online: **${snapshot.operational}**`,
      color: Color.RED,
    });
  } else if (state.online === false && online) {
    alerts.push({ message: "DOCSIS back online.", color: Color.GREEN });
  }
  next.online = online;

  if (snapshot.usMaxPower !== null) {
    if (!state.usPowerHigh && snapshot.usMaxPower > US_POWER_WARN_DBMV) {
      alerts.push({
        message: `Upstream TX power critical: **${snapshot.usMaxPower} dBmV** (healthy ≤ 47, critical > ${US_POWER_WARN_DBMV}). Signal path is degraded.`,
        color: Color.YELLOW,
      });
      next.usPowerHigh = true;
    } else if (state.usPowerHigh && snapshot.usMaxPower <= US_POWER_CLEAR_DBMV) {
      alerts.push({
        message: `Upstream TX power recovered: ${snapshot.usMaxPower} dBmV.`,
        color: Color.GREEN,
      });
      next.usPowerHigh = false;
    }
  }

  const t3Count = newDocsisEvents.filter(isRangingFailure).length;
  if (t3Count > 0 && now - (state.lastT3AlertAt ?? 0) > T3_ALERT_COOLDOWN_MS) {
    alerts.push({
      message: `${t3Count} new T3/T4 ranging time-out(s) in the Station event log — upstream is failing intermittently.`,
      color: Color.YELLOW,
    });
    next.lastT3AlertAt = now;
  }

  return { alerts, state: next };
}

// --- stateful part below ---

let alertState = {};
let seenEventKeys = null;

function loadSeenEvents() {
  const seen = new Set();
  try {
    for (const line of readFileSync(EVENTS_FILE, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        seen.add(e.key);
      } catch {
        // skip corrupt line
      }
    }
  } catch {
    // file doesn't exist yet
  }
  return seen;
}

export async function collectOnce() {
  mkdirSync(DATA_DIR, { recursive: true });
  seenEventKeys ??= loadSeenEvents();

  const { deviceMode, firmware } = await checkDeviceMode();

  const sessionCookie = await login();
  let docsisData, eventData;
  try {
    docsisData = await getDocsisStatus(sessionCookie);
    eventData = await getEventLog(sessionCookie);
  } finally {
    try {
      await logout(sessionCookie);
    } catch {
      // best effort
    }
  }

  const ts = new Date().toISOString();
  const summary = summarizeDocsis(docsisData);
  const snapshot = { ts, deviceMode, firmware, ...summary };
  appendFileSync(LEVELS_FILE, JSON.stringify(snapshot) + "\n");

  const newDocsisEvents = [];
  for (const [table, entries] of Object.entries(eventData)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      // Skip the noise our own polling generates (login/logout every cycle)
      if (/Account .* logged (in|out)/.test(e.Message ?? "")) continue;
      const key = eventKey(table, e);
      if (seenEventKeys.has(key)) continue;
      seenEventKeys.add(key);
      appendFileSync(
        EVENTS_FILE,
        JSON.stringify({
          key,
          seenAt: ts,
          table,
          time: (e.Time ?? "").trim(),
          id: e.ID ?? "",
          level: e.Level ?? "",
          message: e.Message ?? "",
        }) + "\n",
      );
      if (table === "docsisTbl") newDocsisEvents.push(e);
    }
  }

  const { alerts, state } = deriveAlerts(alertState, snapshot, newDocsisEvents, Date.now());
  alertState = state;

  log(
    `Collected: us max ${summary.usMaxPower} dBmV, ds min SNR ${summary.dsMinSnr} dB, ` +
      `${newDocsisEvents.length} new docsis event(s), ${summary.operational}`,
  );

  for (const a of alerts) {
    await notify(a.message, a.color);
  }
}

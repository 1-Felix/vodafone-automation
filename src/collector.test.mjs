import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDbmv,
  summarizeDocsis,
  eventKey,
  isRangingFailure,
  deriveAlerts,
  US_POWER_WARN_DBMV,
  T3_ALERT_COOLDOWN_MS,
} from "./collector.mjs";

test("parseDbmv extracts numbers and rejects garbage", () => {
  assert.equal(parseDbmv("55.0 dBmV"), 55);
  assert.equal(parseDbmv("-5.3 dBmV"), -5.3);
  assert.equal(parseDbmv("N/A"), null);
  assert.equal(parseDbmv(undefined), null);
});

test("summarizeDocsis computes max upstream power and min downstream SNR", () => {
  const summary = summarizeDocsis({
    operational: "Docsis_Online",
    downstream: [
      { channelid: "1", ChannelType: "SC-QAM", CentralFrequency: "114 MHz", power: "-5.3 dBmV", SNR: "36.5 dB", locked: "Locked" },
    ],
    ofdm_downstream: [
      { channelid_ofdm: "193", ChannelType: "OFDM", CentralFrequency_ofdm: "264.0 MHz", power_ofdm: "1.5 dBmV", SNR_ofdm: "39.16 dB", locked_ofdm: "Locked" },
    ],
    upstream: [
      { channelidup: "9", ChannelType: "SC-QAM", CentralFrequency: "30.8 MHz", power: "55.0 dBmV", FFT: "16-qam", RangingStatus: "Completed" },
    ],
    ofdma_upstream: [
      { channelidup: "43", ChannelType: "OFDMA", CentralFrequency: "46 MHz", power: "49.0 dBmV", FFT: "16-qam", RangingStatus: "Completed" },
    ],
  });
  assert.equal(summary.usMaxPower, 55);
  assert.equal(summary.dsMinSnr, 36.5);
  assert.equal(summary.us.length, 2);
  assert.equal(summary.operational, "Docsis_Online");
});

test("eventKey is stable and distinguishes entries", () => {
  const e1 = { Time: "Thu Jul 16 01:53:18 2026\n", ID: "82000500", Message: "T3 time-out" };
  const e2 = { Time: "Thu Jul 16 02:02:18 2026\n", ID: "82000500", Message: "T3 time-out" };
  assert.equal(eventKey("docsisTbl", e1), eventKey("docsisTbl", { ...e1 }));
  assert.notEqual(eventKey("docsisTbl", e1), eventKey("docsisTbl", e2));
});

test("isRangingFailure matches T3 and T4 timeouts", () => {
  assert.ok(isRangingFailure({ Message: "Started Unicast Maintenance Ranging - No Response received - T3 time-out;" }));
  assert.ok(isRangingFailure({ Message: "Received Response to Broadcast Maintenance Request, But no Unicast Maintenance opportunities received - T4 time out;" }));
  assert.ok(!isRangingFailure({ Message: "US profile assignment change. US Chan ID: 43;" }));
});

const okSnapshot = { firmware: "5.0.2MB-R18-RT", operational: "Docsis_Online", usMaxPower: 45 };

test("upstream power alert is edge-triggered with hysteresis", () => {
  const high = { ...okSnapshot, usMaxPower: US_POWER_WARN_DBMV + 4 };

  let r = deriveAlerts({}, high, [], 0);
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0].message, /Upstream TX power critical/);

  // same condition again -> no repeat alert
  r = deriveAlerts(r.state, high, [], 0);
  assert.equal(r.alerts.length, 0);

  // just below warn but above clear threshold -> still silent
  r = deriveAlerts(r.state, { ...okSnapshot, usMaxPower: US_POWER_WARN_DBMV - 1 }, [], 0);
  assert.equal(r.alerts.length, 0);

  // below clear threshold -> recovery alert
  r = deriveAlerts(r.state, { ...okSnapshot, usMaxPower: US_POWER_WARN_DBMV - 3 }, [], 0);
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0].message, /recovered/);
});

test("firmware change alerts once", () => {
  let r = deriveAlerts({}, okSnapshot, [], 0); // first observation: no alert
  assert.equal(r.alerts.length, 0);

  r = deriveAlerts(r.state, { ...okSnapshot, firmware: "5.0.3XY" }, [], 0);
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0].message, /firmware changed/);

  r = deriveAlerts(r.state, { ...okSnapshot, firmware: "5.0.3XY" }, [], 0);
  assert.equal(r.alerts.length, 0);
});

test("offline and recovery transitions alert once each", () => {
  let r = deriveAlerts({}, okSnapshot, [], 0);
  r = deriveAlerts(r.state, { ...okSnapshot, operational: "Docsis_Scanning" }, [], 0);
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0].message, /no longer online/);

  r = deriveAlerts(r.state, { ...okSnapshot, operational: "Docsis_Scanning" }, [], 0);
  assert.equal(r.alerts.length, 0);

  r = deriveAlerts(r.state, okSnapshot, [], 0);
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0].message, /back online/);
});

test("T3 alerts are rate-limited to one per cooldown window", () => {
  const t3 = [{ Message: "No Ranging Response received - T3 time-out;" }];
  const t0 = 1_700_000_000_000; // realistic epoch ms, as in production

  let r = deriveAlerts({}, okSnapshot, t3, t0);
  assert.equal(r.alerts.filter((a) => /time-out/.test(a.message)).length, 1);

  // more T3s five minutes later -> suppressed
  r = deriveAlerts(r.state, okSnapshot, t3, t0 + 5 * 60 * 1000);
  assert.equal(r.alerts.length, 0);

  // after the cooldown -> alerts again
  r = deriveAlerts(r.state, okSnapshot, t3, t0 + T3_ALERT_COOLDOWN_MS + 1);
  assert.equal(r.alerts.length, 1);
});

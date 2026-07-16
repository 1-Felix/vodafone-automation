// One-shot DOCSIS signal snapshot, meant for comparing wall sockets:
// plug the Station into a socket, wait until it's online, run `pnpm levels`.
import { login, logout, getDocsisStatus } from "./station.mjs";
import { summarizeDocsis, US_POWER_WARN_DBMV } from "./collector.mjs";

const sessionCookie = await login();
let data;
try {
  data = await getDocsisStatus(sessionCookie);
} finally {
  try {
    await logout(sessionCookie);
  } catch {
    // best effort
  }
}

const s = summarizeDocsis(data);

console.log(`\nDOCSIS status: ${s.operational}\n`);

console.log("Upstream (the critical direction):");
for (const c of s.us) {
  const flag = c.power > US_POWER_WARN_DBMV ? "  <-- CRITICAL" : c.power > 47 ? "  <-- high" : "";
  console.log(
    `  ch ${String(c.ch).padStart(3)}  ${c.type.padEnd(6)} ${c.freq.padStart(12)}  ` +
      `${String(c.power).padStart(5)} dBmV  ${c.mod}  ranging=${c.ranging}${flag}`,
  );
}

const dsAll = [...s.ds, ...s.ofdmDs];
const dsPowers = dsAll.map((c) => c.power).filter((p) => p !== null);
const dsSnrs = dsAll.map((c) => c.snr).filter((v) => v !== null);
console.log(`\nDownstream: ${dsAll.length} channels locked=${dsAll.every((c) => /Locked/i.test(c.locked ?? ""))}`);
console.log(`  power ${Math.min(...dsPowers)} .. ${Math.max(...dsPowers)} dBmV (ideal -7..+7)`);
console.log(`  SNR   ${Math.min(...dsSnrs)} .. ${Math.max(...dsSnrs)} dB (good > 33)`);

console.log(`\nUpstream max TX power: ${s.usMaxPower} dBmV`);
if (s.usMaxPower > US_POWER_WARN_DBMV) {
  console.log(`Verdict: CRITICAL — modem is at/near max transmit power (healthy <= 47, critical > ${US_POWER_WARN_DBMV}).`);
} else if (s.usMaxPower > 47) {
  console.log("Verdict: elevated — works, but little headroom.");
} else {
  console.log("Verdict: OK.");
}

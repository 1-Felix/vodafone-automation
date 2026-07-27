import { execFile } from "node:child_process";

const HOST = process.env.FLINT_SSH_HOST ?? "192.168.0.1";
const USER = process.env.FLINT_SSH_USER ?? "root";
const KEY = process.env.FLINT_SSH_KEY ?? "/app/ssh/id_ed25519";
const KNOWN_HOSTS = process.env.FLINT_KNOWN_HOSTS ?? "/app/ssh/known_hosts";
const LTE_IFACE = process.env.LTE_IFACE ?? "secondwan";
const LTE_DEVICE = process.env.LTE_DEVICE ?? "lan5";
const DRILL_URL = process.env.DRILL_URL ?? "https://speed.cloudflare.com/__down?bytes=2000000";

export function parseIfaceStatus(jsonStr) {
  const j = JSON.parse(jsonStr);
  return { up: !!j.up, autostart: !!j.autostart, device: j.l3_device ?? j.device ?? null };
}

export function parseCountersTotal(out) {
  const [rx, tx] = out.trim().split("\n").map((l) => parseInt(l, 10));
  if (!Number.isFinite(rx) || !Number.isFinite(tx)) return null;
  return rx + tx;
}

export function flintSsh(command) {
  const args = [
    "-i", KEY,
    "-o", `UserKnownHostsFile=${KNOWN_HOSTS}`,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    `${USER}@${HOST}`,
    command,
  ];
  return new Promise((resolve, reject) => {
    execFile("ssh", args, { timeout: 150_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`ssh ${command}: ${stderr || err.message}`.trim()));
      else resolve(stdout);
    });
  });
}

export async function getIfaceStatus(iface) {
  return parseIfaceStatus(await flintSsh(`ubus call network.interface.${iface} status`));
}

export async function readCountersTotal() {
  const out = await flintSsh(
    `cat /sys/class/net/${LTE_DEVICE}/statistics/rx_bytes /sys/class/net/${LTE_DEVICE}/statistics/tx_bytes 2>/dev/null || echo ERR`,
  );
  return parseCountersTotal(out);
}

export async function setLteArmed(up) {
  await flintSsh(`${up ? "ifup" : "ifdown"} ${LTE_IFACE}`);
}

export async function healthPing() {
  const out = await flintSsh(`ping -I ${LTE_DEVICE} -c 1 -W 5 1.1.1.1 >/dev/null 2>&1 && echo OK || echo FAIL`);
  return out.includes("OK");
}

export async function runDrill() {
  const out = await flintSsh(
    `curl --interface ${LTE_DEVICE} -s -o /dev/null --max-time 120 -w '%{size_download} %{time_total}' '${DRILL_URL}' || echo '0 0'`,
  );
  const [bytes, seconds] = out.trim().split(/\s+/).map(Number);
  return { ok: bytes > 1_000_000, bytes: bytes || 0, seconds: seconds || 0 };
}

const GUARD_SCRIPT = process.env.GUARD_SCRIPT ?? "/etc/firewall.lte_guard";

export function parseGuardState(out) {
  if (!out || !out.includes("-N lte_guard")) return "missing";
  if (!out.includes("HOOKED")) return "missing";
  if (/-A lte_guard -j ACCEPT\b/.test(out)) return "open";
  if (/-A lte_guard .*-j REJECT/.test(out)) return "locked";
  return "missing"; // chain exists but is empty/partial — not guarding
}

export async function getGuardState() {
  const out = await flintSsh(
    "iptables -S lte_guard 2>/dev/null; iptables -S forwarding_rule 2>/dev/null | grep -q lte_guard && echo HOOKED",
  );
  return parseGuardState(out);
}

export async function openGuard() {
  await flintSsh("iptables -I lte_guard 1 -j ACCEPT");
}

export async function relockGuard() {
  await flintSsh(`sh ${GUARD_SCRIPT}`);
}

import { execFile } from "node:child_process";

// The Spitz (GL-X2000) is the LTE modem itself. Metering has to read ITS
// cellular counters: the Flint's lan5 counts every byte on the Flint↔Spitz
// LAN segment (kmwan tracking pings, management SSH, ARP), which is traffic
// that never touches the cellular link and must not be billed against the SIM.
const HOST = process.env.SPITZ_SSH_HOST ?? "192.168.8.1";
const USER = process.env.SPITZ_SSH_USER ?? "root";
const KEY = process.env.SPITZ_SSH_KEY ?? process.env.FLINT_SSH_KEY ?? "/app/ssh/id_ed25519";
const KNOWN_HOSTS = process.env.SPITZ_KNOWN_HOSTS ?? process.env.FLINT_KNOWN_HOSTS ?? "/app/ssh/known_hosts";
const MODEM_IFACE = process.env.SPITZ_MODEM_IFACE ?? "modem_2_1";
const CELL_DEVICE = process.env.SPITZ_CELL_DEVICE ?? "wwan0_1";

export function parseCountersTotal(out) {
  const [rx, tx] = out.trim().split("\n").map((l) => parseInt(l, 10));
  if (!Number.isFinite(rx) || !Number.isFinite(tx)) return null;
  return rx + tx;
}

export function spitzSsh(command) {
  const args = [
    "-i", KEY,
    "-o", `UserKnownHostsFile=${KNOWN_HOSTS}`,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    `${USER}@${HOST}`,
    command,
  ];
  return new Promise((resolve, reject) => {
    execFile("ssh", args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`ssh ${command}: ${stderr || err.message}`.trim()));
      else resolve(stdout);
    });
  });
}

/**
 * Cellular rx+tx bytes, read from the modem's own l3 device.
 *
 * The device name is resolved from the modem interface rather than hardcoded,
 * because GL's qcm proto recreates it (and its counters) whenever the PDP
 * context is re-established. deltaBytes() already treats a counter going
 * backwards as a reset, so a recreated device is accounted for correctly.
 *
 * Returns null — never throws — when the Spitz is unreachable: a dead Spitz is
 * exactly the failure this monitor exists to report, so it must not take the
 * whole tick down with it.
 */
// Balance-floor kill switch: taking the modem interface down detaches the PDP
// context, so the Spitz's own housekeeping cannot bill the SIM either. ifup
// from the dashboard's re-arm restores it.
export async function setModemUp(up) {
  await spitzSsh(`${up ? "ifup" : "ifdown"} ${MODEM_IFACE}`);
}

export async function readCellularCounters() {
  try {
    const out = await spitzSsh(
      `D=$(ubus call network.interface.${MODEM_IFACE} status 2>/dev/null ` +
      `| grep -o '"l3_device": "[^"]*"' | cut -d'"' -f4); ` +
      `[ -n "$D" ] || D=${CELL_DEVICE}; ` +
      `cat /sys/class/net/$D/statistics/rx_bytes /sys/class/net/$D/statistics/tx_bytes 2>/dev/null || echo ERR`,
    );
    return parseCountersTotal(out);
  } catch {
    return null;
  }
}

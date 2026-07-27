import { execFile } from "node:child_process";

const HOST = process.env.SPITZ_SSH_HOST ?? "192.168.8.1";
const USER = process.env.SPITZ_SSH_USER ?? "root";
const KEY = process.env.FLINT_SSH_KEY ?? "/app/ssh/id_ed25519";
const KNOWN_HOSTS = process.env.FLINT_KNOWN_HOSTS ?? "/app/ssh/known_hosts";
const USSD_CMD = process.env.SPITZ_USSD_CMD ?? `gl_modem AT 'AT+CUSD=1,"*100#",15'`;

function decodeUcs2Hex(s) {
  const chars = [];
  for (let i = 0; i + 4 <= s.length; i += 4) chars.push(parseInt(s.slice(i, i + 4), 16));
  return String.fromCharCode(...chars);
}

export function parseUssdBalance(raw) {
  if (!raw || typeof raw !== "string") return null;
  const quoted = raw.match(/"([^"]*)"/);
  let text = (quoted?.[1] ?? raw).trim();
  if (/^[0-9A-Fa-f]{8,}$/.test(text) && text.length % 4 === 0) text = decodeUcs2Hex(text);
  const m = text.match(/(\d+)[.,](\d{2})\s*(?:EUR|€)/i);
  if (m) return { eur: parseInt(m[1], 10) + parseInt(m[2], 10) / 100, text };
  if (quoted && text) return { eur: null, text };
  return null;
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
    execFile("ssh", args, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`spitz ssh ${command}: ${stderr || err.message}`.trim()));
      else resolve(stdout);
    });
  });
}

export async function queryBalance() {
  return parseUssdBalance(await spitzSsh(USSD_CMD));
}

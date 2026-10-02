import { log } from "./log.mjs";

export const Color = {
  RED: 0xff0000,
  GREEN: 0x00ff00,
  YELLOW: 0xffaa00,
};

export const Tier = {
  CRITICAL: "critical",
  WARN: "warn",
  LOG: "log",
};

const TIER_ENV = {
  [Tier.CRITICAL]: "DISCORD_WEBHOOK_CRITICAL",
  [Tier.WARN]: "DISCORD_WEBHOOK_WARN",
  [Tier.LOG]: "DISCORD_WEBHOOK_LOG",
};

/**
 * Webhook for a tier: its own channel, else the shared fallback, else nothing.
 * Read from process.env on every call rather than captured at import time —
 * import-time capture made webhook config untestable, and there are four vars now.
 * Empty strings count as unset so a blank line in .env falls through.
 */
export function resolveWebhook(tier) {
  const specific = process.env[TIER_ENV[tier] ?? ""];
  if (specific) return specific;
  return process.env.DISCORD_WEBHOOK_URL || null;
}

// Second way out for when the NUC cannot reach Discord itself: the LTE guard
// keeps the NUC off the SIM, so during a failover alerts leave via the Flint.
let relay = null;

export function setRelay(fn) {
  relay = fn;
}

const DIRECT_TIMEOUT_MS = 10_000;

export async function notify(message, color = Color.RED, tier = Tier.WARN) {
  log(`[Discord:${tier}] ${message}`);

  const url = resolveWebhook(tier);
  if (!url) return;

  const body = JSON.stringify({
    embeds: [
      {
        title: "Vodafone Bridge Monitor",
        description: message,
        color,
        timestamp: new Date().toISOString(),
      },
    ],
  });

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
    });
    return;
  } catch {
    // No route, no DNS or no answer: expected when the network is disrupted,
    // which is exactly when we alert most.
  }

  if (!relay) return;
  try {
    await relay(url, body);
    log(`[Discord:${tier}] relayed via the Flint`);
  } catch (err) {
    log(`Discord relay via the Flint failed: ${err.message}`);
  }
}

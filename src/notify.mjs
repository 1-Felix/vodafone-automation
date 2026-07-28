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

export async function notify(message, color = Color.RED, tier = Tier.WARN) {
  log(`[Discord:${tier}] ${message}`);

  const url = resolveWebhook(tier);
  if (!url) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: "Vodafone Bridge Monitor",
            description: message,
            color,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
  } catch {
    // Silently ignore — webhook failures are expected when the network is
    // disrupted (which is exactly when bridge mode gets lost).
  }
}

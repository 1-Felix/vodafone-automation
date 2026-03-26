import { log } from "./log.mjs";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

export async function notify(message, color = 0xff0000) {
  log(`[Discord] ${message}`);

  if (!DISCORD_WEBHOOK_URL) return;

  try {
    await fetch(DISCORD_WEBHOOK_URL, {
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
  } catch (err) {
    log(`Discord webhook failed: ${err.message}`);
  }
}

export const Color = {
  RED: 0xff0000,
  GREEN: 0x00ff00,
  YELLOW: 0xffaa00,
};

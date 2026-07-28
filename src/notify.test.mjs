import test from "node:test";
import assert from "node:assert/strict";
import { notify, resolveWebhook, Color, Tier } from "./notify.mjs";

const ENV_KEYS = [
  "DISCORD_WEBHOOK_URL",
  "DISCORD_WEBHOOK_CRITICAL",
  "DISCORD_WEBHOOK_WARN",
  "DISCORD_WEBHOOK_LOG",
];

// Clears all four vars, applies `vars`, runs `fn`, then restores. Must await
// fn before restoring or the finally block would run mid-request.
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function captureFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("each tier posts to its own webhook", async () => {
  const f = captureFetch();
  try {
    await withEnv({
      DISCORD_WEBHOOK_CRITICAL: "https://d/crit",
      DISCORD_WEBHOOK_WARN: "https://d/warn",
      DISCORD_WEBHOOK_LOG: "https://d/log",
    }, async () => {
      await notify("a", Color.RED, Tier.CRITICAL);
      await notify("b", Color.YELLOW, Tier.WARN);
      await notify("c", Color.GREEN, Tier.LOG);
    });
  } finally {
    f.restore();
  }
  assert.deepEqual(f.calls.map((c) => c.url), ["https://d/crit", "https://d/warn", "https://d/log"]);
});

test("a tier with no webhook of its own falls back to DISCORD_WEBHOOK_URL", async () => {
  const f = captureFetch();
  try {
    await withEnv({
      DISCORD_WEBHOOK_URL: "https://d/all",
      DISCORD_WEBHOOK_CRITICAL: "https://d/crit",
    }, async () => {
      await notify("a", Color.RED, Tier.CRITICAL);
      await notify("b", Color.GREEN, Tier.LOG);
    });
  } finally {
    f.restore();
  }
  assert.deepEqual(f.calls.map((c) => c.url), ["https://d/crit", "https://d/all"]);
});

test("legacy single-webhook config routes every tier to DISCORD_WEBHOOK_URL", async () => {
  const f = captureFetch();
  try {
    await withEnv({ DISCORD_WEBHOOK_URL: "https://d/all" }, async () => {
      await notify("a", Color.RED, Tier.CRITICAL);
      await notify("b", Color.YELLOW, Tier.WARN);
      await notify("c", Color.GREEN, Tier.LOG);
    });
  } finally {
    f.restore();
  }
  assert.deepEqual(f.calls.map((c) => c.url), ["https://d/all", "https://d/all", "https://d/all"]);
});

test("no webhook configured sends nothing and does not throw", async () => {
  const f = captureFetch();
  try {
    await withEnv({}, async () => {
      await notify("a", Color.RED, Tier.CRITICAL);
    });
  } finally {
    f.restore();
  }
  assert.equal(f.calls.length, 0);
});

test("empty-string webhook counts as unset", async () => {
  await withEnv({ DISCORD_WEBHOOK_LOG: "", DISCORD_WEBHOOK_URL: "https://d/all" }, async () => {
    assert.equal(resolveWebhook(Tier.LOG), "https://d/all");
  });
  await withEnv({ DISCORD_WEBHOOK_URL: "" }, async () => {
    assert.equal(resolveWebhook(Tier.WARN), null);
  });
});

test("tier defaults to warn when omitted", async () => {
  await withEnv({
    DISCORD_WEBHOOK_WARN: "https://d/warn",
    DISCORD_WEBHOOK_CRITICAL: "https://d/crit",
  }, async () => {
    const f = captureFetch();
    try {
      await notify("no tier given", Color.YELLOW);
    } finally {
      f.restore();
    }
    assert.equal(f.calls[0].url, "https://d/warn");
  });
});

test("embed carries the message and colour", async () => {
  const f = captureFetch();
  try {
    await withEnv({ DISCORD_WEBHOOK_URL: "https://d/all" }, async () => {
      await notify("hello **world**", Color.GREEN, Tier.LOG);
    });
  } finally {
    f.restore();
  }
  const body = JSON.parse(f.calls[0].opts.body);
  assert.equal(body.embeds[0].description, "hello **world**");
  assert.equal(body.embeds[0].color, Color.GREEN);
});

test("webhook failure is swallowed", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  try {
    await withEnv({ DISCORD_WEBHOOK_URL: "https://d/all" }, async () => {
      // Reaching the next line without throwing is the assertion: the webhook
      // fails exactly when the network is down, which is when we alert most.
      await notify("during an outage", Color.RED, Tier.CRITICAL);
    });
  } finally {
    globalThis.fetch = original;
  }
});

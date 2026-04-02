import { pbkdf2 } from "./auth.mjs";
import { log } from "./log.mjs";
import { notify, Color } from "./notify.mjs";

const ROUTER_IP = process.env.ROUTER_IP ?? "192.168.100.1";
const ROUTER_USER = process.env.ROUTER_USER ?? "admin";
const ROUTER_PASS = process.env.ROUTER_PASS;
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS ?? "300000"); // 5 min
const LOGIN_RETRIES = 3;
const LOGIN_RETRY_DELAY_MS = 30_000; // 30s between retries
const BASE = `http://${ROUTER_IP}`;

async function api(path, opts = {}) {
  const url = `${BASE}/api/v1/${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${BASE}/`,
      ...opts.headers,
    },
    redirect: "manual",
  });
  return res;
}

function extractSession(res) {
  const setCookie = res.headers.get("set-cookie");
  const match = setCookie?.match(/PHPSESSID=([^;]+)/);
  return match ? `PHPSESSID=${match[1]}; cwd=No` : null;
}

async function checkDeviceMode() {
  const res = await api("login_conf");
  const json = await res.json();
  return {
    deviceMode: json.data?.DeviceMode?.toLowerCase(),
    lanMode: json.data?.LanMode,
  };
}

async function login() {
  // Step 1: Request salt (send "seeksalthash" as password to trigger salt exchange)
  const saltRes = await api("session/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: ROUTER_USER,
      password: "seeksalthash",
      logout: "true",
    }),
  });

  let sessionCookie = extractSession(saltRes);
  const saltJson = await saltRes.json();

  if (saltJson.error !== "ok") {
    throw new Error(`Salt request failed: ${saltJson.message}`);
  }

  const { salt, saltwebui } = saltJson;

  // Step 2: Compute PBKDF2 double-hash and authenticate
  let password;
  if (salt === "none") {
    password = ROUTER_PASS;
  } else {
    const hashed1 = pbkdf2(ROUTER_PASS, salt);
    password = pbkdf2(hashed1, saltwebui);
  }

  const loginRes = await api("session/login", {
    method: "POST",
    headers: {
      Cookie: sessionCookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ username: ROUTER_USER, password }),
  });

  sessionCookie = extractSession(loginRes) ?? sessionCookie;
  const loginJson = await loginRes.json();

  if (loginJson.error !== "ok") {
    throw new Error(`Login failed: ${loginJson.message}`);
  }

  log("Login successful");

  // Step 3: Initialize session by calling menu (required for server-side session setup)
  await api("session/menu", { headers: { Cookie: sessionCookie } });

  return sessionCookie;
}

async function getCSRFToken(sessionCookie) {
  const res = await api("session/init_page", {
    headers: { Cookie: sessionCookie },
  });
  const json = await res.json();
  return json.token;
}

async function logout(sessionCookie) {
  await api("session/logout", {
    method: "POST",
    headers: {
      Cookie: sessionCookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({}),
  });
}

async function setBridgeMode(sessionCookie) {
  // Get CSRF token via init_page
  const csrfToken = await getCSRFToken(sessionCookie);
  if (!csrfToken) {
    throw new Error("Failed to obtain CSRF token");
  }

  // GET current modem mode and verify the endpoint is accessible
  const modeRes = await api("set_modem_mode", {
    headers: { Cookie: sessionCookie },
  });
  const modeJson = await modeRes.json();

  if (modeJson.error === "error") {
    throw new Error(`Cannot access modem mode settings: ${modeJson.message}`);
  }

  const currentMode = modeJson.data?.LanMode;
  log(`Current LanMode: ${currentMode}`);

  if (currentMode === "bridge-static") {
    log("Already in bridge-static mode, no action needed");
    return false;
  }

  // Use fresh CSRF token from the GET response if available, otherwise use init_page token
  const token = modeJson.token ?? csrfToken;

  // POST to switch to bridge mode
  const setRes = await api("set_modem_mode", {
    method: "POST",
    headers: {
      Cookie: sessionCookie,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRF-TOKEN": token,
    },
    body: new URLSearchParams({ LanMode: "bridge-static" }),
  });

  // Router may not respond cleanly as it starts rebooting
  try {
    const setJson = await setRes.json();
    if (setJson.error === "ok") {
      log("Bridge mode activated! Router is rebooting...");
      return true;
    }
    log(`Unexpected response: ${JSON.stringify(setJson)}`);
  } catch {
    log("Bridge mode command sent, router appears to be rebooting...");
    return true;
  }

  return false;
}

async function runCheck() {
  try {
    const { deviceMode, lanMode } = await checkDeviceMode();
    log(`DeviceMode: ${deviceMode}, LanMode: ${lanMode}`);

    if (deviceMode === "bridge" || lanMode === "bridge-static") {
      return;
    }

    log(`Router is in "${deviceMode}" mode — switching to bridge mode...`);
    await notify(
      `Bridge mode lost! Router is in **${deviceMode}** mode. Attempting to re-enable bridge mode...`,
      Color.RED,
    );

    let sessionCookie;
    for (let attempt = 1; attempt <= LOGIN_RETRIES; attempt++) {
      try {
        sessionCookie = await login();
        break;
      } catch (err) {
        log(`Login attempt ${attempt}/${LOGIN_RETRIES} failed: ${err.message}`);
        if (attempt === LOGIN_RETRIES) throw err;
        log(`Retrying in ${LOGIN_RETRY_DELAY_MS / 1000}s...`);
        await new Promise((r) => setTimeout(r, LOGIN_RETRY_DELAY_MS));
      }
    }

    try {
      const switched = await setBridgeMode(sessionCookie);

      if (switched) {
        log("Waiting for router to reboot (~9 minutes)...");
        await new Promise((r) => setTimeout(r, 600_000));

        try {
          const { deviceMode: newMode } = await checkDeviceMode();
          if (newMode === "bridge") {
            log("Verified: Bridge mode is now active!");
            await notify("Bridge mode successfully re-enabled!", Color.GREEN);
          } else {
            log(`Warning: After reboot, mode is "${newMode}" — may need manual check`);
            await notify(
              `Failed to restore bridge mode. Router is in **${newMode}** mode after reboot. Manual intervention may be needed.`,
              Color.YELLOW,
            );
          }
        } catch {
          log("Could not verify mode after reboot (router may still be starting)");
        }
      }
    } finally {
      try {
        await logout(sessionCookie);
      } catch {
        // Session likely already expired from reboot
      }
    }
  } catch (err) {
    log(`Error: ${err.message}`);
    await notify(`Error during check: ${err.message}`, Color.YELLOW);
  }
}

// Main
const once = process.argv.includes("--once");

log("Vodafone Bridge Mode Monitor started");
log(`Router: ${BASE}, User: ${ROUTER_USER}`);
log(`Check interval: ${CHECK_INTERVAL_MS / 1000}s, Mode: ${once ? "single check" : "continuous"}`);

if (!once) {
  await notify("Monitor started, watching for bridge mode changes.", Color.GREEN);
}

await runCheck();

if (!once) {
  setInterval(runCheck, CHECK_INTERVAL_MS);
}

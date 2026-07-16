import { log } from "./log.mjs";
import { notify, Color } from "./notify.mjs";
import { api, checkDeviceMode, getCSRFToken, login, logout } from "./station.mjs";
import { collectOnce } from "./collector.mjs";

const ROUTER_IP = process.env.ROUTER_IP ?? "192.168.100.1";
const ROUTER_USER = process.env.ROUTER_USER ?? "admin";
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS ?? "300000"); // 5 min
const COLLECTOR_ENABLED = (process.env.COLLECTOR_ENABLED ?? "true") !== "false";
const LOGIN_RETRIES = 3;
const LOGIN_RETRY_DELAY_MS = 30_000; // 30s between retries

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

async function restoreBridgeMode(deviceMode) {
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
}

async function runCheck() {
  try {
    const { deviceMode, lanMode } = await checkDeviceMode();
    log(`DeviceMode: ${deviceMode}, LanMode: ${lanMode}`);

    if (deviceMode !== "bridge" && lanMode !== "bridge-static") {
      log(`Router is in "${deviceMode}" mode — switching to bridge mode...`);
      await restoreBridgeMode(deviceMode);
      return; // skip collection this round, the station is rebooting
    }

    if (COLLECTOR_ENABLED) {
      try {
        await collectOnce();
      } catch (err) {
        log(`Collector error (non-fatal): ${err.message}`);
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
log(`Router: http://${ROUTER_IP}, User: ${ROUTER_USER}`);
log(`Check interval: ${CHECK_INTERVAL_MS / 1000}s, Mode: ${once ? "single check" : "continuous"}`);
log(`Signal collector: ${COLLECTOR_ENABLED ? "enabled" : "disabled"}`);

if (!once) {
  await notify("Monitor started, watching for bridge mode changes.", Color.GREEN);
}

await runCheck();

if (!once) {
  setInterval(runCheck, CHECK_INTERVAL_MS);
}

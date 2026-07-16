import { pbkdf2 } from "./auth.mjs";
import { log } from "./log.mjs";

const ROUTER_IP = process.env.ROUTER_IP ?? "192.168.100.1";
const ROUTER_USER = process.env.ROUTER_USER ?? "admin";
const ROUTER_PASS = process.env.ROUTER_PASS;
const BASE = `http://${ROUTER_IP}`;

export async function api(path, opts = {}) {
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

export async function checkDeviceMode() {
  const res = await api("login_conf");
  const json = await res.json();
  return {
    deviceMode: json.data?.DeviceMode?.toLowerCase(),
    lanMode: json.data?.LanMode,
    firmware: json.data?.firmwareversion,
  };
}

export async function login() {
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

export async function getCSRFToken(sessionCookie) {
  const res = await api("session/init_page", {
    headers: { Cookie: sessionCookie },
  });
  const json = await res.json();
  return json.token;
}

export async function logout(sessionCookie) {
  await api("session/logout", {
    method: "POST",
    headers: {
      Cookie: sessionCookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({}),
  });
}

export async function getDocsisStatus(sessionCookie) {
  const res = await api("sta_docsis_status", {
    headers: { Cookie: sessionCookie },
  });
  const json = await res.json();
  if (json.error !== "ok") {
    throw new Error(`sta_docsis_status failed: ${json.message}`);
  }
  return json.data;
}

export async function getEventLog(sessionCookie) {
  const res = await api("eventlog", { headers: { Cookie: sessionCookie } });
  const json = await res.json();
  if (json.error !== "ok") {
    throw new Error(`eventlog failed: ${json.message}`);
  }
  return json.data;
}

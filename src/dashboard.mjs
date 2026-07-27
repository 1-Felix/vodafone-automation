import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.mjs";

const UI = join(import.meta.dirname, "ui");
const read = (name) => readFileSync(join(UI, name), "utf8");

// The page ships as one self-contained document: no build step, no CDN, no
// second request. Markup, styles and script live as real files under src/ui/
// and are inlined here once at startup.
//
// A missing asset must not take the monitor down with it: this process is the
// watchdog, and a container that crash-loops on import alerts nobody. Degrade
// to a stub page instead and keep failover, metering and Discord alive.
function loadPage() {
  try {
    return read("index.html")
      .replace("<!--css-->", () => `<style>\n${read("app.css")}</style>`)
      .replace("<!--js-->", () => `<script>\n${read("app.js")}</script>`);
  } catch (err) {
    log(`Dashboard UI assets failed to load (${err.message}) — serving stub page`);
    return `<!doctype html><meta charset="utf-8"><title>LTE Failover</title>
<body style="font:16px/1.5 system-ui;background:#0b1015;color:#dfe8f0;padding:2rem">
<h1>Dashboard assets missing</h1>
<p>The monitor itself is running — only this page failed to load.
Check that <code>src/ui/</code> made it into the image.</p>
<p>Raw status: <a style="color:#3ed9c4" href="api/status">api/status</a></p>`;
  }
}

const PAGE = loadPage();

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function json(res, obj, code = 200) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

export function startDashboard({ port, getStatus, toggleArmed, toggleGuard, setBalance, onWanEvent }) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE);
      } else if (req.method === "GET" && req.url === "/api/status") {
        json(res, await getStatus());
      } else if (req.method === "POST" && req.url === "/api/toggle") {
        json(res, { armed: await toggleArmed() });
      } else if (req.method === "POST" && req.url === "/api/guard") {
        json(res, { guard: await toggleGuard() });
      } else if (req.method === "POST" && req.url === "/api/balance") {
        let body = {};
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch { /* handled below */ }
        json(res, { balance: await setBalance(parseFloat(body.eur)) });
      } else if (req.method === "POST" && req.url === "/event") {
        let evt = {};
        try {
          evt = JSON.parse((await readBody(req)) || "{}");
        } catch {
          // ignore malformed hotplug payloads
        }
        if (evt.iface) onWanEvent({ iface: evt.iface, action: evt.action });
        json(res, { ok: true });
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (err) {
      log(`Dashboard error ${req.method} ${req.url}: ${err.message}`);
      json(res, { error: err.message }, 500);
    }
  });
  server.listen(port);
  return server;
}

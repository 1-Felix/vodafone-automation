import { createServer } from "node:http";
import { log } from "./log.mjs";

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LTE Failover</title>
<style>
body{font:16px/1.5 system-ui;background:#0f1117;color:#e6e6e6;max-width:680px;margin:2rem auto;padding:0 1rem}
h1{font-size:1.3rem} .row{margin:.8rem 0}
.badge{display:inline-block;padding:.25rem .8rem;border-radius:.5rem;font-weight:700}
.CABLE_OK{background:#14532d}.LTE_ACTIVE{background:#7f1d1d}.ALL_DOWN{background:#450a0a;outline:2px solid #ef4444}
.pill{padding:.15rem .6rem;border-radius:1rem;font-size:.8rem;background:#1f2937}
.warn{background:#78350f}
button{font:inherit;padding:.5rem 1.4rem;border-radius:.5rem;border:0;cursor:pointer;background:#2563eb;color:#fff}
button.off{background:#4b5563}
table{width:100%;border-collapse:collapse;margin-top:1rem}
td,th{padding:.35rem .5rem;border-bottom:1px solid #262b36;text-align:left;font-size:.85rem}
.muted{color:#8b93a7;font-size:.8rem}.num{font-variant-numeric:tabular-nums}
</style></head><body>
<h1>LTE Failover — Spitz Plus / CallYa</h1>
<div class="row"><span id="state" class="badge">…</span> <span id="armed" class="pill"></span> <span id="backup" class="pill"></span></div>
<div class="row" id="session"></div>
<div class="row num">Today <b id="day">–</b> · Month <b id="month">–</b> · Total <b id="total">–</b></div>
<div class="row"><button id="btn" onclick="toggle()">…</button></div>
<div class="row"><span id="guard" class="pill">…</span> <button id="gbtn" onclick="guardToggle()">…</button></div>
<div class="row"><span id="balance">CallYa Guthaben: –</span> <input id="balin" size="7" inputmode="decimal" placeholder="12.34"> <button onclick="setBal()">Sync balance</button></div>
<table><thead><tr><th>Start</th><th>Duration</th><th>MB</th><th>Cost</th></tr></thead><tbody id="hist"></tbody></table>
<p class="muted" id="updated"></p>
<script>
const mb=b=>(b/1e6).toFixed(1), eur=v=>v.toFixed(2)+" €";
async function refresh(){
  const s=await (await fetch("api/status")).json();
  const st=document.getElementById("state");
  st.textContent=s.connState??"UNKNOWN"; st.className="badge "+(s.connState??"");
  document.getElementById("armed").textContent=s.armed?"armed":"DISARMED";
  document.getElementById("backup").textContent=s.backupOk===false?"⚠ backup broken":"backup ok";
  document.getElementById("session").textContent=s.session?("Active session: "+mb(s.session.bytes)+" MB ≈ "+eur(s.session.costEur)):"";
  if(s.totals)for(const k of["day","month","total"])document.getElementById(k).textContent=mb(s.totals[k].bytes)+" MB / "+eur(s.totals[k].costEur);
  const b=document.getElementById("btn");
  b.textContent=s.armed?"Disarm fallback":"Arm fallback"; b.className=s.armed?"":"off";
  const g=s.guard??{};
  const gp=document.getElementById("guard");
  gp.textContent = g.state==="open" ? "guard OPEN"+(g.openUntil?" until "+g.openUntil.slice(11,16)+" UTC":"")
    : g.state==="missing" ? "⚠ guard missing" : "guard locked";
  gp.className = "pill"+(g.state==="locked"?"":" warn");
  const gb=document.getElementById("gbtn");
  gb.textContent = g.state==="open" ? "Relock now" : g.state==="missing" ? "Rebuild guard" : "Open for all ("+(g.openMinutes??60)+" min)";
  const bal=s.balance;
  document.getElementById("balance").innerHTML = "CallYa Guthaben: "+(bal
    ? "<b"+(bal.low?' class="warn pill"':"")+">"+eur(bal.eur)+"</b> <span class=\\"muted\\">(synced "+eur(bal.anchorEur)+" at "+bal.anchorTs.slice(0,16).replace("T"," ")+")</span>"
    : "– <span class=\\"muted\\">(sync once via *100# on a phone / MeinVodafone)</span>");
  document.getElementById("hist").innerHTML=(s.history??[]).map(h=>{
    const min=Math.max(1,Math.round((Date.parse(h.endTs)-Date.parse(h.startTs))/60000));
    return "<tr><td>"+h.startTs.slice(0,16).replace("T"," ")+"</td><td>"+min+" min</td><td>"+mb(h.bytes)+"</td><td>"+eur(h.costEur??0)+"</td></tr>";
  }).join("");
  document.getElementById("updated").textContent="updated "+(s.updatedAt??"never");
}
async function toggle(){
  document.getElementById("btn").disabled=true;
  try{await fetch("api/toggle",{method:"POST"});}finally{document.getElementById("btn").disabled=false;}
  refresh();
}
async function guardToggle(){
  const b=document.getElementById("gbtn");
  b.disabled=true;
  try{await fetch("api/guard",{method:"POST"});}finally{b.disabled=false;}
  refresh();
}
async function setBal(){
  const v=parseFloat(document.getElementById("balin").value.replace(",", "."));
  if(!isFinite(v))return;
  await fetch("api/balance",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({eur:v})});
  document.getElementById("balin").value="";
  refresh();
}
setInterval(refresh,10000);refresh();
</script></body></html>`;

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

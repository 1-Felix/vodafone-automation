const $ = (id) => document.getElementById(id);

const EUR = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const DEC1 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const DEC2 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const STATES = {
  CABLE_OK: {
    color: "var(--link)",
    title: "Cable up",
    sub: "LTE is on standby. Nothing is being metered.",
  },
  LTE_ACTIVE: {
    color: "var(--alarm)",
    title: "LTE active",
    sub: "The cable is down. Every megabyte comes off the CallYa balance.",
  },
  ALL_DOWN: {
    color: "var(--alarm)",
    title: "All down",
    sub: "Neither the cable nor the LTE stick is carrying traffic.",
  },
};

const eur = (v) => (Number.isFinite(v) ? EUR.format(v) : "–");

// Units are glued to their number with a non-breaking space so a narrow screen
// never wraps "412,3" onto one line and "MB" onto the next.
function data(b) {
  if (!Number.isFinite(b)) return "–";
  return b >= 1e9 ? DEC2.format(b / 1e9) + " GB" : DEC1.format(b / 1e6) + " MB";
}

function dur(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return m + " min";
  return Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") + " min";
}

const clock = (ts) =>
  new Date(ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

const stamp = (ts) =>
  new Date(ts).toLocaleString("de-DE", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });

function renderState(s) {
  const view = STATES[s.connState] ?? {
    color: "var(--ink-faint)",
    title: "No data",
    sub: "The collector has not reported a link state yet.",
  };
  document.documentElement.style.setProperty("--state", view.color);
  $("state").textContent = view.title;
  $("statesub").textContent = view.sub;
  $("rail").classList.toggle("pulse", s.connState === "ALL_DOWN");

  const armed = $("armed");
  armed.textContent = s.armed ? "fallback armed" : "fallback disarmed";
  armed.classList.toggle("warn", s.armed === false);

  const backup = $("backup");
  backup.textContent = s.backupOk === false ? "backup unreachable" : "backup reachable";
  backup.classList.toggle("warn", s.backupOk === false);
}

function renderGauge(bal) {
  const gauge = $("gauge");
  const ticks = $("ticks");

  if (!bal) {
    gauge.classList.add("empty");
    gauge.classList.remove("low");
    gauge.setAttribute("aria-label", "Prepaid balance not synced yet");
    $("fill").style.height = "0%";
    $("ghost").style.height = "0%";
    $("lowmark").hidden = true;
    ticks.replaceChildren();
    $("balance").textContent = "not synced";
    $("balancesub").textContent = "Enter the current CallYa credit below to start tracking it.";
    return;
  }

  // The scale has to reach the reserve line too, or a high threshold would sit
  // off the top of the column.
  const top = Math.max(bal.anchorEur, bal.eur, bal.lowEur ?? 0, 10);
  // Headroom when the highest reference lands exactly on a step, or it would
  // sit on the rim — which is precisely the low-balance case, where the reserve
  // line has to stay readable as a line rather than a border.
  let ceiling = Math.ceil(top / 5) * 5;
  if (ceiling === top) ceiling += 5;
  const step = ceiling > 30 ? 10 : 5;
  const pct = (v) => Math.max(0, Math.min(100, (v / ceiling) * 100));
  const spent = Math.max(0, bal.anchorEur - bal.eur);

  gauge.classList.remove("empty");
  gauge.classList.toggle("low", !!bal.low);
  gauge.setAttribute(
    "aria-label",
    `Prepaid balance ${eur(bal.eur)} of a ${ceiling} euro scale, ${eur(spent)} used since the last sync`
      + (Number.isFinite(bal.lowEur) ? `, low below ${eur(bal.lowEur)}` : ""),
  );

  $("fill").style.height = pct(bal.eur) + "%";
  const ghost = $("ghost");
  ghost.style.bottom = pct(bal.eur) + "%";
  ghost.style.height = pct(bal.anchorEur) - pct(bal.eur) + "%";

  const mark = $("lowmark");
  mark.hidden = !Number.isFinite(bal.lowEur);
  if (!mark.hidden) mark.style.bottom = pct(bal.lowEur) + "%";

  const marks = [];
  for (let v = step; v <= ceiling; v += step) {
    const el = document.createElement("span");
    el.className = "tick";
    el.style.bottom = pct(v) + "%";
    el.textContent = v;
    marks.push(el);
  }
  ticks.replaceChildren(...marks);

  $("balance").textContent = eur(bal.eur);
  $("balancesub").textContent =
    spent > 0
      ? `${eur(spent)} used since the sync on ${stamp(bal.anchorTs)}`
      : `Synced at ${eur(bal.anchorEur)} on ${stamp(bal.anchorTs)}`;
}

function renderSession(s) {
  const box = $("session");
  if (!s.session) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const ran = dur(Date.now() - Date.parse(s.session.startTs));
  $("sessionline").textContent =
    `${ran} · ${data(s.session.bytes)} · ${eur(s.session.costEur)}`;
}

function renderTotals(totals) {
  if (!totals) return;
  for (const k of ["day", "month", "total"]) {
    const t = totals[k];
    const volume = document.createElement("span");
    const cost = document.createElement("span");
    cost.className = "cost";
    volume.textContent = t ? data(t.bytes) : "–";
    cost.textContent = t ? eur(t.costEur) : "";
    $(k).replaceChildren(volume, cost);
  }
}

function renderArm(s) {
  const btn = $("armbtn");
  btn.textContent = s.armed ? "Disarm fallback" : "Arm fallback";
  $("armcap").textContent = s.armed
    ? "LTE takes over on its own when the cable drops."
    : "LTE stays off. A cable outage will not fail over.";
}

function renderGuard(guard = {}) {
  const btn = $("guardbtn");
  const cap = $("guardcap");
  const flag = $("guardflag");
  btn.classList.remove("costly");

  // An unlocked guard is a spending state, so it earns a place in the
  // at-a-glance row next to the link flags.
  flag.hidden = guard.state === "locked" || !guard.state;
  flag.textContent = guard.state === "open" ? "guard open" : "guard missing";

  if (guard.state === "open") {
    $("guardname").textContent = "LTE guard — open";
    cap.textContent = guard.openUntil
      ? `Every device can reach LTE until ${clock(guard.openUntil)}, then it relocks itself.`
      : "Every device can reach LTE.";
    btn.textContent = "Relock now";
  } else if (guard.state === "missing") {
    $("guardname").textContent = "LTE guard — missing";
    cap.textContent = "The firewall chain is gone. Nothing is holding devices off LTE.";
    btn.textContent = "Rebuild guard";
    btn.classList.add("costly");
  } else {
    $("guardname").textContent = "LTE guard — locked";
    cap.textContent = "Only allowlisted devices reach LTE during a failover.";
    btn.textContent = `Open to all · ${guard.openMinutes ?? 60} min`;
    btn.classList.add("costly");
  }
}

function renderHistory(history = []) {
  const rows = history.map((h) => {
    const tr = document.createElement("tr");
    const cells = [
      stamp(h.startTs),
      dur(Date.parse(h.endTs) - Date.parse(h.startTs)),
      data(h.bytes),
      eur(h.costEur ?? 0),
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      if (i > 1) td.className = "r";
      td.textContent = text;
      tr.append(td);
    });
    return tr;
  });
  $("hist").replaceChildren(...rows);
  $("histwrap").hidden = rows.length === 0;
  $("empty").hidden = rows.length > 0;
}

async function refresh() {
  let s;
  try {
    const res = await fetch("api/status");
    if (!res.ok) throw new Error("status " + res.status);
    s = await res.json();
  } catch (err) {
    const foot = $("updated");
    foot.className = "cap lost";
    foot.textContent = `Lost contact with the collector (${err.message}). Retrying every 10 s.`;
    return;
  }

  renderState(s);
  renderGauge(s.balance);
  renderSession(s);
  renderTotals(s.totals);
  renderArm(s);
  renderGuard(s.guard);
  renderHistory(s.history);

  const foot = $("updated");
  foot.className = "cap";
  foot.textContent = s.updatedAt ? `Updated ${stamp(s.updatedAt)}` : "No sample taken yet.";
}

async function post(btn, url, body) {
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  try {
    await fetch(url, {
      method: "POST",
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
  refresh();
}

$("armbtn").addEventListener("click", (e) => post(e.currentTarget, "api/toggle"));
$("guardbtn").addEventListener("click", (e) => post(e.currentTarget, "api/guard"));

$("balform").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("balin");
  const value = parseFloat(input.value.replace(",", "."));
  if (!Number.isFinite(value)) {
    input.focus();
    return;
  }
  input.value = "";
  post(e.target.querySelector("button"), "api/balance", { eur: value });
});

setInterval(refresh, 10000);
refresh();

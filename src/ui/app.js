const $ = (id) => document.getElementById(id);

const EUR = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const DEC1 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const DEC2 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

// Coarse age for "checked … ago" and staleness; days once hours stop helping.
function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + " s";
  const m = Math.round(s / 60);
  if (m < 60) return m + " min";
  const h = Math.round(m / 60);
  return h < 48 ? h + " h" : Math.round(h / 24) + " days";
}

const ago = (t) => span(Date.now() - new Date(t).getTime()) + " ago";

// Each verdict owns exactly one status colour; the rail, headline, tab title
// and favicon all follow it.
const VERDICTS = {
  protected: { token: "--ok", title: "Protected" },
  "at-risk": { token: "--warn", title: "At risk" },
  unprotected: { token: "--bad", title: "Unprotected" },
  backup: { token: "--warn", title: "On backup" },
  offline: { token: "--bad", title: "Offline" },
  stale: { token: "--idle", title: "Stale" },
};

const STATE_WORD = { ok: "fine", warn: "needs attention", fail: "broken", unknown: "unknown" };

let favicon = "";

function paint(token, title, why, { pulse = false, stale = false } = {}) {
  const root = document.documentElement;
  root.style.setProperty("--state", `var(${token})`);
  $("verdict").textContent = title;
  $("why").textContent = why;
  $("rail").classList.toggle("pulse", pulse);
  $("rail").classList.toggle("stale", stale);
  $("page").classList.toggle("stale", stale);
  document.title = `${title} · LTE failover`;

  // A pinned tab should answer the question without being opened. Only swap
  // the icon on change, or some browsers flicker it on every refresh.
  const color = getComputedStyle(root).getPropertyValue(token).trim();
  const dot = stale
    ? `<circle cx='8' cy='8' r='4.5' fill='none' stroke='${color}' stroke-width='1.5'/>`
    : `<circle cx='8' cy='8' r='5.5' fill='${color}'/>`;
  const href = "data:image/svg+xml," + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='3' fill='#0b1015'/>${dot}</svg>`,
  );
  if (href !== favicon) $("favicon").href = favicon = href;
}

// Everything keeping the verdict off "protected", worst first.
function problems(s) {
  const { checks } = s.readiness;
  const bal = s.balance;
  const out = [];
  if (checks.armed === "fail") {
    out.push(checks.credit === "fail"
      ? "Auto-disarmed at the reserve floor. Top up, sync the balance, then arm it again."
      : "The fallback is disarmed. A cable outage will not fail over.");
  }
  if (checks.backup === "fail") out.push("The backup link is unreachable. A cable outage would leave you offline.");
  if (checks.guard === "fail") out.push("The LTE guard is missing. A failover would let every device spend credit.");
  if (checks.credit === "fail" && checks.armed !== "fail") {
    out.push(`Credit is at the ${eur(bal.reserveEur)} reserve floor. LTE is about to be disarmed.`);
  }
  if (checks.guard === "warn") {
    out.push(s.guard.openUntil
      ? `The LTE guard is open until ${clock(s.guard.openUntil)}. Every device can spend credit.`
      : "The LTE guard is open. Every device can spend credit.");
  }
  if (checks.credit === "warn") out.push(`Credit is low at ${eur(bal.eur)}. Top up soon.`);
  if (checks.drill === "warn") out.push("The last monthly drill failed. Check the Spitz and its SIM.");
  if (checks.credit === "unknown") out.push("Credit isn't synced, so the reserve floor can't guard it.");
  if (checks.armed === "unknown" || checks.guard === "unknown") out.push("Part of the fallback hasn't been read yet.");
  if (checks.backup === "unknown" && checks.armed === "ok") out.push("The backup link hasn't been confirmed yet.");
  return out;
}

function renderVerdict(s) {
  const { verdict } = s.readiness;
  const view = VERDICTS[verdict] ?? VERDICTS.stale;
  let title = view.title;
  let why;

  if (verdict === "stale") {
    if (s.updatedAt) {
      why = `No sample for ${span(Date.now() - Date.parse(s.updatedAt))}. The monitor has stopped ticking, so everything below is from ${stamp(s.updatedAt)}.`;
    } else {
      title = "No data";
      why = "The monitor has not finished its first sample yet.";
    }
  } else if (verdict === "offline") {
    why = "Neither the cable nor LTE is carrying traffic.";
  } else if (verdict === "backup") {
    why = "The cable is down. LTE is carrying traffic, and every megabyte comes off the CallYa balance.";
  } else if (verdict === "protected") {
    why = "A cable outage fails over to LTE on its own.";
  } else {
    const list = problems(s);
    why = list[0] + (list.length > 1 ? ` (+${list.length - 1} more below)` : "");
  }

  paint(view.token, title, why, { pulse: verdict === "offline", stale: verdict === "stale" });

  const link = {
    CABLE_OK: "Cable up · LTE on standby",
    LTE_ACTIVE: s.session
      ? `Cable down · on LTE for ${dur(Date.now() - Date.parse(s.session.startTs))} · ${data(s.session.bytes)} · ${eur(s.session.costEur)}`
      : "Cable down · on LTE",
    ALL_DOWN: "Cable and LTE both down",
  }[s.connState];
  const parts = [];
  if (link) parts.push(verdict === "stale" ? "Last known: " + link : link);
  if (s.updatedAt && verdict !== "stale") parts.push("checked " + ago(s.updatedAt));
  $("context").textContent = parts.join(" · ");
}

function setCheck(key, state, detail) {
  const li = $("chk-" + key);
  li.dataset.state = state;
  li.querySelector(".sr").textContent = ": " + STATE_WORD[state];
  li.querySelector(".detail").textContent = detail;
}

function setButton(btn, label, { fix = false, disabled = false } = {}) {
  btn.textContent = label;
  btn.classList.toggle("fix", fix);
  // A refresh landing mid-request must not re-enable the button under the click.
  btn.disabled = disabled || btn.getAttribute("aria-busy") === "true";
}

function renderChecks(s) {
  const { checks } = s.readiness;
  const bal = s.balance;
  const guard = s.guard ?? {};
  const drill = s.drill;

  setCheck("armed", checks.armed, {
    ok: "Armed. LTE takes over on its own when the cable drops.",
    fail: "Disarmed. A cable outage will not fail over.",
    unknown: "Not read yet.",
  }[checks.armed]);
  setButton($("armbtn"), s.armed ? "Disarm" : "Arm fallback", {
    // At the floor, arming first would only trip the auto-disarm again: the
    // balance sync is the fix that has to come first.
    fix: checks.armed === "fail" && checks.credit !== "fail",
    disabled: checks.armed === "unknown",
  });

  setCheck("backup", checks.backup, {
    ok: s.connState === "LTE_ACTIVE" ? "Carrying traffic right now."
      : s.backupCheckedAt ? `Reachable. Pinged ${ago(s.backupCheckedAt)}.`
      : "Reachable.",
    fail: "Unreachable. The Spitz or its SIM is not answering.",
    unknown: s.armed === false ? "Not checked while the fallback is disarmed." : "Not checked yet.",
  }[checks.backup]);

  setCheck("guard", checks.guard, {
    ok: "Locked. Only allowlisted devices reach LTE during a failover.",
    warn: guard.openUntil
      ? `Open until ${clock(guard.openUntil)}. Every device can reach LTE, then it relocks itself.`
      : "Open. Every device can reach LTE.",
    fail: "Missing. The firewall chain is gone, so nothing holds devices off LTE.",
    unknown: "Not read yet.",
  }[checks.guard]);
  setButton($("guardbtn"), {
    ok: `Open to all · ${guard.openMinutes ?? 60} min`,
    warn: "Relock now",
    fail: "Rebuild guard",
    unknown: "…",
  }[checks.guard], {
    fix: checks.guard === "warn" || checks.guard === "fail",
    disabled: checks.guard === "unknown",
  });

  setCheck("credit", checks.credit, !bal ? "Not synced. Enter the CallYa balance below to start tracking it." : {
    ok: `${eur(bal.eur)} · warns below ${eur(bal.lowEur)}, disarms at ${eur(bal.reserveEur)}`,
    warn: `${eur(bal.eur)} · below ${eur(bal.lowEur)}, top up soon`,
    fail: `${eur(bal.eur)} · at the ${eur(bal.reserveEur)} reserve floor. Top up, sync, then arm again.`,
  }[checks.credit]);
  const creditBtn = $("creditbtn");
  creditBtn.hidden = checks.credit === "ok";
  creditBtn.classList.toggle("fix", checks.credit === "fail" || checks.credit === "unknown");

  setCheck("drill", checks.drill,
    !drill ? "No result recorded yet. It runs early on the 1st of each month."
      : drill.ok ? `Passed ${stamp(drill.ts)} · ${data(drill.bytes)} in ${DEC1.format(drill.seconds)} s`
      : `Failed ${stamp(drill.ts)} · check the Spitz and its SIM`);
}

function renderGauge(bal, credit) {
  const gauge = $("gauge");
  const ticks = $("ticks");

  if (!bal) {
    gauge.classList.add("empty");
    gauge.classList.remove("low", "floor");
    gauge.setAttribute("aria-label", "Prepaid balance not synced yet");
    $("fill").style.height = "0%";
    $("ghost").style.height = "0%";
    $("lowmark").hidden = true;
    ticks.replaceChildren();
    $("balance").textContent = "not synced";
    $("balancesub").textContent = "Enter the current CallYa credit below to start tracking it.";
    return;
  }

  // The scale has to reach the low line too, or a high threshold would sit off
  // the top of the column. Beyond that it follows the money actually in play:
  // top-ups are ~5 €, and a fresh one has to read as a full column instead of a
  // third of a fixed 15 € scale.
  const top = Math.max(bal.anchorEur, bal.eur, bal.lowEur ?? 0, 1);
  const step = top <= 6 ? 1 : top <= 12 ? 2 : top <= 30 ? 5 : 10;
  // Always keep a slice of empty column above the highest reference, so it
  // reads as a line rather than as the rim. That reference is the anchor right
  // after a top-up and the low line once the credit has fallen under it. Keyed
  // off a fraction rather than an exact step hit, or 4,97 € would fill a 5 €
  // scale to the brim while 5,00 € sat at 83 % of a 6 € one.
  let ceiling = Math.ceil(top / step) * step;
  if (top > ceiling * 0.92) ceiling += step;
  const pct = (v) => Math.max(0, Math.min(100, (v / ceiling) * 100));
  const spent = Math.max(0, bal.anchorEur - bal.eur);

  gauge.classList.remove("empty");
  gauge.classList.toggle("low", credit === "warn");
  gauge.classList.toggle("floor", credit === "fail");
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

// When the last good status arrived, so a lost collector reads as stale
// instead of leaving the last verdict painted as if it were live.
let lastContactAt = null;

async function refresh() {
  let s;
  try {
    const res = await fetch("api/status");
    if (!res.ok) throw new Error("status " + res.status);
    s = await res.json();
  } catch (err) {
    const since = lastContactAt ? ` Everything below is from ${clock(lastContactAt)}.` : "";
    paint("--idle", "No contact", `Can't reach the collector (${err.message}). Retrying every 10 s.${since}`, { stale: true });
    $("context").textContent = lastContactAt ? "Last contact " + ago(lastContactAt) : "";
    return;
  }
  lastContactAt = Date.now();

  renderVerdict(s);
  renderChecks(s);
  renderGauge(s.balance, s.readiness.checks.credit);
  renderTotals(s.totals);
  renderHistory(s.history);
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
$("creditbtn").addEventListener("click", () => {
  const input = $("balin");
  input.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  input.focus({ preventScroll: true });
});

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

const $ = (id) => document.getElementById(id);
const tip = $("tip");
let DATA = null;

const SEG_COLOR = { callcenter: "var(--s1)", tech: "var(--s2)", va: "var(--s3)" };
const SEG_LABEL = { callcenter: "Call centre", tech: "Tech & talent", va: "Virtual assistants" };

const pct = (n, d) => (d ? (n / d) * 100 : 0);
const fmt = (n) => n.toLocaleString();
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

function showTip(evt, html) {
  tip.innerHTML = html;
  tip.style.opacity = "1";
  const pad = 14;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  const r = tip.getBoundingClientRect();
  if (x + r.width > innerWidth) x = evt.clientX - r.width - pad;
  if (y + r.height > innerHeight) y = evt.clientY - r.height - pad;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}
const hideTip = () => (tip.style.opacity = "0");

// ---------------------------------------------------------------- rendering

function renderTiles(c) {
  const sent = c.length;
  const emails = c.reduce((n, x) => n + (x.touches?.length || 1), 0);
  const replied = c.filter((x) => x.repliedAt).length;
  const bounced = c.filter((x) => x.bouncedAt).length;
  const rate = pct(replied, sent);
  const bRate = pct(bounced, sent);
  // Only contacts sent a tracked logo can have opened; imported and
  // pre-tracking mail is left out rather than counted as unopened.
  const tracked = c.filter((x) => x.tracked);
  const opened = tracked.filter((x) => x.openedAt).length;
  const unsub = c.filter((x) => x.unsubscribedAt).length;

  // 3-7% is a working cold campaign; under 1% is nearly always deliverability
  // rather than copy, and a bounce rate over 3% is where domains get burned.
  const verdict = rate >= 3 ? "working" : rate >= 1 ? "below par" : "check deliverability first";
  const bVerdict = bRate > 3 ? "too high — pause and check" : bRate > 0 ? "within normal range" : "clean";

  const tiles = [
    { v: fmt(sent), k: "contacts emailed" },
    { v: fmt(emails), k: "emails sent", note: `${(emails / (sent || 1)).toFixed(1)} touches each` },
    { v: tracked.length ? pct(opened, tracked.length).toFixed(0) + "%" : "—",
      k: `open rate · ${opened} of ${tracked.length} opened`,
      note: tracked.length ? "an estimate — see the note at the bottom" : "starts with your next send" },
    { v: rate.toFixed(1) + "%", k: `reply rate · ${replied} replies`, cls: replied ? "good" : "", note: verdict },
    { v: bRate.toFixed(1) + "%", k: `bounced · ${bounced}`, cls: bRate > 3 ? "bad" : "", note: bVerdict },
    { v: fmt(unsub), k: "unsubscribed", note: unsub ? "never emailed again" : "" },
  ];
  $("tiles").innerHTML = tiles.map((t) => `
    <div class="tile ${t.cls || ""}">
      <div class="v">${t.v}</div>
      <div class="k">${t.k}</div>
      ${t.note ? `<div class="note">${t.note}</div>` : ""}
    </div>`).join("");
}

// Grouped bars rather than stacked: sends and replies are different events, and
// stacking them would imply a total that means nothing.
function renderTimeline(c) {
  const sends = {}, replies = {}, opens = {};
  for (const x of c) {
    for (const t of x.touches || [{ at: x.firstSentAt }]) {
      const k = dayKey(t.at); sends[k] = (sends[k] || 0) + 1;
    }
    if (x.repliedAt) { const k = dayKey(x.repliedAt); replies[k] = (replies[k] || 0) + 1; }
    if (x.openedAt) { const k = dayKey(x.openedAt); opens[k] = (opens[k] || 0) + 1; }
  }
  const days = [...new Set([...Object.keys(sends), ...Object.keys(replies), ...Object.keys(opens)])].sort().slice(-30);
  if (!days.length) { $("timeline").innerHTML = `<p class="cap">No activity yet.</p>`; return; }

  const W = 900, H = 210, PL = 38, PR = 10, PT = 12, PB = 26;
  const max = Math.max(1, ...days.map((d) => Math.max(sends[d] || 0, replies[d] || 0, opens[d] || 0)));
  const bw = (W - PL - PR) / days.length;
  const y = (v) => PT + (H - PT - PB) * (1 - v / max);

  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = Math.round((max / 4) * i), yy = y(v);
    g += `<line class="grid-line" x1="${PL}" x2="${W - PR}" y1="${yy}" y2="${yy}"/>
          <text class="axis" x="${PL - 7}" y="${yy + 3}" text-anchor="end">${v}</text>`;
  }

  let bars = "";
  days.forEach((d, i) => {
    const x0 = PL + i * bw;
    const s = sends[d] || 0, o = opens[d] || 0, r = replies[d] || 0;
    const tip = `<b>${d}</b><br>${s} sent<br>${o} opened<br>${r} replied`;
    // 2px gap between adjacent fills, 4px rounded ends anchored to the baseline.
    const w = Math.max(2, bw / 3 - 2);
    if (s) bars += `<rect x="${x0 + 1}" y="${y(s)}" width="${w}" height="${H - PB - y(s)}" rx="3" fill="var(--s1)" data-tip="${tip}"/>`;
    if (o) bars += `<rect x="${x0 + w + 3}" y="${y(o)}" width="${w}" height="${H - PB - y(o)}" rx="3" fill="var(--s2)" data-tip="${tip}"/>`;
    if (r) bars += `<rect x="${x0 + 2 * w + 5}" y="${y(r)}" width="${w}" height="${H - PB - y(r)}" rx="3" fill="var(--good)" data-tip="${tip}"/>`;
    if (i === 0 || i === days.length - 1 || i === Math.floor(days.length / 2)) {
      bars += `<text class="axis" x="${x0 + bw / 2}" y="${H - 8}" text-anchor="middle">${d.slice(5)}</text>`;
    }
  });

  $("timeline").innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Emails sent, opened and replied to, by day">
      ${g}<line class="grid-line" x1="${PL}" x2="${W - PR}" y1="${H - PB}" y2="${H - PB}"/>${bars}
    </svg>`;
  wireTips($("timeline"));
}

// Open rate per template, over tracked contacts only. Same small-sample rule
// as reply rate: a template sent to four people can't have an open rate yet.
function renderOpensBySegment(c) {
  const rows = Object.keys(SEG_LABEL).map((id) => {
    const list = c.filter((x) => x.segment === id && x.tracked);
    const opened = list.filter((x) => x.openedAt).length;
    const rate = pct(opened, list.length);
    const thin = list.length < MIN_N;
    return {
      id, label: SEG_LABEL[id], value: rate, sent: list.length, opened, thin,
      display: thin ? `${opened}/${list.length}` : rate.toFixed(0) + "%",
      tip: `<b>${SEG_LABEL[id]}</b><br>${list.length} sent with tracking<br>${opened} opened` +
        (thin ? `<br><i>too few to read a rate from</i>` : `<br>${rate.toFixed(0)}% open rate`),
    };
  }).filter((r) => r.sent > 0).sort((a, b) => b.sent - a.sent);

  hbars($("opensBySegment"), rows, {
    colorFor: (r) => (r.thin ? "var(--text-3)" : SEG_COLOR[r.id]),
    sublabel: (r) => (r.thin ? `${r.sent} sent — too few to judge` : `${r.opened} of ${r.sent} opened`),
  });
}

const VIA_LABEL = { gmail: "Gmail", outlook: "Outlook", yahoo: "Yahoo", other: "other mail app" };
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

// Who opened most recently. Someone who opened more than once and hasn't
// replied is the warmest lead on the list, so they're flagged.
function renderRecentOpens(c) {
  const list = c.filter((x) => x.lastOpenAt).sort((a, b) => b.lastOpenAt - a.lastOpenAt).slice(0, 12);
  const hot = c.filter((x) => x.opens >= 2 && !x.repliedAt && !x.unsubscribedAt).length;
  $("hotCount").textContent = hot
    ? `${hot} opened more than once without replying — worth a follow-up.`
    : "";
  if (!list.length) {
    $("recentOpens").innerHTML = `<p class="cap" style="margin:0">No opens yet. They appear here within ten
      minutes of someone opening an email sent with the logo.</p>`;
    return;
  }
  $("recentOpens").innerHTML = `<table>${list.map((x) => {
    const warm = x.opens >= 2 && !x.repliedAt && !x.unsubscribedAt;
    return `<tr>
      <td class="wrap"><b>${esc(x.company || x.email)}</b><br><span class="sub">${esc(x.email)}</span></td>
      <td>${timeAgo(x.lastOpenAt)}<br><span class="sub">${x.opens} open${x.opens === 1 ? "" : "s"} · ${VIA_LABEL[x.via] || "—"}</span></td>
      <td>${x.repliedAt ? `<span class="pill replied">replied</span>`
        : warm ? `<span class="pill opened">follow up</span>` : ""}</td>
    </tr>`;
  }).join("")}</table>`;
}

// Horizontal bars with the value written on each — the light-mode aqua slot is
// under 3:1 on this surface, so direct labels are required, not optional.
function hbars(el, rows, { colorFor, sublabel }) {
  if (!rows.length) { el.innerHTML = `<p class="cap">Nothing yet.</p>`; return; }
  const rowH = 34, W = 460, LW = 140, PR = 54;
  const H = rows.length * rowH + 6;
  const max = Math.max(1, ...rows.map((r) => r.value));

  const bars = rows.map((r, i) => {
    const y = i * rowH + 4, bh = 15;
    const w = ((W - LW - PR) * r.value) / max;
    return `
      <text class="barlabel" x="0" y="${y + bh - 3}">${r.label}</text>
      <rect x="${LW}" y="${y}" width="${Math.max(2, w)}" height="${bh}" rx="4" fill="${colorFor(r)}"
        data-tip="${r.tip}"/>
      <text class="val" x="${LW + Math.max(2, w) + 8}" y="${y + bh - 3}">${r.display}</text>
      ${sublabel ? `<text class="axis" x="${LW}" y="${y + bh + 12}">${sublabel(r)}</text>` : ""}`;
  }).join("");

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">${bars}</svg>`;
  wireTips(el);
}

// A reply rate needs a denominator before it means anything. One contact who
// replied is 100%, and shown next to a real segment it would point the whole
// campaign at noise — so anything under MIN_N is drawn muted and labelled as
// unreadable rather than being allowed to top the chart.
const MIN_N = 20;

function renderSegments(c) {
  const rows = Object.keys(SEG_LABEL).map((id) => {
    const list = c.filter((x) => x.segment === id);
    const replied = list.filter((x) => x.repliedAt).length;
    const rate = pct(replied, list.length);
    const thin = list.length < MIN_N;
    return {
      id, label: SEG_LABEL[id],
      value: rate, sent: list.length, replied, thin,
      display: thin ? `${replied}/${list.length}` : rate.toFixed(1) + "%",
      tip: `<b>${SEG_LABEL[id]}</b><br>${list.length} contacted<br>${replied} replied` +
        (thin ? `<br><i>too few to read a rate from</i>` : `<br>${rate.toFixed(1)}% reply rate`),
    };
  }).filter((r) => r.sent > 0)
    // Sorted by volume, not by rate: the biggest sample is the most trustworthy
    // line on the chart and belongs at the top.
    .sort((a, b) => b.sent - a.sent);

  hbars($("bySegment"), rows, {
    colorFor: (r) => (r.thin ? "var(--text-3)" : SEG_COLOR[r.id]),
    sublabel: (r) => (r.thin ? `${r.sent} sent — too few to judge` : `${r.replied} of ${r.sent}`),
  });
}

function renderVerticals(c) {
  const by = {};
  for (const x of c) {
    const k = x.vertical || "unspecified";
    by[k] = by[k] || { sent: 0, replied: 0, tracked: 0, opened: 0 };
    by[k].sent++;
    if (x.repliedAt) by[k].replied++;
    if (x.tracked) by[k].tracked++;
    if (x.openedAt) by[k].opened++;
  }
  const rows = Object.entries(by)
    .sort((a, b) => b[1].sent - a[1].sent).slice(0, 10)
    .map(([k, v]) => ({
      label: k.length > 22 ? k.slice(0, 21) + "…" : k,
      value: v.sent, display: fmt(v.sent),
      tip: `<b>${k}</b><br>${v.sent} contacted<br>${v.replied} replied (${pct(v.replied, v.sent).toFixed(1)}%)` +
        (v.tracked ? `<br>${v.opened} of ${v.tracked} opened (${pct(v.opened, v.tracked).toFixed(0)}%)` : ""),
      replied: v.replied, sent: v.sent,
    }));
  hbars($("byVertical"), rows, {
    colorFor: () => "var(--s1)",
    sublabel: (r) => (r.replied ? `${r.replied} replied` : ""),
  });
}

// Per-mailbox rates. Sending the same list from two domains and seeing 6% reply
// on one and 0.4% on the other is not a copy result — it means one domain is
// not landing, and no amount of rewriting will fix it.
function renderAccounts(c) {
  const by = {};
  for (const x of c) {
    const k = x.account || "(unrecorded)";
    by[k] = by[k] || { sent: 0, replied: 0, bounced: 0, emails: 0, tracked: 0, opened: 0 };
    if (x.tracked) by[k].tracked++;
    if (x.openedAt) by[k].opened++;
    by[k].sent++;
    by[k].emails += x.touches?.length || 1;
    if (x.repliedAt) by[k].replied++;
    if (x.bouncedAt) by[k].bounced++;
  }
  const rows = Object.entries(by).sort((a, b) => b[1].sent - a[1].sent);

  // With one mailbox there is nothing to compare, so the section stays hidden.
  if (rows.length < 2) { $("accountsWrap").classList.add("hidden"); return; }
  $("accountsWrap").classList.remove("hidden");

  const best = Math.max(...rows.filter(([, v]) => v.sent >= MIN_N).map(([, v]) => pct(v.replied, v.sent)), 0);

  $("byAccount").innerHTML =
    `<thead><tr><th>Sending address</th><th>Contacts</th><th>Emails</th>
      <th>Open rate</th><th>Reply rate</th><th>Bounce rate</th><th>Read</th></tr></thead><tbody>` +
    rows.map(([k, v]) => {
      const r = pct(v.replied, v.sent), b = pct(v.bounced, v.sent);
      const thin = v.sent < MIN_N;
      const verdict = thin ? `<span style="color:var(--text-3)">too few to judge</span>`
        : b > 3 ? `<span style="color:var(--critical)">bounce rate too high — check this domain</span>`
        : best > 0 && r < best / 3 ? `<span style="color:var(--warning)">far below the best mailbox — suspect deliverability</span>`
        : `<span style="color:var(--good)">healthy</span>`;
      return `<tr>
        <td>${k}</td>
        <td>${fmt(v.sent)}</td>
        <td>${fmt(v.emails)}</td>
        <td>${!v.tracked ? "—" : v.tracked < MIN_N ? `${v.opened}/${v.tracked}` : pct(v.opened, v.tracked).toFixed(0) + "%"}</td>
        <td>${thin ? `${v.replied}/${v.sent}` : r.toFixed(1) + "%"}</td>
        <td style="color:${b > 3 ? "var(--critical)" : "inherit"}">${thin ? `${v.bounced}/${v.sent}` : b.toFixed(1) + "%"}</td>
        <td>${verdict}</td>
      </tr>`;
    }).join("") + `</tbody>`;
}

function renderHealth(c) {
  const bounced = c.filter((x) => x.bouncedAt);
  const reasons = {};
  for (const b of bounced) reasons[b.bounceReason || "delivery failed"] = (reasons[b.bounceReason || "delivery failed"] || 0) + 1;
  const rate = pct(bounced.length, c.length);

  if (!bounced.length) {
    $("health").innerHTML = `<div class="card"><strong style="color:var(--good)">No bounces recorded.</strong>
      <div class="cap" style="margin:6px 0 0">Run a scan from the extension after each batch — bounces are the
      earliest warning that a sending domain is in trouble.</div></div>`;
    return;
  }
  const spam = Object.entries(reasons).filter(([r]) => /spam|block/.test(r)).reduce((n, [, v]) => n + v, 0);
  $("health").innerHTML = `<div class="card">
    <div style="font-size:22px;font-weight:650;color:${rate > 3 ? "var(--critical)" : "var(--text)"}">${rate.toFixed(1)}% bounced</div>
    <div class="cap">${bounced.length} of ${c.length} contacts.
      ${rate > 3 ? "<strong>Above 3% — stop sending and check the domain's authentication.</strong>" : "Within the normal range."}</div>
    <table style="margin-top:10px">
      ${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([r, n]) =>
        `<tr><td>${r}</td><td style="color:var(--text-3)">${n}</td></tr>`).join("")}
    </table>
    ${spam ? `<div class="note-box" style="margin-top:14px">${spam} rejection${spam === 1 ? " was" : "s were"}
      an explicit spam or policy block. That is a reputation problem, not a copy problem — check SPF, DKIM and
      DMARC on the sending domain before sending anything further.</div>` : ""}
  </div>`;
}

let sortKey = "lastSentAt", sortDir = -1;

function renderTable(c) {
  const q = ($("q").value || "").toLowerCase();
  const rows = c.filter((x) =>
    !q || [x.company, x.email, x.country, x.vertical, x.city].some((v) => String(v || "").toLowerCase().includes(q))
  ).sort((a, b) => {
    const av = a[sortKey] ?? "", bv = b[sortKey] ?? "";
    return (av > bv ? 1 : av < bv ? -1 : 0) * sortDir;
  });

  $("count").textContent = `${fmt(rows.length)} shown`;
  const cols = [
    ["company", "Company"], ["email", "Email"], ["segment", "Template"],
    ["vertical", "Industry"], ["country", "Country"],
    ["touches", "Touches"], ["lastSentAt", "Last sent"], ["opens", "Opens"],
    ["lastOpenAt", "Last opened"], ["status", "Status"],
  ];

  $("table").innerHTML =
    `<thead><tr>${cols.map(([k, l]) => `<th data-k="${k}">${l}${sortKey === k ? (sortDir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
     <tbody>${rows.slice(0, 400).map((x) => {
       const status = x.repliedAt ? `<span class="pill replied">replied</span>`
         : x.bouncedAt ? `<span class="pill bounced">${x.bounceReason || "bounced"}</span>`
         : x.unsubscribedAt ? `<span class="pill bounced">unsubscribed</span>`
         : x.openedAt ? `<span class="pill opened" title="${x.opens || 1} open(s), first ${new Date(x.openedAt).toLocaleString()}">opened</span>`
         : `<span class="pill">sent</span>`;
       return `<tr>
         <td class="wrap">${x.company || "—"}</td>
         <td>${x.email}</td>
         <td><span style="color:${SEG_COLOR[x.segment] || "var(--text-2)"}">●</span> ${SEG_LABEL[x.segment] || x.segment || "—"}</td>
         <td>${x.vertical || "—"}</td>
         <td>${x.country || "—"}</td>
         <td>${x.touches?.length || 1}</td>
         <td>${x.lastSentAt ? dayKey(x.lastSentAt) : "—"}</td>
         <td>${x.tracked ? x.opens || 0 : "—"}</td>
         <td>${x.lastOpenAt ? timeAgo(x.lastOpenAt) : "—"}</td>
         <td>${status}</td>
       </tr>`;
     }).join("")}</tbody>`;

  $("table").querySelectorAll("th").forEach((th) =>
    th.addEventListener("click", () => {
      const k = th.dataset.k;
      if (k === sortKey) sortDir *= -1; else { sortKey = k; sortDir = 1; }
      renderTable(c);
    }));
}

function wireTips(root) {
  root.querySelectorAll("[data-tip]").forEach((el) => {
    el.style.cursor = "pointer";
    el.addEventListener("mousemove", (e) => showTip(e, el.dataset.tip));
    el.addEventListener("mouseleave", hideTip);
  });
}

function render(data) {
  DATA = data;
  const c = data.contacts || [];
  $("empty").classList.add("hidden");
  $("app").classList.remove("hidden");
  // The in-extension copy reads live storage; a published copy is a snapshot.
  // Saying which is which matters — a stale export that looks live is worse
  // than no dashboard.
  $("meta").textContent = data.live
    ? `${data.account || ""} · live`
    : `${data.account || ""} · snapshot from ${(data.exportedAt || "").slice(0, 10)}`;
  renderTiles(c); renderTimeline(c); renderOpensBySegment(c); renderRecentOpens(c);
  renderSegments(c); renderAccounts(c); renderVerticals(c); renderHealth(c); renderTable(c);
}

// ------------------------------------------------------------------ loading

$("q").addEventListener("input", () => DATA && renderTable(DATA.contacts || []));
$("theme").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : cur === "light" ? "" : "dark";
  if (next) document.documentElement.setAttribute("data-theme", next);
  else document.documentElement.removeAttribute("data-theme");
  if (DATA) render(DATA);
});



// Reads the extension's own storage. No export step: the panel writes history
// as it sends, and this page reads the same store, so it is current the moment
// it opens. Re-reads on any change, so it stays live while a campaign runs.
// Data can come from two places: this installation's own storage, and a
// history.json shipped inside the extension folder. The bundled file is what
// makes a zipped copy carry its data to someone else's browser — Chrome does
// not let an extension write to its own directory, so the file is the only
// thing that travels with the package.
async function seedFromBundle() {
  try {
    const res = await fetch(chrome.runtime.getURL("data/history.json"));
    if (!res.ok) return {};
    const j = await res.json();
    return j && typeof j === "object" ? (j.history || j) : {};
  } catch { return {}; }
}

function fromStorage() {
  chrome.storage.local.get(["history", "lastSyncAt", "tracking"], async (d) => {
    const own = d.history || {};
    const opens = d.tracking?.byEmail || {};
    lastTrackingSync = d.tracking?.syncedAt || 0;
    const bundled = await seedFromBundle();
    // Merged, not replaced: a shared snapshot must not erase what this
    // installation has collected since, and vice versa.
    const merged = { ...bundled, ...own };
    lastSync = d.lastSyncAt || 0;

    // Opens live in their own key, written by the background worker; attach them
    // to each contact here.
    const contacts = Object.values(merged).map((x) => {
      const o = opens[x.email];
      return o ? { ...x, ...o, tracked: true, unsubscribedAt: x.unsubscribedAt || o.unsubscribedAt } : x;
    });
    document.getElementById("readout").textContent =
      `${contacts.length} contacts in view — ${Object.keys(own).length} from this browser, ` +
      `${Object.keys(bundled).length} from the bundled snapshot`;

    if (!contacts.length) {
      document.getElementById("empty").innerHTML =
        "<strong>Nothing stored yet.</strong><br>" +
        "Use <b>Read my mailboxes</b> below, or <b>Import sent</b> in the Gmail panel.";
      return;
    }
    render({
      live: true,
      account: [...new Set(contacts.map((c) => c.account).filter(Boolean))].join(", "),
      contacts,
    });
    renderSyncBar();
  });
}

let lastSync = 0;
let lastTrackingSync = 0;
let syncing = false;

function renderSyncBar() {
  const bar = document.getElementById("syncbar");
  if (!bar) return;
  bar.classList.remove("hidden");
  bar.innerHTML = syncing
    ? `<span class="spin"></span> Reading your mailboxes — this opens each signed-in Gmail account briefly.`
    : (lastSync
      ? `Last read from Gmail ${timeAgo(lastSync)}. <button class="ghost" id="resync">Refresh</button>`
      : `<button class="ghost" id="resync">Read my mailboxes</button>`) +
      (lastTrackingSync ? ` <span class="sub">· opens updated ${timeAgo(lastTrackingSync)}, automatically every 10 min</span>` : "");
  const btn = document.getElementById("resync");
  if (btn) btn.addEventListener("click", () => sync());

  const snap = document.getElementById("snapshot");
  if (snap) snap.addEventListener("click", saveSnapshot);
}

// Writes history.json for sharing. Chrome forbids an extension writing into its
// own folder, so this downloads the file and the folder step is manual — once.
// After that the file ships with the extension and every copy shows the data.
function saveSnapshot() {
  chrome.storage.local.get(["history"], (d) => {
    const history = d.history || {};
    const blob = new Blob([JSON.stringify({ history }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "history.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    document.getElementById("readout").textContent =
      `Saved history.json with ${Object.keys(history).length} contacts. ` +
      `Put it in the extension's data/ folder before zipping, and every copy will open showing it.`;
  });
}

function timeAgo(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

// Walks every signed-in Gmail account, pulling Sent mail, replies and bounces.
// The background worker does the driving; this page only reports progress.
function sync() {
  if (syncing) return;
  syncing = true;
  renderSyncBar();
  document.getElementById("empty").innerHTML =
    "<strong>Reading your mailboxes…</strong><br>" +
    "Opening each signed-in Gmail account to pull its Sent mail, replies and bounces. " +
    "This takes a minute or two the first time.";

  chrome.runtime.sendMessage({ type: "SYNC_ALL", days: 180 }, (res) => {
    syncing = false;
    if (!res || !res.ok) {
      document.getElementById("empty").innerHTML =
        "<strong>Could not read your mailboxes.</strong><br>" +
        ((res && res.error) || "Make sure you are signed in to Gmail, then try again.");
      renderSyncBar();
      return;
    }
    const found = res.accounts.filter((a) => a.imported || a.updated);
    if (!found.length && !Object.keys(res.accounts).length) {
      document.getElementById("empty").innerHTML =
        "<strong>No Gmail accounts found.</strong><br>Sign in to Gmail and try again.";
    }
    fromStorage();
    renderSyncBar();
  });
}

chrome.storage.local.get(["history", "lastSyncAt"], (d) => {
  const has = Object.keys(d.history || {}).length;
  lastSync = d.lastSyncAt || 0;
  if (has) { fromStorage(); }
  // Nothing stored and never synced: go and get it rather than showing an
  // empty page and a button. That is the whole point of the dashboard being
  // inside the extension.
  else if (!d.lastSyncAt) { sync(); }
  else { renderSyncBar(); }
});

// No guard on `syncing` here. A stuck flag used to make the page ignore every
// storage update, which is exactly how an import that saved 200 contacts could
// leave the dashboard sitting empty.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.history || changes.tracking)) fromStorage();
});

// Fresh opens every time the dashboard is opened, on top of the background
// worker's 10-minute schedule.
chrome.runtime.sendMessage({ type: "SYNC_TRACKING" }, () => void chrome.runtime.lastError);

// Storage events do not fire in a tab that was already open when another tab
// wrote, in every Chrome build. A slow poll costs nothing and closes that gap.
setInterval(fromStorage, 5000);



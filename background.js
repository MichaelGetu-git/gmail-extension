// The send loop lives in the Gmail tab, not here. An MV3 service worker is
// terminated after roughly 30 seconds idle, which killed campaigns mid-run.
// All this does now is locate a Gmail tab and open the panel in it.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function ask(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(response || null);
    });
  });
}

// Gmail puts the account index in the path: /mail/u/0/ is the default account,
// /mail/u/1/ and up are additional signed-in accounts. A bare URL resolves to
// the default.
//
// The panel used to be pinned to u/0. That made every other signed-in account
// invisible — including the ones cold outreach had actually been sent from, so
// their history could not be imported and their deliverability could not be
// measured. It now runs in whichever Gmail tab you are looking at, and the
// panel states the address so the account is a deliberate choice rather than an
// assumption. History is shared storage, so importing from several accounts
// merges into one picture.
function accountIndex(url) {
  const m = (url || "").match(/mail\.google\.com\/mail\/u\/(\d+)/);
  return m ? Number(m[1]) : 0;
}

async function findGmailTabs() {
  const tabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
  return tabs.sort((a, b) => accountIndex(a.url) - accountIndex(b.url));
}

// Prefer the tab the user is actually looking at — that is the account they
// mean. Fall back to any open Gmail tab, then to opening the default.
async function findOrCreateGmailTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && /mail\.google\.com/.test(active.url || "")) return active;

  const open = await findGmailTabs();
  if (open.length) return open[0];

  const tab = await chrome.tabs.create({
    url: "https://mail.google.com/mail/u/0/#inbox",
    active: true,
  });
  await waitForTabComplete(tab.id);
  // Gmail keeps building its UI well after the load event.
  await sleep(3000);
  return tab;
}

// A Gmail tab opened before this extension was installed or reloaded has no
// content script in it, so inject one on demand.
async function ensureContentScript(tabId) {
  const pong = await ask(tabId, { type: "PING" });
  if (pong && pong.ok) return pong;

  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  await sleep(500);
  return await ask(tabId, { type: "PING" });
}

async function getAccount() {
  const tabs = await findGmailTabs();
  if (!tabs.length) return { account: null, gmailOpen: false };
  const pong = await ensureContentScript(tabs[0].id);
  return { account: pong ? pong.account : null, gmailOpen: true };
}

async function openPanel() {
  try {
    const tab = await findOrCreateGmailTab();
    const pong = await ensureContentScript(tab.id);
    if (!pong || !pong.ok) {
      return { ok: false, error: "Could not reach the Gmail tab — reload it and retry." };
    }
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    const res = await ask(tab.id, { type: "SHOW_PANEL" });
    return res && res.ok ? { ok: true } : { ok: false, error: "Panel did not open." };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ------------------------------------------------------------ open tracking

// Every email's footer logo is served by the tracker with a per-email token,
// and loading it is what counts as an open. This worker pulls the tracker's
// hits, matches tokens to the history, and writes the result to `tracking` —
// automatically every 10 minutes, and whenever the panel or dashboard asks.
const TRACKER = "https://mailer-tracker.vercel.app";

// This browser shows the logo too — in the compose window while an email is
// written, and in review mode before it's sent. Those loads must not count, so
// here they are redirected to the untracked copy of the logo. Recipients are
// unaffected: their mail client fetches the image, not this browser.
const TRACKER_HOST = new URL(TRACKER).host;
const RULES = [
  {
    id: 1,
    priority: 1,
    action: { type: "redirect", redirect: { url: `${TRACKER}/logo.png` } },
    condition: { urlFilter: `|${TRACKER}/api/l?`, resourceTypes: ["image"] },
  },
  {
    // The old 1px pixel, still in mail sent before the logo took over.
    id: 2,
    priority: 1,
    action: { type: "block" },
    condition: { urlFilter: `||${TRACKER_HOST}/api/o`, resourceTypes: ["image"] },
  },
];

async function installRules() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: RULES.map((r) => r.id),
    addRules: RULES,
  });
}

// A hit only counts as an open if it came after the send had settled and not
// while this sender was looking at their own copy of the message (Gmail loads
// that through its image proxy, which the redirect above cannot see).
const OPEN_GRACE_MS = 10000;
const SELF_VIEW_WINDOW_MS = 60000;

// Pure: tracker events + history + self-views in, per-contact open stats out.
function computeTracking(history, events, selfViews) {
  const opens = events.opens || {};
  const unsub = events.unsub || {};
  const byEmail = {};

  for (const rec of Object.values(history)) {
    const touches = (rec.touches || []).filter((t) => t.t);
    if (!touches.length) continue;
    const e = { opens: 0, openedAt: null, lastOpenAt: null, via: "", unsubscribedAt: null };

    for (const touch of touches) {
      const mine = (selfViews[touch.t] || []).filter(([, acct]) =>
        !acct || !touch.from || acct === touch.from);
      const real = (opens[touch.t] || []).filter(([at]) =>
        at >= touch.at + OPEN_GRACE_MS &&
        !mine.some(([seenAt]) => Math.abs(seenAt - at) < SELF_VIEW_WINDOW_MS));
      e.opens += real.length;
      for (const [at, via] of real) {
        if (!e.openedAt || at < e.openedAt) e.openedAt = at;
        if (!e.lastOpenAt || at > e.lastOpenAt) { e.lastOpenAt = at; e.via = via; }
      }
      const u = unsub[touch.t];
      if (u && (!e.unsubscribedAt || u < e.unsubscribedAt)) e.unsubscribedAt = u;
    }
    byEmail[rec.email] = e;
  }
  return byEmail;
}

// Campaign totals for the public page at the tracker's root. Counts only —
// per day and per offer — never a name or an address; the per-contact view
// stays in the extension's own dashboard.
function buildReport(history, byEmail) {
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const seg = (s) => (/^callcenter/.test(s || "") ? "callcenter" : ["tech", "va"].includes(s) ? s : "other");
  const since = Date.now() - 60 * 86400000;
  const r = { contacts: 0, emails: 0, tracked: 0, opened: 0, replied: 0, bounced: 0, unsubscribed: 0,
    bySegment: {}, byDay: {}, via: { gmail: 0, outlook: 0, yahoo: 0, other: 0 } };
  const bump = (d, k) => { if (d >= day(since)) (r.byDay[d] ||= { sent: 0, opened: 0, replied: 0 })[k]++; };

  for (const h of Object.values(history)) {
    const o = byEmail[h.email];
    const g = (r.bySegment[seg(h.segment)] ||= { contacts: 0, tracked: 0, opened: 0, replied: 0 });
    r.contacts++; g.contacts++;
    for (const t of h.touches || []) { r.emails++; if (t.at) bump(day(t.at), "sent"); }
    if (o) { r.tracked++; g.tracked++; }
    if (o?.openedAt) {
      r.opened++; g.opened++; bump(day(o.openedAt), "opened");
      r.via[o.via in r.via ? o.via : "other"]++;
    }
    if (h.repliedAt) { r.replied++; g.replied++; bump(day(h.repliedAt), "replied"); }
    if (h.bouncedAt) r.bounced++;
    if (h.unsubscribedAt || o?.unsubscribedAt) r.unsubscribed++;
  }
  return r;
}

// Each browser reports under its own random id, made once and kept, so the
// page adds a team's machines together instead of one overwriting another.
// Held as a promise so two syncs starting together can't each mint an id.
let installIdPromise = null;
function installId() {
  installIdPromise ??= (async () => {
    const { installId: id } = await chrome.storage.local.get(["installId"]);
    if (id) return id;
    const fresh = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => (b % 36).toString(36)).join("");
    await chrome.storage.local.set({ installId: fresh });
    return fresh;
  })();
  return installIdPromise;
}

async function pushReport(history, byEmail) {
  await fetch(`${TRACKER}/api/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ install: await installId(), report: buildReport(history, byEmail) }),
  });
}

let syncInFlight = null;

// Concurrent callers (the alarm, the panel, the dashboard) share one fetch.
function syncTracking() {
  syncInFlight ??= (async () => {
    try {
      // Needs the team key since /api/events stopped being public.
      const res = await teamFetch("/api/events");
      if (!res.ok) throw new Error(`tracker returned ${res.status}`);
      const events = await res.json();
      if (events.configured === false) throw new Error("tracker has no database connected");

      const { history = {}, selfViews = {} } = await chrome.storage.local.get(["history", "selfViews"]);
      const byEmail = computeTracking(history, events, selfViews);
      await chrome.storage.local.set({ tracking: { syncedAt: Date.now(), byEmail } });
      // The public page is a convenience; a failed push never fails the sync.
      await pushReport(history, byEmail).catch(() => {});
      // Same for the suppression exchange with server-side sending.
      await syncServerContacted(history).catch(() => {});

      const rows = Object.values(byEmail);
      return {
        ok: true,
        tracked: rows.length,
        opened: rows.filter((r) => r.openedAt).length,
        unsubscribed: rows.filter((r) => r.unsubscribedAt).length,
      };
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}

// The Gmail tab says "history changed" after every send. Sends come every few
// seconds, so this waits for a quiet moment and syncs once rather than per send
// — the stats page is then current within seconds of a run, not ten minutes.
let historyTimer = null;
function historyChanged() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => syncTracking().catch(() => {}), 5000);
}

// Built into every copy so the team's extensions can read the dashboard's
// settings and claim leads with nothing to configure. The server holds the
// same value as TEAM_KEY.
const TEAM_KEY = "e6fc3f799b9b93fd1c1f6da86b023da4a7e8d453d2bd095a";
const teamFetch = (path, init = {}) =>
  fetch(`${TRACKER}${path}`, { ...init, cache: "no-store",
    headers: { "content-type": "application/json", "x-team-key": TEAM_KEY, ...(init.headers || {}) } });

// Templates, limits and the team list from the dashboard, kept in storage for
// the Gmail tabs to apply.
async function syncConfig() {
  const res = await teamFetch("/api/config");
  if (!res.ok) throw new Error(`dashboard returned ${res.status}`);
  const cfg = await res.json();
  await chrome.storage.local.set({ remoteConfig: cfg });
  return cfg;
}

// The dashboard can also send on its own (server-side, over SMTP). The two
// must never email the same person, so every sync swaps lists both ways:
// this browser's history and do-not-email list go up, and the addresses the
// server has emailed come down into `serverContacted`, which the Gmail tab's
// send loop skips. The upload is skipped when nothing changed in 12 hours.
async function syncServerContacted(history) {
  const { suppressed = [], contactedPush = {} } = await chrome.storage.local.get(["suppressed", "contactedPush"]);
  const mine = [...new Set([...Object.keys(history || {}), ...(Array.isArray(suppressed) ? suppressed : [])]
    .map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))];
  if (mine.length !== contactedPush.count || Date.now() - (contactedPush.at || 0) > 12 * 3600000) {
    const up = await teamFetch("/api/leads", { method: "POST", body: JSON.stringify({ contacted: mine }) });
    if (up.ok) await chrome.storage.local.set({ contactedPush: { count: mine.length, at: Date.now() } });
  }
  const res = await teamFetch("/api/leads?contacted=1");
  if (!res.ok) return;
  const d = await res.json();
  if (Array.isArray(d.contacted)) {
    await chrome.storage.local.set({ serverContacted: d.contacted.map((e) => String(e).toLowerCase()), serverContactedAt: Date.now() });
  }
}

async function claimLeads(account, count) {
  const res = await teamFetch("/api/leads", { method: "POST", body: JSON.stringify({ claim: count, account }) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || `dashboard returned ${res.status}`);
  return d;
}

const ALARM = "tracking-sync";

function startTracking() {
  installRules().catch(() => {});
  syncConfig().catch(() => {});
  chrome.alarms.create(ALARM, { periodInMinutes: 10, delayInMinutes: 1 });
  syncTracking().catch(() => {});
}

chrome.runtime.onInstalled.addListener(startTracking);
chrome.runtime.onStartup.addListener(startTracking);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== ALARM) return;
  syncTracking().catch(() => {});
  syncConfig().catch(() => {});
});

// Walks every signed-in Gmail account and pulls its Sent mail, replies and
// bounces into the shared history — so the dashboard shows everything sent from
// every address without anyone opening each mailbox and clicking Import.
//
// Gmail numbers signed-in accounts /mail/u/0/, /mail/u/1/ and so on, with no
// index anywhere of how many there are. Probing upward and stopping after two
// consecutive misses is the only way to enumerate them, and is cheap: a signed
// -out index redirects and reports no address.
const MAX_ACCOUNT_PROBE = 6;

// Addresses this Gmail account can send *as*. Mail sent through a "Send mail
// as" alias is stored in Gmail's Sent folder, not on the alias's own mail
// server, so these have to be searched explicitly or that outreach is invisible.
// Overridable from storage; these are the defaults because they are the
// addresses the outreach actually went out from.
// Business outreach only. Searching by domain rather than by exact address
// catches every alias on these domains — dawit@, michaelg@, any future one —
// while never matching the personal gmail.com account the aliases are attached
// to. An earlier version ran an unfiltered in:sent pass as a safety net, which
// worked by hoovering up private correspondence; that is not a safety net, it
// is a privacy problem.
const DEFAULT_DOMAINS = [
  "zemenaytech.com",
  "africanrecruitment.com",
];

// Known exact addresses, used after the domain sweep purely to attribute each
// message to the specific alias that sent it.
const DEFAULT_ALIASES = [
  "dawit@africanrecruitment.com",
  "michaelg@zemenaytech.com",
  "dawit@zemenaytech.com",
];

function getSenders() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["sendAliases", "sendDomains"], (d) => {
      resolve({
        domains: (Array.isArray(d.sendDomains) ? d.sendDomains : DEFAULT_DOMAINS).filter(Boolean),
        aliases: (Array.isArray(d.sendAliases) ? d.sendAliases : DEFAULT_ALIASES).filter(Boolean),
      });
    });
  });
}

async function syncAllAccounts({ days = 180, onStep } = {}) {
  const results = [];
  const senders = await getSenders();
  const existing = await findGmailTabs();
  const opened = [];
  let misses = 0;

  for (let idx = 0; idx < MAX_ACCOUNT_PROBE && misses < 2; idx++) {
    let tab = existing.find((t) => accountIndex(t.url) === idx);
    let temporary = false;

    if (!tab) {
      // Background tab: the sync should not steal the window while it works.
      tab = await chrome.tabs.create({
        url: `https://mail.google.com/mail/u/${idx}/#inbox`,
        active: false,
      });
      await waitForTabComplete(tab.id);
      await sleep(3500); // Gmail keeps building well past the load event
      temporary = true;
      opened.push(tab.id);
    }

    const pong = await ensureContentScript(tab.id);
    const account = pong && pong.account;
    if (!account) {
      // A signed-out index still cost us a tab. Close it here rather than at
      // the end of the loop body, which this path skips.
      if (temporary) { try { await chrome.tabs.remove(tab.id); } catch {} }
      misses++;
      continue;
    }
    misses = 0;

    onStep?.({ phase: "import", account });
    const imported = await ask(tab.id, { type: "RUN_IMPORT", days, ...senders });
    onStep?.({ phase: "scan", account });
    const scanned = await ask(tab.id, { type: "RUN_SCAN", days: 90 });

    results.push({
      account,
      imported: imported?.imported || 0,
      updated: imported?.updated || 0,
      // Per-identity counts make it obvious whether the alias mail was found,
      // rather than leaving a zero total to be interpreted.
      byIdentity: imported?.byIdentity || {},
      replies: scanned?.replies || 0,
      bounces: scanned?.bounces || 0,
      error: imported?.error || scanned?.error || null,
    });

    // Only close what this sync opened; a tab the user had is left as found.
    if (temporary) { try { await chrome.tabs.remove(tab.id); } catch {} }
  }

  await chrome.storage.local.set({ lastSyncAt: Date.now() });
  return { accounts: results };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SYNC_CONFIG") {
    syncConfig().then((c) => sendResponse({ ok: true, version: c.version }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === "CLAIM_LEADS") {
    claimLeads(msg.account, msg.count).then(sendResponse)
      .catch((err) => sendResponse({ error: err.message || String(err) }));
    return true;
  }
  if (msg.type === "HISTORY_CHANGED") {
    historyChanged();
    return false;
  }
  if (msg.type === "SYNC_TRACKING") {
    syncTracking()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (msg.type === "GET_ACCOUNT") {
    getAccount().then(sendResponse);
    return true;
  }
  if (msg.type === "SYNC_ALL") {
    syncAllAccounts({ days: msg.days || 180 })
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (msg.type === "OPEN_PANEL") {
    openPanel().then(sendResponse);
    return true;
  }
  return false;
});

// There is no popup: the toolbar icon opens the panel in the Gmail tab you are
// looking at, whichever account that is.
chrome.action.onClicked.addListener(() => openPanel());

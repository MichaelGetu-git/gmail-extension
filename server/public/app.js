/* Zemenay Outreach dashboard. Plain JS + self-hosted Chart.js, no build step.
   Auth: the admin password (ADMIN_PASSWORD on Vercel) is kept in sessionStorage
   for this tab only and sent as x-admin-password, exactly as _auth.js expects. */
'use strict';
const $ = (id) => document.getElementById(id);
const fmt = (v) => (Number(v) || 0).toLocaleString('en-GB');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rate = (a, b) => (b ? a / b : null);
const pctTxt = (r, d = 1) => (r == null ? '—' : `${(r * 100).toFixed(d)}%`);
const TZ = 'Africa/Nairobi';
const when = (ms) => ms ? new Date(ms).toLocaleString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' EAT' : '—';
const clock = (ms) => ms ? new Date(ms).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '—';
const eatMin = (ms) => Math.floor(((ms + 3 * 3600000) % 86400000) / 60000);
const toMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '')); return m ? +m[1] * 60 + +m[2] : NaN; };
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const dayLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayLong = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- colours (one place, used everywhere)
const TPL = [['callcenter', 'Call centre'], ['callcenter-generic', 'Call centre (no hours)'], ['tech', 'Tech & talent'], ['va', 'Virtual assistants'], ['followup', 'Follow-up']];
const TPL_LABEL = { ...Object.fromEntries(TPL), work: 'Work lane template', hot: 'Hot lane template', 'work-followup': 'Work lane follow-up', 'hot-followup': 'Hot lane follow-up' };
const LANE_LABEL = { regular: 'Regular', work: 'Work', hot: 'Hot' };
const LANE_PILL = { regular: '', work: 'info', hot: 'warn' };
const lanePill = (l) => (l && l !== 'regular' ? `<span class="pill ${LANE_PILL[l]}">${LANE_LABEL[l]}</span>` : '');
const PLAIN_NOTE = 'Plain text: a text/plain email only. No HTML, no footer, no logo or open-tracking pixel, no tracked or unsubscribe link, no List-Unsubscribe header. Opens are not tracked for these emails; replies, bounces and the follow-up stop rules still work.';
const SEG_LABEL = { callcenter: 'Call centre', tech: 'Tech & talent', va: 'Virtual assistants', other: 'Other', ...TPL_LABEL };
const SEG_COLOR = { callcenter: '#6366f1', 'callcenter-generic': '#a5b4fc', tech: '#06b6d4', va: '#10b981', followup: '#f59e0b', other: '#94a3b8' };
const segColor = (s) => SEG_COLOR[s] || '#94a3b8';
const ACCT_PALETTE = ['#2563eb', '#db2777', '#059669', '#ea580c', '#7c3aed', '#0891b2', '#ca8a04', '#475569'];
const EXT_COLOR = '#cbd5e1';
let ACCOUNTS = [];
const acctColor = (a) => { const i = ACCOUNTS.indexOf(a); if (i >= 0) return ACCT_PALETTE[i % ACCT_PALETTE.length];
  let h = 0; for (const c of String(a)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return ACCT_PALETTE[h % ACCT_PALETTE.length]; };
// The part before the @, unless another account shares it (dawit@a.com, dawit@b.com): then the whole address.
const short = (a) => {
  const s = String(a || '').split('@')[0];
  return ACCOUNTS.filter((x) => x.split('@')[0] === s).length > 1 ? String(a) : s;
};
const M = { sent: '#4f46e5', opened: '#f97316', replied: '#10b981', bounced: '#ef4444', unsub: '#a855f7' };
// Personalised vs standard: a validated pair, always shown with a text label.
const PZ = '#7c3aed', STD = '#0d9488';
const pzPill = (on) => (on ? ' <span class="pill pz">personalised</span>' : '');
const STATUS_COLOR = { sent: '#10b981', 'dry-run': '#6366f1', skipped: '#f59e0b', deferred: '#fcd34d', failed: '#ef4444', bounced: '#991b1b',
  sending: '#2563eb', replied: '#0ea5e9', 'auto-reply': '#a5b4fc', test: '#94a3b8', 'test (dry-run)': '#cbd5e1', 'test failed': '#fca5a5' };
const statusColor = (s) => STATUS_COLOR[s] || '#94a3b8';
const pillFor = (s) => (s === 'sent' || s === 'replied' ? 'ok' : /fail|bounce/.test(s) ? 'bad' : ['skipped', 'deferred'].includes(s) ? 'warn' : s === 'planned' || s === 'sending' ? 'info' : '');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ICON = {
  chart: '<svg viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg>',
  inbox: '<svg viewBox="0 0 24 24"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="m6 4 14 8-14 8z"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
};
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 4200); }

// ---------------------------------------------------------------- charts
let QUIET = false;
const CH = {};
if (window.Chart) {
  Object.assign(Chart.defaults, { color: '#64748b', borderColor: '#eef0f4', maintainAspectRatio: false, responsive: true });
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 11.5;
  Chart.defaults.plugins.legend.display = false;
  Object.assign(Chart.defaults.plugins.tooltip, { backgroundColor: '#0f172a', padding: 10, cornerRadius: 8, boxPadding: 4, usePointStyle: true,
    titleFont: { weight: '600' }, titleMarginBottom: 6 });
  Chart.defaults.elements.bar.borderRadius = 4;
  Chart.defaults.elements.line.borderWidth = 2;
}
const anim = () => (QUIET ? false : { duration: 450 });
function killChart(id) { if (CH[id]) { CH[id].destroy(); delete CH[id]; } }
function killPrefix(p) { for (const id of Object.keys(CH)) if (id.startsWith(p)) killChart(id); }
function chart(id, cfg) {
  const host = $(id); if (!host) return null;
  killChart(id);
  if (!window.Chart) { host.innerHTML = '<div class="empty"><b>Charts unavailable</b><span>The chart library did not load.</span></div>'; return null; }
  host.innerHTML = '<canvas></canvas>';
  cfg.options = { animation: anim(), ...(cfg.options || {}) };
  CH[id] = new Chart(host.firstChild, cfg);
  return CH[id];
}
function empty(id, title, text, icon = 'chart') { killChart(id); const h = $(id); if (h) h.innerHTML = `<div class="empty">${ICON[icon]}<b>${esc(title)}</b><span>${text}</span></div>`; }
const fade = (color) => (ctx) => {
  const { chart: c } = ctx; const area = c.chartArea;
  if (!area) return hexA(color, 0.12);
  const g = c.ctx.createLinearGradient(0, area.top, 0, area.bottom);
  g.addColorStop(0, hexA(color, 0.22)); g.addColorStop(1, hexA(color, 0)); return g;
};
function spark(id, data, color) {
  return chart(id, { type: 'line',
    data: { labels: data.map((_, i) => i), datasets: [{ data, borderColor: color, borderWidth: 1.8, pointRadius: 0, tension: 0.35, fill: 'origin', backgroundColor: fade(color) }] },
    options: { events: [], plugins: { tooltip: { enabled: false } }, layout: { padding: 2 },
      scales: { x: { display: false }, y: { display: false, beginAtZero: true, suggestedMax: 1 } } } });
}
function gauge(id, r, of) {
  const max = 0.1, v = Math.min(r || 0, max);
  const col = !of ? '#e2e8f0' : r >= 0.05 ? '#ef4444' : r >= 0.02 ? '#f59e0b' : '#10b981';
  return chart(id, { type: 'doughnut',
    data: { datasets: [{ data: of ? [v, max - v || 0.0001] : [0, 1], backgroundColor: [col, '#eef0f4'], borderWidth: 0, borderRadius: 4 }] },
    options: { rotation: -90, circumference: 180, cutout: '74%', events: [], plugins: { tooltip: { enabled: false } } } });
}
const axisX = (extra = {}) => ({ grid: { display: false }, border: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 14 }, ...extra });
const axisY = (extra = {}) => ({ beginAtZero: true, border: { display: false }, grid: { color: '#f1f3f7' }, ticks: { precision: 0, padding: 6 }, ...extra });
const legend = (id, items) => { $(id).innerHTML = items.map(([c, l]) => `<span><i style="background:${c}"></i>${esc(l)}</span>`).join(''); };
function wireTips(root) {
  const tip = $('tip');
  root.querySelectorAll('[data-tip]').forEach((el) => {
    el.addEventListener('mousemove', (e) => { tip.innerHTML = el.dataset.tip; tip.style.opacity = 1;
      tip.style.left = Math.min(e.clientX + 14, innerWidth - 290) + 'px'; tip.style.top = e.clientY + 14 + 'px'; });
    el.addEventListener('mouseleave', () => { tip.style.opacity = 0; });
  });
}

// ---------------------------------------------------------------- auth + api
let PW = sessionStorage.getItem('adminPw') || '';
let SERVER = null;          // {adminConfigured, database}
class AuthError extends Error {}
async function api(action, extra = {}) {
  const res = await fetch('/api/admin', { method: 'POST', cache: 'no-store',
    headers: { 'content-type': 'application/json', 'x-admin-password': PW }, body: JSON.stringify({ action, ...extra }) });
  const d = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AuthError(d.error || 'not signed in');
  if (!res.ok) throw new Error(d.error || `error ${res.status}`);
  return d;
}
async function getConfig() {
  const res = await fetch('/api/config', { cache: 'no-store', headers: { 'x-admin-password': PW } });
  const d = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AuthError(d.error || 'not signed in');
  if (!res.ok) throw new Error(d.error || res.status);
  return d;
}
async function getReport() {
  try { const r = await fetch('/api/report', { cache: 'no-store' }); if (!r.ok) return null; const d = await r.json(); return d.sources ? d : null; }
  catch { return null; }
}
async function probe() {
  try { const r = await fetch('/api/admin', { cache: 'no-store' }); return await r.json(); } catch { return null; }
}
function handleErr(e) {
  if (e instanceof AuthError) return signOut('Your session ended (the password may have changed). Sign in again.');
  console.warn(e); toast(e.message || String(e));
}

function showLogin(opts = {}) {
  $('boot').classList.add('hidden'); $('shell').classList.add('hidden'); $('login').classList.remove('hidden');
  const note = $('loginNote'), err = $('loginErr'), pw = $('pw'), go = $('pwGo');
  note.classList.add('hidden'); err.classList.add('hidden'); pw.classList.remove('invalid');
  pw.disabled = false; go.disabled = false;
  if (!SERVER) {
    note.innerHTML = `${ICON.alert}<div><b>Can't reach the server</b>Check your connection and reload the page.</div>`; note.classList.remove('hidden');
  } else if (!SERVER.database) {
    note.innerHTML = `${ICON.alert}<div><b>No database connected</b>The Vercel project has no Upstash Redis connected, so the dashboard can't load anything.</div>`; note.classList.remove('hidden');
  } else if (!SERVER.adminConfigured) {
    note.innerHTML = `${ICON.lock}<div><b>The admin password isn't configured on the server</b>Set <code>ADMIN_PASSWORD</code> in the Vercel project's environment variables and redeploy. Sign-in is disabled until then.</div>`;
    note.classList.remove('hidden'); pw.disabled = true; go.disabled = true;
  }
  if (opts.error) { err.innerHTML = `${ICON.alert}<span>${esc(opts.error)}</span>`; err.classList.remove('hidden'); }
  if (opts.info) { note.innerHTML = `${ICON.alert}<div>${esc(opts.info)}</div>`; note.classList.remove('hidden'); }
  if (!pw.disabled) setTimeout(() => pw.focus(), 30);
}
$('pwShow').onclick = () => { const p = $('pw'); const show = p.type === 'password'; p.type = show ? 'text' : 'password'; $('pwShow').textContent = show ? 'Hide' : 'Show'; };
$('pw').addEventListener('input', () => { $('pw').classList.remove('invalid'); $('loginErr').classList.add('hidden'); });
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = $('pwGo'), pw = $('pw');
  if (!pw.value) { pw.classList.add('invalid'); return; }
  go.disabled = true; go.textContent = 'Signing in…';
  PW = pw.value;
  try {
    const ov = await api('overview');
    sessionStorage.setItem('adminPw', PW); pw.value = '';
    enterApp(ov);
  } catch (err) {
    PW = '';
    const notSet = /not set/i.test(err.message);
    if (notSet) { SERVER = { ...(SERVER || {}), database: true, adminConfigured: false }; showLogin(); }
    else {
      showLogin({ error: err instanceof AuthError ? "That password isn't right. Try again." : `Couldn't sign in: ${err.message}` });
      const card = $('loginForm'); card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
      pw.classList.add('invalid'); pw.select();
    }
  } finally { go.disabled = Boolean(SERVER && !SERVER.adminConfigured); go.textContent = 'Sign in'; }
});
function signOut(info) {
  PW = ''; sessionStorage.removeItem('adminPw');
  for (const id of Object.keys(CH)) killChart(id);
  $('modal').classList.add('hidden');
  showLogin(info ? { info } : {});
}
$('signOut').onclick = () => signOut();

// ---------------------------------------------------------------- shell + routing
const VIEWS = {
  overview: ['Overview', 'Campaign performance for the emails sent from this dashboard.'],
  replies: ['Replies', 'Everyone who answered a dashboard email, newest first. Every inbox is checked for replies every few minutes.'],
  templates: ['Templates', 'Edit, preview and roll back the email templates.'],
  sending: ['Sending', 'Pause controls, accounts, schedule and test sends.'],
  queue: ['Queue', "Planned sends, follow-ups and contacts waiting for a first email."],
  log: ['Send log', 'Every send, skip, failure and reply, with the full email.'],
  contacts: ['Contacts & suppression', 'Upload contacts and manage who is never emailed.'],
  leads: ['Hot leads', 'The Work and Hot lanes: their own leads, queue, accounts and sending options, separate from the main contacts.'],
};
let current = 'overview';
let ov = null, an = null, rep = null;
const loaders = {};
function enterApp(firstOverview) {
  if (firstOverview) { ov = firstOverview; ACCOUNTS = ov.accounts.map((a) => a.account); sideStatus(); }
  $('boot').classList.add('hidden'); $('login').classList.add('hidden'); $('shell').classList.remove('hidden');
  const v = location.hash.slice(1);
  show(VIEWS[v] ? v : 'overview');
  pollReplies();
}
function show(view) {
  current = view;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  for (const k of Object.keys(VIEWS)) $(`v-${k}`).classList.toggle('hidden', k !== view);
  $('vTitle').textContent = VIEWS[view][0]; $('vDesc').textContent = VIEWS[view][1];
  document.title = `${VIEWS[view][0]} · Zemenay Outreach`;
  if (location.hash.slice(1) !== view) history.replaceState(null, '', `#${view}`);
  reload();
}
async function reload(quiet = false) {
  QUIET = quiet;
  const btn = $('refresh'); btn.disabled = true;
  try { await loaders[current](); $('updated').textContent = `Updated ${clock(Date.now())} EAT`; }
  catch (e) { handleErr(e); }
  finally { btn.disabled = false; QUIET = false; }
}
$('nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) show(b.dataset.view); });
window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (VIEWS[v] && v !== current && !$('shell').classList.contains('hidden')) show(v); });
$('refresh').onclick = () => reload();
window.addEventListener('scroll', () => $('topbar').classList.toggle('scrolled', scrollY > 4), { passive: true });
setInterval(() => {
  if ($('shell').classList.contains('hidden') || document.visibilityState !== 'visible' || !$('modal').classList.contains('hidden')) return;
  if (current === 'overview' || current === 'replies') reload(true); else pollReplies();
}, 60000);
function sideStatus() {
  if (!ov) return;
  const s = ov.settings, tickOld = !ov.lastTick || Date.now() - ov.lastTick > 15 * 60000;
  $('sideStatus').innerHTML = `<div class="row1"><span class="dot ${s.paused ? 'bad' : 'ok'}"></span>${s.paused ? 'Sending paused' : s.dryRun ? 'Sending on (dry-run)' : 'Sending on'}</div>
    <div>Last tick ${ov.lastTick ? clock(ov.lastTick) + ' EAT' : 'never'}${tickOld && !s.paused ? ' <span class="pill warn">stale</span>' : ''}</div>
    <div>Replies checked ${inboxesChecked() ? clock(inboxesChecked()) + ' EAT' : 'never'}</div>
    <div>${fmt(ov.queue.queued)} waiting${ov.lanes ? ['work', 'hot'].filter((l) => ov.lanes[l].queued).map((l) => ` · ${fmt(ov.lanes[l].queued)} ${LANE_LABEL[l]}`).join('') : ''} · templates v${ov.configVersion}</div>`;
}
$('mClose').onclick = () => $('modal').classList.add('hidden');
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('modal').classList.add('hidden'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('modal').classList.add('hidden'); });
const untracked = (html) => String(html || '').replace(/https:\/\/[^"]+\/api\/l\?t=[a-z0-9]+/g, '/logo.png');
function mailFrame(html) { const f = document.createElement('iframe'); f.className = 'mail'; f.setAttribute('sandbox', ''); f.srcdoc = `<base target="_blank"><div style="font:14px Arial,sans-serif">${untracked(html)}</div>`; return f; }

// ---------------------------------------------------------------- shared data helpers
function series(days) {
  const ext = (k) => days.map((d) => rep?.byDay?.[d]?.[k] || 0);
  const srv = (k) => days.map((d) => an?.perDay?.[d]?.[k] || 0);
  const add = (a, b) => a.map((v, i) => v + b[i]);
  return { sent: add(ext('sent'), srv('sent')), opened: add(ext('opened'), srv('opened')), replied: add(ext('replied'), srv('replied')),
    bounced: srv('bounced'), unsub: srv('unsubscribed'), srvSent: srv('sent') };
}
const sum = (a, from = 0, to = a.length) => a.slice(from, to).reduce((x, y) => x + y, 0);
// A rate over fewer than 5 sends is noise, so those days are left blank.
function rolling(num, den, w = 7, min = 5) { return num.map((_, i) => { const d = sum(den, Math.max(0, i - w + 1), i + 1); return d >= min ? (sum(num, Math.max(0, i - w + 1), i + 1) / d) * 100 : null; }); }
function delta(cur, prev, { pts = false, invert = false } = {}) {
  if (cur == null || prev == null) return '<span class="delta flat">no data</span>';
  let txt, dir;
  if (pts) { const d = (cur - prev) * 100; dir = Math.abs(d) < 0.05 ? 0 : Math.sign(d); txt = `${d > 0 ? '+' : ''}${d.toFixed(1)} pts`; }
  else if (!prev) { dir = cur ? 1 : 0; txt = cur ? 'new' : '0%'; }
  else { const d = ((cur - prev) / prev) * 100; dir = Math.abs(d) < 0.5 ? 0 : Math.sign(d); txt = `${d > 0 ? '+' : ''}${d.toFixed(0)}%`; }
  const good = invert ? -dir : dir;
  return `<span class="delta ${dir === 0 ? 'flat' : good > 0 ? 'up' : 'down'}">${dir > 0 ? '▲' : dir < 0 ? '▼' : '•'} ${txt}</span>`;
}

// ---------------------------------------------------------------- OVERVIEW
let sendsMode = 'account';
// Rates come from the dashboard's own sends; "Dashboard + extension" adds the
// totals the extension reports. The choice is remembered in this browser.
let srcMode = (() => { try { return localStorage.getItem('ovSrc') === 'all' ? 'all' : 'server'; } catch { return 'server'; } })();
let repAll = null;
loaders.overview = async () => {
  const [o, a, r, pToday, pNext, rl] = await Promise.all([api('overview'), api('analytics'), getReport(),
    api('plan.get', { date: 'today', build: false }), api('plan.get', { date: 'tomorrow', build: false }), api('replies.list', { limit: 8 })]);
  ov = o; an = a; repAll = r; rep = srcMode === 'all' ? r : null; ACCOUNTS = ov.accounts.map((x) => x.account); sideStatus();
  pauseBanner('ovBanner', true);
  replyHealth('ovReplyHealth');
  renderSrcMode();
  renderKpis();
  renderReplies('ovReplies', rl.items, { compact: true });
  renderPersonalisation();
  pollReplies();
  renderSends();
  renderFunnel();
  renderRates();
  renderPipeline();
  accountCards('ovAccounts', 'ov', false);
  const s = ov.settings;
  $('tlCap').textContent = `Planned send times per account, EAT. Accounts start at a random time inside the ${s.windowStart}–${s.windowEnd} window (shaded), then send with ${s.minGapMin}–${s.maxGapMin} minute gaps. No sends after ${s.lateCutoff}.`;
  timelineLegend('tlLegend');
  timeline('ovTimeline', [
    { title: `Today, ${dayLabel(ov.today)}`, plan: pToday.plan, isToday: true, off: !ov.todayIsSendingDay },
    { title: `Next sending day, ${dayLong(pNext.plan.date)}`, plan: pNext.plan },
  ]);
  renderSegPerf();
  renderTplPerf();
};
$('ovPlanBuild').onclick = async () => { try { await api('plan.get', { date: 'tomorrow' }); toast('Next sending day planned'); reload(); } catch (e) { handleErr(e); } };
function renderSrcMode() {
  $('srcMode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.src === srcMode));
  $('ratesCap').textContent = srcMode === 'all'
    ? 'Rolling 7-day rates. Open and reply rates include the extension\'s sends; bounce and unsubscribe rates are dashboard sends only.'
    : 'Rolling 7-day rates for the emails sent from this dashboard.';
}
$('srcMode').onclick = (e) => {
  const b = e.target.closest('button[data-src]'); if (!b || !an) return;
  srcMode = b.dataset.src;
  try { localStorage.setItem('ovSrc', srcMode); } catch { /* private window: just not remembered */ }
  rep = srcMode === 'all' ? repAll : null;
  renderSrcMode(); renderKpis(); renderSends(); renderFunnel(); renderRates(); renderSegPerf();
};
$('ovScan').onclick = () => scanNow($('ovScan'));
$('pzSeeQueue').onclick = () => { qFilterSel = 'personal'; show('queue'); };

// Personalised vs standard: reply and open rates side by side. The standard
// group is the same period (first emailed since the first personalised email)
// when there is one, so both saw the same season, list quality and accounts.
function renderPersonalisation() {
  const P = an.personalisation;
  if (!P || P.since == null || !P.personal.contacts) {
    $('pzCap').textContent = 'Contacts whose first email carried their own subject line or opening line, against standard emails sent over the same period.';
    $('pzBody').innerHTML = `<div class="empty" style="min-height:140px">${ICON.chart}<b>No personalised emails sent yet</b><span>Once contacts with their own subject or opening line go out, their reply and open rates show here next to standard emails from the same period.</span></div>`;
    return;
  }
  const same = P.standardSamePeriod.contacts > 0, S = same ? P.standardSamePeriod : P.standard;
  const rr = (g) => rate(g.replied, g.contacts), or = (g) => rate(g.opened, g.tracked);
  $('pzCap').textContent = `First emails with their own subject or opening line, since ${when(P.since)}, against ${same ? 'standard emails sent over the same period' : 'all standard emails (none sent since then)'}. Replies are exact; opens are approximate.`;
  const tile = (label, color, g) => `<div class="pz-tile"><div class="k"><i style="background:${color}"></i>${label}</div>
    <div class="v">${pctTxt(rr(g))}<small>reply rate</small></div>
    <span class="sub">${fmt(g.contacts)} contact${g.contacts === 1 ? '' : 's'} · ${fmt(g.replied)} repl${g.replied === 1 ? 'y' : 'ies'} · ${g.tracked ? `${pctTxt(or(g), 0)} opened` : 'opens not tracked'}${g.autoReplied ? ` · ${fmt(g.autoReplied)} out-of-office` : ''}</span></div>`;
  const bars = (title, pv, sv) => {
    const m = Math.max(pv ?? 0, sv ?? 0) || 1;
    const row = (label, v, c) => `<div class="pz-row"><span>${label}</span><div class="track"><div style="width:${(((v ?? 0) / m) * 100).toFixed(1)}%;background:${c}"></div></div><b>${pctTxt(v)}</b></div>`;
    return `<div class="pz-metric"><div class="h">${title} ${pv != null && sv != null ? delta(pv, sv, { pts: true }) : ''}</div>${row('Personalised', pv, PZ)}${row('Standard', sv, STD)}</div>`;
  };
  const small = P.personal.contacts < 30 || S.contacts < 30;
  $('pzBody').innerHTML = `<div class="pz-tiles">${tile('Personalised', PZ, P.personal)}${tile(same ? 'Standard, same period' : 'Standard', STD, S)}</div>
    <div class="pz-bars">${bars('Reply rate', rr(P.personal), rr(S))}${bars('Open rate', or(P.personal), or(S))}</div>
    ${small ? `<p class="cap pz-note">Early days: ${fmt(P.personal.contacts)} personalised and ${fmt(S.contacts)} standard contacts so far. Treat a difference as a hint until both groups have 30 or more.</p>` : ''}`;
}
$('ovAllReplies').onclick = () => show('replies');
$('sendsMode').onclick = (e) => { const b = e.target.closest('button[data-mode]'); if (!b) return; sendsMode = b.dataset.mode;
  $('sendsMode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); renderSends(); };

function pauseBanner(id, compact) {
  const s = ov.settings;
  const missing = Object.entries(ov.env.passwords).filter(([, p]) => !p.set).map(([a]) => a);
  $(id).innerHTML = s.paused
    ? `<div class="banner paused"><div class="ic">${ICON.pause}</div><div><b>Server sending is paused</b><span>Nothing is sent from the server until you unpause it${missing.length ? `. ${missing.length} of ${ACCOUNTS.length} accounts have no app password yet` : ''}.</span></div><div class="spacer"></div>
       ${compact ? '<button class="btn small" data-go="sending">Sending controls</button>' : '<button class="btn primary" id="unpause">Unpause sending</button>'}</div>`
    : `<div class="banner live"><div class="ic">${ICON.play}</div><div><b>Server sending is on${s.dryRun ? ' (dry-run)' : ''}</b><span>${s.dryRun ? 'Emails are rendered and logged, nothing actually leaves.' : `Up to ${s.perAccountCap} emails per account per sending day.`}</span></div><div class="spacer"></div>
       ${compact ? '<button class="btn small" data-go="sending">Sending controls</button>' : '<button class="btn danger" id="pauseAll">Pause all sending</button>'}</div>`;
  $(id).querySelector('[data-go]')?.addEventListener('click', () => show('sending'));
}

function renderKpis() {
  const days = an.days, S = series(days), n = days.length;
  const w = (arr, back) => sum(arr, n - 7 * (back + 1), n - 7 * back);
  const cur = { sent: w(S.sent, 0), opened: w(S.opened, 0), replied: w(S.replied, 0), bounced: w(S.bounced, 0), unsub: w(S.unsub, 0), srv: w(S.srvSent, 0) };
  const prev = { sent: w(S.sent, 1), opened: w(S.opened, 1), replied: w(S.replied, 1), bounced: w(S.bounced, 1), unsub: w(S.unsub, 1), srv: w(S.srvSent, 1) };
  const T = an.totals, R = rep || {};
  const contacts = (R.contacts || 0) + T.contacts, emails = (R.emails || 0) + T.emails;
  const tracked = (R.tracked || 0) + (T.trackedContacts ?? T.contacts), opened = (R.opened || 0) + T.openedContacts;   // plain-text sends can't register opens
  const replied = (R.replied || 0) + T.replied, bounced = (R.bounced || 0) + T.bounced, unsub = (R.unsubscribed || 0) + T.unsubscribed;
  const plan = ov.todayPlan, planned = plan.total, done = plan.byStatus.sent || 0;
  const cards = [
    { k: 'Emails sent', c: M.sent, v: fmt(emails), d: delta(cur.sent, prev.sent), f: rep ? `${fmt(R.emails || 0)} ext · ${fmt(T.emails)} dashboard` : `to ${fmt(T.contacts)} contacts`, spark: S.sent },
    { k: 'Open rate', c: M.opened, v: pctTxt(rate(opened, tracked), 0), d: delta(rate(cur.opened, cur.sent), rate(prev.opened, prev.sent), { pts: true }), f: `${fmt(opened)} of ${fmt(tracked)} opened`, spark: S.opened },
    { k: 'Reply rate', c: M.replied, v: pctTxt(rate(replied, contacts)), d: delta(rate(cur.replied, cur.sent), rate(prev.replied, prev.sent), { pts: true }), f: `${fmt(replied)} replied${T.autoReplied ? ` · ${fmt(T.autoReplied)} out-of-office not counted` : ''}`, spark: S.replied },
    { k: 'Bounce rate', c: M.bounced, v: pctTxt(rate(bounced, contacts)), d: delta(rate(cur.bounced, cur.srv), rate(prev.bounced, prev.srv), { pts: true, invert: true }), f: `${fmt(bounced)} contacts`, spark: S.bounced },
    { k: 'Unsubscribed', c: M.unsub, v: fmt(unsub), d: delta(cur.unsub, prev.unsub, { invert: true }), f: 'never emailed again', spark: S.unsub },
    { k: 'Waiting in queue', c: '#0ea5e9', v: fmt(ov.queue.queued), d: `<span class="delta flat">${fmt(ov.queue.followUpCandidates)}</span>`, f: planned ? `${done} of ${planned} sent today` : 'nothing planned today', progress: planned ? done / planned : 0 },
  ];
  killPrefix('kp-');
  $('kpis').innerHTML = cards.map((c, i) => `<div class="card kpi"><div class="k"><i style="background:${c.c}"></i>${c.k}</div><div class="v">${c.v}</div>
    <div class="foot">${c.d}<span>${c.spark ? 'vs prior 7d' : 'in follow-up'}</span></div><div class="note2">${esc(c.f)}</div>
    ${c.spark ? `<div class="spark" id="kp-${i}"></div>` : `<div class="spark" style="display:flex;align-items:flex-end;padding:0 4px 6px"><div class="progress" style="flex:1"><div style="width:${(c.progress * 100).toFixed(0)}%;background:${c.c}"></div></div></div>`}</div>`).join('');
  cards.forEach((c, i) => { if (c.spark) spark(`kp-${i}`, c.spark, c.c); });
}

function renderSends() {
  const days = an.days, labels = days.map(dayLabel);
  const extSent = days.map((d) => rep?.byDay?.[d]?.sent || 0);
  let sets;
  if (sendsMode === 'account') {
    const accts = [...new Set([...ACCOUNTS, ...days.flatMap((d) => Object.keys(an.byAccount[d] || {}))])];
    sets = accts.map((a) => ({ label: a, data: days.map((d) => an.byAccount[d]?.[a] || 0), backgroundColor: acctColor(a) }));
  } else {
    const segs = [...new Set([...TPL.map(([id]) => id), ...days.flatMap((d) => Object.keys(an.bySegment[d] || {}))])];
    sets = segs.map((s) => ({ label: SEG_LABEL[s] || s, data: days.map((d) => an.bySegment[d]?.[s] || 0), backgroundColor: segColor(s) }));
  }
  if (rep) sets.push({ label: sendsMode === 'account' ? 'Extension (all accounts)' : 'Extension (segment not reported)', data: extSent, backgroundColor: EXT_COLOR });
  legend('sendsLegend', sets.map((s) => [s.backgroundColor, sendsMode === 'account' && s.label.includes('@') ? short(s.label) : s.label]));
  if (!sets.some((s) => s.data.some(Boolean))) return empty('chSends', 'No sends in the last 30 days', 'Emails sent by the extension or the server show up here, stacked by account or segment.');
  chart('chSends', { type: 'bar', data: { labels, datasets: sets.map((s) => ({ ...s, stack: 's', borderRadius: 3, maxBarThickness: 22 })) },
    options: { interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { filter: (i) => i.raw > 0, callbacks: { footer: (items) => `Total ${items.reduce((x, i) => x + i.raw, 0)}` } } },
      scales: { x: axisX({ stacked: true }), y: axisY({ stacked: true }) } } });
}

function renderFunnel() {
  const T = an.totals, R = rep || {};
  const contacts = (R.contacts || 0) + T.contacts, opened = (R.opened || 0) + T.openedContacts, replied = (R.replied || 0) + T.replied;
  if (!contacts) { $('funnel').innerHTML = `<div class="empty" style="min-height:220px">${ICON.chart}<b>No contacts emailed yet</b><span>The funnel fills in as emails go out.</span></div>`; return; }
  const steps = [['Emailed', contacts, M.sent, ''], ['Opened', opened, M.opened, `${pctTxt(rate(opened, contacts), 0)} of emailed`], ['Replied', replied, M.replied, `${pctTxt(rate(replied, contacts))} of emailed · ${pctTxt(rate(replied, opened))} of opened`]];
  $('funnel').innerHTML = `<div class="funnel">${steps.map(([l, v, c, conv]) => `<div class="step"><div class="top"><span>${l}</span><b>${fmt(v)}</b></div>
    <div class="bar"><div style="width:${Math.max(1, (v / contacts) * 100).toFixed(1)}%;background:linear-gradient(90deg, ${c}, ${hexA(c, 0.75)})"></div></div>${conv ? `<div class="conv">${conv}</div>` : ''}</div>`).join('')}</div>
    <p class="cap" style="margin:16px 0 0">Opens are only measurable where the logo loads; replies are exact.</p>`;
}

function renderRates() {
  const days = an.days, S = series(days);
  const lines = [['Open rate', rolling(S.opened, S.sent), M.opened], ['Reply rate', rolling(S.replied, S.sent), M.replied],
    ['Bounce rate', rolling(S.bounced, S.srvSent), M.bounced], ['Unsubscribe rate', rolling(S.unsub, S.srvSent), M.unsub]];
  legend('ratesLegend', lines.map(([l, , c]) => [c, l]));
  if (!lines.some(([, d]) => d.some((v) => v != null))) return empty('chRates', 'No rates yet', 'Rates appear once emails have been sent in the last 30 days.');
  chart('chRates', { type: 'line', data: { labels: days.map(dayLabel), datasets: lines.map(([label, data, c], i) => ({ label, data, borderColor: c, backgroundColor: c,
    pointRadius: 0, pointHoverRadius: 4, tension: 0.35, spanGaps: true, borderDash: i >= 2 ? [5, 4] : [] })) },
    options: { interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { label: (i) => ` ${i.dataset.label}: ${i.raw == null ? '—' : i.raw.toFixed(1) + '%'}` } } },
      scales: { x: axisX(), y: axisY({ ticks: { callback: (v) => `${v}%`, padding: 6 }, suggestedMax: 10 }) } } });
}

function renderPipeline() {
  const p = an.pipeline, max = an.maxTouches || 3;
  const stages = Array.from({ length: max }, (_, i) => i + 1).map((n) => [n < max ? `At touch ${n}` : `Touch ${n} (last)`, n < max ? p.touch[n] || 0 : p.finished || 0]);
  const top = Math.max(1, ...stages.map(([, v]) => v));
  const colors = ['#6366f1', '#8b5cf6', '#a855f7', '#c084fc', '#d8b4fe'];
  const today = an.today;
  const next7 = Array.from({ length: 7 }, (_, i) => { const d = new Date(Date.parse(`${today}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10); return d; });
  $('pipeline').innerHTML = `<div class="pipe" style="grid-template-columns:repeat(${Math.min(max, 3)},1fr)">${stages.slice(0, 3).map(([l, v], i) => `<div class="st"><span>${l}</span><b>${fmt(v)}</b><div class="bar" style="width:${Math.max(6, (v / top) * 100)}%;background:${colors[i]}"></div></div>`).join('')}</div>
    <div class="duebox"><b>${fmt(p.dueThisWeek)}</b><span>follow-ups due in the next 7 days<br><span class="sub">after ${an.followUpDays} days without a reply</span></span></div>
    <div class="chart" style="height:110px" id="chDue"></div>
    <div class="minirow"><span>Stopped: ${fmt(p.replied)} replied · ${fmt(p.bounced)} bounced · ${fmt(p.unsubscribed)} unsubscribed</span></div>`;
  const data = next7.map((d) => p.dueByDay[d] || 0);
  if (!data.some(Boolean)) empty('chDue', 'Nothing due this week', '', 'clock');
  else chart('chDue', { type: 'bar', data: { labels: next7.map((d) => DAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]), datasets: [{ label: 'Going out', data, backgroundColor: '#a78bfa', maxBarThickness: 18 }] },
    options: { scales: { x: axisX(), y: axisY({ display: false }) } } });
}

function accountCards(id, prefix, withActions) {
  killPrefix(`${prefix}-`);
  const aStats = Object.fromEntries((an?.accounts || []).map((x) => [x.account, x]));
  const days14 = (an?.days || []).slice(-14);
  $(id).innerHTML = ov.accounts.map((a, i) => {
    const c = acctColor(a.account);
    const state = !a.hasPassword ? ['bad', a.customServer ? 'No password' : 'No app password'] : a.paused ? [a.autoPaused ? 'bad' : 'warn', a.autoPaused ? 'Auto-paused' : 'Paused'] : ['ok', 'Active'];
    const b = a.bounceRate50;
    return `<div class="card acc" style="box-shadow:none">
      <div class="head"><div class="avatar" style="background:${c}">${esc(short(a.account)[0]?.toUpperCase() || '?')}</div>
        <div class="who"><b title="${esc(a.account)}">${esc(a.account)}</b><span>${esc(a.name || 'The Zemenay team')}${a.lane && a.lane !== 'regular' ? ` · ${LANE_LABEL[a.lane]} lane` : ''}${a.plainText ? ' · plain text' : ''}</span></div>
        ${lanePill(a.lane)}<span class="pill ${state[0]}"><i></i>${state[1]}</span></div>
      ${a.paused && a.pauseReason ? `<div class="sub" style="margin-top:-4px">${esc(a.pauseReason)}</div>` : ''}
      <div><div class="capline"><span>Today</span><span><b style="color:var(--text)">${a.sentToday}</b> / ${a.cap}</span></div>
        <div class="progress"><div style="width:${Math.min(100, (a.sentToday / Math.max(1, a.cap)) * 100)}%;background:${c}"></div></div></div>
      <div class="mid"><div><div class="sub" style="margin-bottom:2px">Sends, last 14 days</div><div class="spark" id="${prefix}-sp-${i}"></div></div>
        <div class="gauge" title="Bounce rate over the last ${b.of || 0} sends (auto-pause above 5%)"><div class="gc" id="${prefix}-ga-${i}"></div><div class="gv">${b.of ? pctTxt(b.rate) : '—'}</div><div class="gl">bounce rate</div></div></div>
      <div class="stats"><div><b>${a.sent7d}</b>sent 7d</div><div title="${a.plainText ? 'Plain-text emails carry no open pixel' : ''}"><b>${a.plainText && !a.opened7d ? '—' : a.opened7d}</b>opens</div><div><b>${a.replied7d}</b>replies</div><div><b>${a.bounced7d}</b>bounces</div></div>
      ${withActions ? `<div class="actions">${a.paused ? `<button class="btn small" data-resume="${esc(a.account)}">Resume</button>` : `<button class="btn small" data-pause="${esc(a.account)}">Pause</button>`}
        ${a.hasPassword ? `<button class="btn small ghost" data-scan="${esc(a.account)}">Check inbox</button>` : `<span class="sub mono" title="Vercel env var">${esc(a.passwordVar)}</span>`}</div>` : ''}
    </div>`;
  }).join('') || `<div class="empty">${ICON.inbox}<b>No sending accounts</b><span>Add them under Templates → Signatures.</span></div>`;
  ov.accounts.forEach((a, i) => {
    spark(`${prefix}-sp-${i}`, days14.map((d) => aStats[a.account]?.daily?.[d] || 0), acctColor(a.account));
    gauge(`${prefix}-ga-${i}`, a.bounceRate50.rate, a.bounceRate50.of);
  });
}

function timelineLegend(id) {
  $(id).innerHTML = ACCOUNTS.map((a) => `<span><i style="background:${acctColor(a)}"></i>${esc(short(a))}</span>`).join('') +
    `<span style="margin-left:8px"><svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="#fff" stroke="#64748b" stroke-width="2"/></svg>planned</span>
     <span><svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="#64748b"/></svg>sent</span>
     <span><i style="background:${STATUS_COLOR.skipped};border-radius:50%"></i>skipped / deferred</span>
     <span><i style="background:${STATUS_COLOR.failed};border-radius:50%"></i>failed / bounced</span>
     <span><i style="background:${STATUS_COLOR['dry-run']};border-radius:50%"></i>dry-run</span>`;
}
function timeline(id, blocks) {
  const host = $(id);
  host.innerHTML = blocks.map((b, i) => `<div class="tl-block"><div class="tl-head"><b>${esc(b.title)}</b><span id="${id}-s${i}"></span></div><div class="tl-wrap" id="${id}-b${i}"></div></div>`).join('');
  blocks.forEach((b, i) => lanes(`${id}-b${i}`, `${id}-s${i}`, b));
}
function lanes(hostId, subId, { plan, isToday, off }) {
  const host = $(hostId), sub = $(subId), m = plan.meta, items = plan.items || [], s = ov.settings;
  const counts = items.reduce((o, it) => ((o[it.status] = (o[it.status] || 0) + 1), o), {});
  sub.textContent = !m ? '' : m.offDay ? 'not a sending day' : `${items.length} planned · ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')} · built ${when(m.builtAt)}`;
  if (off && !m) { host.innerHTML = `<div class="empty" style="min-height:90px">${ICON.clock}<b>Not a sending day</b><span>Sending days are set under Sending.</span></div>`; return; }
  if (!m) { host.innerHTML = `<div class="empty" style="min-height:90px">${ICON.clock}<b>Not planned yet</b><span>${isToday ? 'Today is planned by the first tick of the day, once sending is unpaused.' : 'Plans are built the day before or on the day. Use “Plan next sending day” to preview it now.'}</span></div>`; return; }
  if (m.offDay) { host.innerHTML = `<div class="empty" style="min-height:90px">${ICON.clock}<b>Not a sending day</b><span></span></div>`; return; }
  if (!items.length) { host.innerHTML = `<div class="empty" style="min-height:90px">${ICON.inbox}<b>Nothing planned</b><span>The queue was empty or every account was paused when this day was planned.</span></div>`; return; }
  const accts = [...new Set([...ACCOUNTS, ...Object.keys(m.accounts || {}), ...items.map((x) => x.account)])];
  const ws = toMin(m.window?.[0] || s.windowStart), we = toMin(m.window?.[1] || s.windowEnd), cut = toMin(s.lateCutoff);
  const mins = items.map((x) => eatMin(x.at));
  let t0 = Math.floor((Math.min(ws, ...mins) - 15) / 30) * 30, t1 = Math.ceil((Math.max(we + 60, ...mins.map((x) => x + 15))) / 30) * 30;
  t1 = Math.min(t1, Math.max(cut, ...mins) + 30);
  const W = Math.max(640, host.clientWidth || 900), L = 178, R = 18, top = 24, LH = 34, H = top + accts.length * LH + 4;
  const x = (min) => L + ((min - t0) / (t1 - t0)) * (W - L - R);
  const step = t1 - t0 > 420 ? 60 : 30;
  let g = `<rect class="win" x="${x(ws)}" y="${top - 4}" width="${Math.max(2, x(we) - x(ws))}" height="${H - top + 4}" rx="6" opacity=".75"/>`;
  for (let t = t0; t <= t1; t += step) g += `<line class="gl" x1="${x(t)}" x2="${x(t)}" y1="${top - 4}" y2="${H}"/><text class="axis" x="${x(t)}" y="12" text-anchor="middle">${hhmm(t)}</text>`;
  accts.forEach((a, i) => {
    const y = top + i * LH, info = m.accounts?.[a] || {}, n = items.filter((it) => it.account === a).length;
    const note = `${info.lane ? `${LANE_LABEL[info.lane]} · ` : ''}${info.paused ? 'paused' : info.noPassword ? 'no app password' : `${n} planned`}`;
    g += `<rect class="lane-bg" x="0" y="${y + 3}" width="${W}" height="${LH - 6}" rx="8" opacity="${i % 2 ? 0 : 1}"/>`;
    g += `<circle cx="10" cy="${y + LH / 2}" r="4" fill="${acctColor(a)}" style="cursor:default"/><text class="lab" x="22" y="${y + LH / 2 - 2}">${esc(short(a))}</text><text class="axis" x="22" y="${y + LH / 2 + 11}">${esc(note)}</text>`;
    g += `<line x1="${L}" x2="${W - R}" y1="${y + LH / 2}" y2="${y + LH / 2}" stroke="#e7e9ee"/>`;
  });
  if (isToday) { const nm = eatMin(Date.now()); if (nm >= t0 && nm <= t1) g += `<line class="now" x1="${x(nm)}" x2="${x(nm)}" y1="${top - 6}" y2="${H}"/><text class="axis" x="${x(nm) + 4}" y="${H - 4}" style="fill:var(--bad)">now</text>`; }
  for (const it of items) {
    const i = accts.indexOf(it.account), y = top + i * LH + LH / 2, planned = it.status === 'planned';
    const col = it.status === 'planned' || it.status === 'sent' ? acctColor(it.account) : statusColor(it.status);
    const tip = `<b>${clock(it.at)} EAT · ${esc(it.status)}</b><br>${esc(it.email)}${it.company ? `<br>${esc(it.company)}` : ''}<br>${esc(TPL_LABEL[it.template] || it.template)}${it.followUp ? ` · touch ${it.touch}` : ''}${it.reason ? `<br><span style="opacity:.75">${esc(it.reason)}</span>` : ''}`;
    g += planned
      ? `<circle cx="${x(eatMin(it.at))}" cy="${y}" r="5" fill="#fff" stroke="${col}" stroke-width="2.2" data-tip="${esc(tip)}"/>`
      : `<circle cx="${x(eatMin(it.at))}" cy="${y}" r="5.5" fill="${col}" stroke="#fff" stroke-width="1.5" data-tip="${esc(tip)}"/>`;
  }
  host.innerHTML = `<svg class="tl" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Planned send times">${g}</svg>`;
  wireTips(host);
}

function renderSegPerf() {
  const segs = ['callcenter', 'tech', 'va', 'other'];
  const rows = segs.map((s) => {
    const e = rep?.bySegment?.[s] || {}, v = an.segments[s] || {};
    const contacts = (e.contacts || 0) + (v.contacts || 0), tracked = (e.tracked || 0) + (v.contacts || 0);
    return { s, contacts, open: rate((e.opened || 0) + (v.opened || 0), tracked), reply: rate((e.replied || 0) + (v.replied || 0), contacts) };
  }).filter((r) => r.contacts);
  $('segPerfT').innerHTML = rows.length ? '<tr><th>Segment</th><th class="n">Contacts</th><th class="n">Open rate</th><th class="n">Reply rate</th></tr>' + rows.map((r) =>
    `<tr><td style="white-space:nowrap"><span class="dot" style="background:${segColor(r.s)};margin-right:8px"></span>${esc(SEG_LABEL[r.s])}</td><td class="n">${fmt(r.contacts)}</td><td class="n">${pctTxt(r.open)}</td><td class="n">${pctTxt(r.reply)}</td></tr>`).join('') : '';
  if (!rows.length) return empty('chSegPerf', 'Nothing sent yet', 'Open and reply rates per offer appear once emails go out.');
  chart('chSegPerf', { type: 'bar', data: { labels: rows.map((r) => SEG_LABEL[r.s]),
    datasets: [{ label: 'Open rate', data: rows.map((r) => (r.open ?? 0) * 100), backgroundColor: rows.map((r) => hexA(segColor(r.s), 0.35)), maxBarThickness: 34 },
      { label: 'Reply rate', data: rows.map((r) => (r.reply ?? 0) * 100), backgroundColor: rows.map((r) => segColor(r.s)), maxBarThickness: 34 }] },
    options: { interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { title: (i) => `${i[0].label} · ${fmt(rows[i[0].dataIndex].contacts)} contacts`, label: (i) => ` ${i.dataset.label}: ${i.raw.toFixed(1)}%` } },
        legend: { display: true, position: 'bottom', labels: { usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 8, boxHeight: 8, padding: 14,
          generateLabels: () => [{ text: 'Open rate (light)', fillStyle: '#cbd5e1', strokeStyle: '#cbd5e1', pointStyle: 'rectRounded' }, { text: 'Reply rate (solid)', fillStyle: '#475569', strokeStyle: '#475569', pointStyle: 'rectRounded' }] } } },
      scales: { x: axisX(), y: axisY({ ticks: { callback: (v) => `${v}%`, padding: 6 } }) } } });
}

function meter(r, color) { return `<span class="meter"><span class="progress"><div style="width:${Math.min(100, (r || 0) * 100)}%;background:${color}"></div></span><span>${pctTxt(r)}</span></span>`; }
function renderTplPerf() {
  const rows = an.templates;
  if (!rows.length) { $('tplPerf').innerHTML = `<tr><td style="border:0;padding:0"><div class="empty">${ICON.chart}<b>No server sends yet</b><span>Each template version's open and reply rate shows here once the server starts sending. The extension reports totals per offer only (left).</span></div></td></tr>`; return; }
  $('tplPerf').innerHTML = '<tr><th>Template</th><th>Version</th><th class="n">Sent</th><th>Open rate</th><th>Reply rate</th></tr>' +
    rows.map((t) => `<tr><td style="white-space:nowrap"><span class="dot" style="background:${segColor(t.template)};margin-right:8px"></span>${esc(TPL_LABEL[t.template] || t.template)}</td>
      <td style="white-space:nowrap">${t.version == null ? '<span class="sub">earlier</span>' : `v${t.version}${t.version === an.configVersion ? ' <span class="pill info">live</span>' : ''}`}</td>
      <td class="n">${fmt(t.sent)}</td><td>${t.tracked === 0 ? '<span class="sub">not tracked (plain text)</span>' : meter(rate(t.opened, t.tracked ?? t.sent), M.opened)}</td><td>${meter(rate(t.replied, t.sent), M.replied)}</td></tr>`).join('');
}

// ---------------------------------------------------------------- REPLIES
// "New" means newer than the last time the Replies tab was opened in this browser.
const SEEN_KEY = 'repliesSeenAt';
const seenAt = () => { try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; } };
const markSeen = (at) => { try { localStorage.setItem(SEEN_KEY, String(Math.max(seenAt(), at || 0))); } catch { /* not remembered */ } };
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const took = (a, b) => { const h = (a - b) / 3600000; return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`; };
// Opens the sending account's Gmail on a search for the reply.
const gmailLink = (x) => `https://mail.google.com/mail/?authuser=${encodeURIComponent(x.account)}#search/${encodeURIComponent(`from:${x.from || x.email}`)}`;
// The oldest successful inbox check across accounts with an app password.
function inboxesChecked() {
  const a = (ov?.accounts || []).filter((x) => x.hasPassword);
  return a.length && a.every((x) => x.lastImapOkAt) ? Math.min(...a.map((x) => x.lastImapOkAt)) : null;
}

function renderReplies(id, items, { compact = false } = {}) {
  const seen = seenAt();
  if (!items.length) {
    $(id).innerHTML = `<tr><td style="border:0;padding:0"><div class="empty">${ICON.inbox}<b>${compact ? 'No replies yet' : 'Nothing here'}</b><span>${compact ? 'Replies to dashboard emails show up here within minutes of arriving.' : 'No replies match.'}</span></div></td></tr>`;
    return;
  }
  $(id).innerHTML = '<tr><th>Who</th><th>Replied</th><th>To our email</th><th>From account</th><th>Their subject</th><th></th></tr>' + items.map((x) => {
    const isNew = !x.auto && x.at > seen;
    const who = [x.name, x.company].filter(Boolean).join(' · ');
    return `<tr class="${isNew ? 'new' : ''}">
      <td class="who"><b>${esc(who || x.email)}</b><span class="sub">${esc(x.email)}${x.from ? ` · answered from ${esc(x.from)}` : ''}</span></td>
      <td>${esc(when(x.at))}<div class="sub">${esc(ago(x.at))}${isNew ? ' <span class="pill ok">new</span>' : ''}${x.auto ? ' <span class="pill warn">out of office</span>' : ''}</div></td>
      <td><span class="dot" style="background:${segColor(x.template)};margin-right:6px"></span>${esc(TPL_LABEL[x.template] || x.template)}${x.touch > 1 ? ` · touch ${x.touch}` : ''}${pzPill(x.personal)}
        <div class="sub">sent ${esc(when(x.sentAt))}${x.sentAt ? `, answered after ${esc(took(x.at, x.sentAt))}` : ''}</div></td>
      <td><span class="dot" style="background:${acctColor(x.account)};margin-right:6px"></span>${esc(short(x.account))} ${lanePill(x.lane)}</td>
      <td class="subj" title="${esc(x.subject)}">${esc(x.subject || '—')}</td>
      <td><a class="btn small" href="${esc(gmailLink(x))}" target="_blank" rel="noopener">Open in Gmail</a></td></tr>`;
  }).join('');
}

// Replies only arrive through the inbox checks, so say loudly when those stop.
const bannerHtml = (kind, title, text) => `<div class="banner ${kind}"><div class="ic">${ICON.alert}</div><div><b>${esc(title)}</b><span>${esc(text)}</span></div></div>`;
function replyHealth(id) {
  const accts = (ov?.accounts || []).filter((a) => a.hasPassword);
  const failing = accts.filter((a) => a.lastImapError);
  const stale = accts.filter((a) => !a.lastImapError && !(a.lastImapOkAt > Date.now() - 60 * 60000));
  let h = '';
  if (failing.length) {
    h = bannerHtml('bad', `Replies aren't being checked for ${failing.map((a) => short(a.account)).join(', ')}`,
      `${failing[0].lastImapError}. Replies to ${failing.length === 1 ? 'this account' : 'these accounts'} are not recorded until the inbox check works again (has the app password changed?).`);
  } else if (stale.length) {
    const oldest = Math.min(...stale.map((a) => a.lastImapOkAt || 0));
    h = bannerHtml('warn', oldest ? `Inboxes not checked for replies since ${when(oldest)}` : 'Inboxes have never been checked for replies',
      `Replies are picked up each time the scheduler calls /api/tick${ov.lastTick ? ` (last call ${when(ov.lastTick)})` : ' (it has never been called)'}. Click "Check inboxes now", and make sure the scheduler runs all day, not only in sending hours.`);
  }
  $(id).innerHTML = h;
}

let rpKind = 'replies';
loaders.replies = async () => {
  const [o, r] = await Promise.all([api('overview'), api('replies.list', { kind: rpKind, q: $('rpQ').value, limit: 500 })]);
  ov = o; ACCOUNTS = ov.accounts.map((x) => x.account); sideStatus();
  replyHealth('rpHealth');
  renderReplies('rpT', r.items);
  const noun = rpKind === 'auto' ? 'out-of-office auto-replies' : rpKind === 'all' ? 'replies and auto-replies' : `${r.matched === 1 ? 'person' : 'people'} replied`;
  const checked = inboxesChecked();
  $('rpSum').textContent = `${fmt(r.matched)} ${noun}${r.matched > r.items.length ? `, newest ${fmt(r.items.length)} shown` : ''}. Inboxes last checked ${checked ? `${when(checked)} (${ago(checked)})` : 'never'}.`;
  // Seen once shown: this visit still highlights what was new.
  markSeen(Math.max(ov.lastReplyAt || 0, ...r.items.filter((x) => !x.auto).map((x) => x.at)));
  await pollReplies();
};
$('rpKind').onclick = (e) => { const b = e.target.closest('button[data-kind]'); if (!b) return; rpKind = b.dataset.kind;
  $('rpKind').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); reload(); };
let rpTimer = null;
$('rpQ').addEventListener('input', () => { clearTimeout(rpTimer); rpTimer = setTimeout(() => reload(true), 300); });
$('rpScan').onclick = () => scanNow($('rpScan'));

async function scanNow(btn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const r = await api('scan.all');
    if (!r.results.length) toast('No account has an app password yet, so there is no inbox to check.');
    else {
      const bits = [`${r.replies} new repl${r.replies === 1 ? 'y' : 'ies'}`];
      if (r.autoReplies) bits.push(`${r.autoReplies} out-of-office`);
      if (r.bounces) bits.push(`${r.bounces} bounce${r.bounces === 1 ? '' : 's'}`);
      toast(`Checked ${r.results.length} inbox${r.results.length === 1 ? '' : 'es'}: ${bits.join(', ')}${r.failed ? `. ${r.failed} failed, see the banner.` : '.'}`);
    }
    await reload(true);
  } catch (e) { handleErr(e); } finally { btn.disabled = false; btn.textContent = label; }
}

// The badge on "Replies" and a toast when someone answers, from any tab.
let lastNotified = null;
function setBadge(n) { const b = $('repBadge'); b.textContent = n > 99 ? '99+' : String(n); b.classList.toggle('hidden', !n); }
async function pollReplies() {
  try {
    const r = await api('replies.latest');
    const fresh = r.items.filter((x) => !x.auto && x.at > seenAt());
    setBadge(current === 'replies' ? 0 : new Set(fresh.map((x) => x.email)).size);
    if (lastNotified != null && r.lastReplyAt > lastNotified && fresh[0]) toast(`New reply from ${fresh[0].email}`);
    lastNotified = r.lastReplyAt || 0;
  } catch (e) { if (e instanceof AuthError) handleErr(e); }
}

// ---------------------------------------------------------------- TEMPLATES
let cfg = null, seg = 'callcenter', pvIndex = 0, pvTimer = null, dirty = false;
loaders.templates = async () => {
  const [c, a] = await Promise.all([getConfig(), an ? Promise.resolve(an) : api('analytics').catch(() => null)]);
  cfg = c; if (a) an = a; dirty = false;
  if (!ACCOUNTS.length) ACCOUNTS = Object.keys(cfg.senders);
  $('segTabs').innerHTML = TPL.map(([id, l]) => `<button data-seg="${id}" class="${id === seg ? 'on' : ''}"><i style="background:${segColor(id)}"></i>${l}</button>`).join('');
  $('senders').innerHTML = Object.entries(cfg.senders).map(([a, n]) =>
    `<label class="f"><span><span class="dot" style="background:${acctColor(a)};margin-right:6px"></span>${esc(a)}</span><input data-sender="${esc(a)}" value="${esc(n)}" placeholder="Name, e.g. Dawit @ ZemenayTech" aria-label="Name for ${esc(a)}"></label>` +
    `<label class="f"><span>Nickname <code>{{nick_name}}</code></span><input data-nick="${esc(a)}" value="${esc((cfg.nicknames || {})[a] || '')}" placeholder="Optional, e.g. Mike" aria-label="Nickname for ${esc(a)}"></label>`).join('');
  $('cDaily').value = cfg.dailyLimit; $('cFuDays').value = cfg.followUpDays; $('cTouches').value = cfg.maxTouches;
  $('pvAccount').innerHTML = Object.keys(cfg.senders).map((a) => `<option>${esc(a)}</option>`).join('');
  $('tStatus').textContent = `live version v${cfg.version || 0}${cfg.updatedAt ? `, saved ${when(cfg.updatedAt)}` : ' (built-in defaults)'}`;
  loadEditor();
  await loadHistory();
};
function stash() { if (cfg) { const t = { subject: $('tSubject').value, body: $('tBody').value }; const o = cfg.templates[seg] || {}; if (o.subject !== t.subject || o.body !== t.body) dirty = true; cfg.templates[seg] = t; } }
function tplStats() {
  const rows = (an?.templates || []).filter((t) => t.template === seg);
  const all = rows.reduce((o, t) => ({ sent: o.sent + t.sent, opened: o.opened + t.opened, replied: o.replied + t.replied }), { sent: 0, opened: 0, replied: 0 });
  const live = rows.find((t) => t.version === (cfg.version || 0));
  $('tplStats').innerHTML = all.sent
    ? `<span>Server sends <b>${fmt(all.sent)}</b></span><span>Opened <b>${pctTxt(rate(all.opened, all.sent), 0)}</b></span><span>Replied <b>${pctTxt(rate(all.replied, all.sent))}</b></span>${live ? `<span>Live v${live.version}: <b>${fmt(live.sent)}</b> sent, <b>${pctTxt(rate(live.replied, live.sent))}</b> replied</span>` : ''}`
    : `<span><span class="dot" style="background:${segColor(seg)};margin-right:6px"></span><b>${esc(TPL_LABEL[seg])}</b>: no server sends with this template yet.</span>`;
}
function loadEditor() {
  const t = cfg.templates[seg] || { subject: '', body: '' };
  $('tSubject').value = t.subject; $('tBody').value = t.body;
  document.querySelectorAll('#segTabs button').forEach((b) => b.classList.toggle('on', b.dataset.seg === seg));
  tplStats();
  pvIndex = 0; preview();
}
$('segTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-seg]'); if (!b) return; stash(); seg = b.dataset.seg; loadEditor(); });
for (const id of ['tSubject', 'tBody']) $(id).addEventListener('input', () => { stash(); $('tStatus').textContent = 'unsaved changes'; clearTimeout(pvTimer); pvTimer = setTimeout(preview, 350); });
$('pvPrev').onclick = () => { pvIndex--; preview(); };
$('pvNext').onclick = () => { pvIndex++; preview(); };
$('pvAccount').onchange = preview;
async function preview() {
  try {
    const d = await api('preview', { templateId: seg, template: cfg.templates[seg], index: pvIndex, account: $('pvAccount').value });
    const src = { queue: `queued contact ${(d.index ?? 0) + 1} of ${d.of}`, sample: 'built-in sample row (no queued contacts for this template)', contact: 'contact', sent: 'sent contact' }[d.source] || d.source;
    $('pvWho').textContent = `To ${d.to} · ${src} · from ${d.account}`;
    const w = [];
    if (d.problems.missing.length) w.push(`<div class="msg bad">Column missing, would send a literal placeholder: ${d.problems.missing.map((f) => `<code>{{${esc(f)}}}</code>`).join(' ')}</div>`);
    if (d.problems.empty.length) w.push(`<div class="msg warn">Empty for this contact, leaves a hole: ${d.problems.empty.map((f) => `<code>{{${esc(f)}}}</code>`).join(' ')}</div>`);
    if (d.problems.emptyTemplate) w.push('<div class="msg bad">Subject or body is empty.</div>');
    if (!w.length) w.push('<div class="msg ok">Merges cleanly for this contact.</div>');
    $('pvWarn').innerHTML = w.join('');
    $('pvText').innerHTML = `<div class="pv-sub">${esc(d.subject)}</div>${esc(d.text)}`;
    $('pvHtml').srcdoc = `<div style="font:14px Arial,sans-serif">${untracked(d.html)}</div>`;
  } catch (e) { if (e instanceof AuthError) return handleErr(e); $('pvWarn').innerHTML = `<div class="msg bad">${esc(e.message)}</div>`; }
}
$('tSave').onclick = async () => {
  stash();
  const senders = {}; document.querySelectorAll('[data-sender]').forEach((i) => (senders[i.dataset.sender] = i.value.trim()));
  const nicknames = {}; document.querySelectorAll('[data-nick]').forEach((i) => (nicknames[i.dataset.nick] = i.value.trim()));
  const emptyT = TPL.filter(([id]) => !cfg.templates[id].subject.trim() || !cfg.templates[id].body.trim()).map(([, l]) => l);
  if (emptyT.length && !confirm(`These templates are empty: ${emptyT.join(', ')}. Save anyway?`)) return;
  const res = await fetch('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-admin-password': PW },
    body: JSON.stringify({ templates: cfg.templates, senders, nicknames, dailyLimit: +$('cDaily').value, followUpDays: +$('cFuDays').value, maxTouches: +$('cTouches').value }) });
  const d = await res.json().catch(() => ({}));
  if (res.status === 401) return handleErr(new AuthError(d.error));
  if (!res.ok) return toast(d.error || 'save failed');
  cfg = d; dirty = false; $('tStatus').textContent = `saved as version ${d.version}`; toast(`Saved version ${d.version}`); loadHistory().catch(handleErr);
};
async function loadHistory() {
  const h = await api('config.history');
  $('hist').innerHTML = '<tr><th>Version</th><th>Saved</th><th>Replaced</th><th></th></tr>' + (h.items.length ? h.items.map((v) =>
    `<tr><td><b>v${v.version}</b></td><td>${when(v.updatedAt)}</td><td>${when(v.replacedAt)}</td><td class="n"><button class="btn small ghost" data-view="${v.index}">View</button> <button class="btn small" data-restore="${v.index}">Restore</button></td></tr>`).join('')
    : `<tr><td colspan="4" style="border:0;padding:0"><div class="empty" style="min-height:110px">${ICON.clock}<b>No earlier versions yet</b><span>Every save keeps the version it replaced.</span></div></td></tr>`);
  $('hist').onclick = async (e) => {
    const r = e.target.dataset.restore, v = e.target.dataset.view;
    if (v !== undefined) {
      const it = h.items[+v];
      $('mTitle').textContent = `Version ${it.version}`;
      $('mBody').innerHTML = TPL.map(([id, l]) => `<h2 style="margin:14px 0 6px;font-size:13px"><span class="dot" style="background:${segColor(id)};margin-right:6px"></span>${l}</h2><div class="pv" style="min-height:0"><div class="pv-sub">${esc(it.templates?.[id]?.subject)}</div>${esc(it.templates?.[id]?.body)}</div>`).join('');
      $('modal').classList.remove('hidden');
    }
    if (r !== undefined && confirm(`Restore version ${h.items[+r].version}? It is saved as a new version and reaches the extension too.`)) {
      try { const d = await api('config.rollback', { index: +r }); toast(`Restored v${d.restoredFrom} as v${d.config.version}`); loaders.templates().catch(handleErr); } catch (err) { handleErr(err); }
    }
  };
}
window.addEventListener('beforeunload', (e) => { if (dirty && current === 'templates') { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------- SENDING
loaders.sending = async () => {
  const [o, a] = await Promise.all([api('overview'), api('analytics')]);
  ov = o; an = a; ACCOUNTS = ov.accounts.map((x) => x.account); sideStatus();
  const s = ov.settings;
  pauseBanner('pauseBanner', false);
  $('unpause')?.addEventListener('click', async () => {
    const missing = Object.entries(ov.env.passwords).filter(([, p]) => !p.set).map(([x]) => x);
    const msg = `Unpause server sending?\n\nFrom now on, each sending day, every unpaused account sends up to ${s.perAccountCap} emails between ${s.windowStart} and the cutoff.` +
      (missing.length ? `\n\nNo app password yet for: ${missing.join(', ')} (they will not send).` : '') + (ov.env.cronSecret ? '' : '\n\nCRON_SECRET is not set, so nothing triggers sends yet.');
    if (confirm(msg)) { try { await api('settings.save', { settings: { paused: false } }); toast('Sending unpaused'); reload(); } catch (e) { handleErr(e); } }
  });
  $('pauseAll')?.addEventListener('click', async () => { try { await api('settings.save', { settings: { paused: true } }); toast('Paused'); reload(); } catch (e) { handleErr(e); } });
  accountCards('sAccounts', 'sa', true);
  $('accts').innerHTML = '<tr><th>Account</th><th>Lane</th><th>Password</th><th class="n">Today</th><th class="n">7d sent</th><th class="n">Opens</th><th class="n">Replies</th><th class="n">Bounces</th><th class="n">Unsubs</th><th class="n">Bounce rate (last 50)</th><th>Last send</th><th>Inbox checked</th></tr>' +
    ov.accounts.map((a) => `<tr><td><span class="dot" style="background:${acctColor(a.account)};margin-right:8px"></span>${esc(a.account)}${a.customServer ? ` <span class="sub">via ${esc(a.server)}</span>` : ''}</td>
      <td><select data-lane-acct="${esc(a.account)}" aria-label="Lane for ${esc(a.account)}">${['regular', 'work', 'hot'].map((l) => `<option value="${l}" ${(a.lane || 'regular') === l ? 'selected' : ''}>${LANE_LABEL[l]}</option>`).join('')}</select></td>
      <td>${a.hasPassword ? '<span class="pill ok">set</span>' : `<span class="pill bad">missing</span> <span class="sub mono">${esc(a.passwordVar)}</span>`}</td>
      <td class="n">${a.sentToday} / ${a.cap}</td><td class="n">${a.sent7d}</td><td class="n">${a.opened7d}</td><td class="n">${a.replied7d}</td>
      <td class="n">${a.bounced7d}</td><td class="n">${a.unsubscribed7d}</td><td class="n">${pctTxt(a.bounceRate50.rate)} <span class="sub">(${a.bounceRate50.bounced}/${a.bounceRate50.of})</span></td>
      <td>${when(a.lastSendAt)}</td><td class="${a.lastImapError ? 'wrap' : ''}">${when(a.lastImapOkAt)}${a.lastImapError ? `<div class="badbox">${esc(a.lastImapError)}</div>` : ''}</td></tr>`).join('');
  $('accts').onchange = async (e) => {
    const sel = e.target.closest('select[data-lane-acct]'); if (!sel) return;
    const a = sel.dataset.laneAcct, lane = sel.value;
    if (!confirm(`Move ${a} to the ${LANE_LABEL[lane]} lane?\n\nFrom now on it only sends ${lane === 'regular' ? 'the main Contacts list' : `${LANE_LABEL[lane]} leads (Hot leads page)`}. Plans not yet started are rebuilt. The pause is not changed.`)) { reload(); return; }
    try { await api('account.lane', { account: a, lane }); toast(`${a} is now in the ${LANE_LABEL[lane]} lane`); reload(); } catch (err) { handleErr(err); reload(); }
  };
  $('sAccounts').onclick = async (e) => {
    const d = e.target.dataset;
    try {
      if (d.pause) { await api('account.pause', { account: d.pause }); toast(`${d.pause} paused`); }
      if (d.resume) { await api('account.resume', { account: d.resume }); toast(`${d.resume} resumed`); }
      if (d.scan) { const r = await api('scan.now', { account: d.scan }); toast(`${d.scan}: ${r.replies} replies, ${r.bounces} bounces`); }
      if (d.pause || d.resume || d.scan) reload();
    } catch (err) { handleErr(err); }
  };
  $('capMax').textContent = ov.capMax; $('sCap').max = ov.capMax; $('sFuDay').max = ov.capMax;
  $('sWs').value = s.windowStart; $('sWe').value = s.windowEnd; $('sCut').value = s.lateCutoff; $('sCap').value = s.perAccountCap; $('sFuDay').value = s.followUpsPerDay;
  $('sMin').value = s.minGapMin; $('sMax').value = s.maxGapMin; $('sFresh').value = s.replyCheckHours;
  $('sFu').checked = s.followUps; $('sRole').checked = s.skipRoleAddresses; $('sFree').checked = s.freemailDomainExempt;
  $('sBlock').checked = s.blockOnPlaceholderIssues; $('sPers').checked = Boolean(s.personalLines); $('sLU').checked = s.listUnsubscribe; $('sDry').checked = s.dryRun; $('sFooter').value = s.footer;
  $('sTestTo').value = (s.testRecipients || []).join('\n');
  $('sRegPlain').checked = Boolean(s.lanes?.regular?.plainText); $('sRegOpt').checked = Boolean(s.lanes?.regular?.optOutLine);
  $('sDays').innerHTML = [1, 2, 3, 4, 5, 6, 0].map((i) => `<label><input type="checkbox" data-day="${i}" ${s.weekdays.includes(i) ? 'checked' : ''}><span>${DAYS[i]}</span></label>`).join('');
  $('sCats').innerHTML = TPL.filter(([id]) => id !== 'followup').map(([id, l]) => `<label><input type="checkbox" data-cat="${id}" ${(s.skipTemplates || []).includes(id) ? '' : 'checked'}><span>${l}</span></label>`).join('');
  $('tsAcct').innerHTML = ov.accounts.map((a) => `<option>${esc(a.account)}</option>`).join('');
  $('tsTpl').innerHTML = TPL.map(([id, l]) => `<option value="${id}">${l}</option>`).join('') +
    '<option value="lane">Work/Hot account: its lane\'s first email</option><option value="lane-followup">Work/Hot account: its lane\'s follow-up</option>';
  const env = ov.env, tickOld = ov.lastTick && Date.now() - ov.lastTick > 15 * 60000;
  $('envBox').innerHTML = `<div class="kv">
    <span>Trigger secret</span><span><code>CRON_SECRET</code> ${env.cronSecret ? '<span class="pill ok">set</span>' : '<span class="pill bad">not set · /api/tick refuses every call</span>'}</span>
    <span>Extension key</span><span><code>TEAM_KEY</code> ${env.teamKey ? '<span class="pill ok">set</span>' : '<span class="pill bad">not set · the extension cannot read templates</span>'}</span>
    <span>App passwords</span><span>${Object.values(env.passwords).filter((p) => p.set).length} of ${Object.keys(env.passwords).length} set</span>
    <span>Last tick</span><span>${when(ov.lastTick)} ${tickOld ? '<span class="pill warn">over 15 min ago</span>' : ''}</span>
    <span>Today</span><span>${ov.today}${ov.todayIsSendingDay ? '' : ' · not a sending day'} · ${ov.todayPlan.built ? Object.entries(ov.todayPlan.byStatus).map(([k, v]) => `${v} ${k}`).join(' · ') || 'nothing planned' : 'not planned yet'}</span>
    <span>Queue</span><span>${fmt(ov.queue.queued)} waiting · ${fmt(ov.queue.followUpCandidates)} in follow-up rotation · templates v${ov.configVersion}</span></div>
    <p class="cap" style="margin:14px 0 0">Something must call <code>/api/tick</code> every 1–2 minutes during sending hours (cron-job.org or an Upstash QStash schedule); see the README in <code>server/</code>.</p>`;
};
$('sSave').onclick = async () => {
  const settings = { windowStart: $('sWs').value, windowEnd: $('sWe').value, lateCutoff: $('sCut').value, perAccountCap: +$('sCap').value, followUpsPerDay: +$('sFuDay').value,
    minGapMin: +$('sMin').value, maxGapMin: +$('sMax').value, replyCheckHours: +$('sFresh').value,
    followUps: $('sFu').checked, skipRoleAddresses: $('sRole').checked, freemailDomainExempt: $('sFree').checked,
    blockOnPlaceholderIssues: $('sBlock').checked, personalLines: $('sPers').checked, listUnsubscribe: $('sLU').checked, dryRun: $('sDry').checked, footer: $('sFooter').value, testRecipients: $('sTestTo').value,
    weekdays: [...document.querySelectorAll('[data-day]')].filter((c) => c.checked).map((c) => +c.dataset.day),
    skipTemplates: [...document.querySelectorAll('[data-cat]')].filter((c) => !c.checked).map((c) => c.dataset.cat),
    lanes: { regular: { plainText: $('sRegPlain').checked, optOutLine: $('sRegOpt').checked } } };
  if (settings.lanes.regular.plainText && !ov?.settings?.lanes?.regular?.plainText
    && !confirm('Turn on plain text for the Regular lane?\n\nRegular emails would go out with no footer (so no unsubscribe link), no logo and no open tracking.')) return;
  try { await api('settings.save', { settings }); $('sStatus').textContent = 'saved; future plans rebuilt'; toast('Schedule saved'); reload(); }
  catch (e) { handleErr(e); }
};
$('addGo').onclick = async () => {
  const account = $('addAcct').value.trim().toLowerCase(), lane = $('addLane').value;
  if (!account) return toast('Type the email address');
  if (!confirm(`Add ${account} as a sending account in the ${LANE_LABEL[lane]} lane?\n\nIt sends nothing until its password is set in Vercel and sending is unpaused.`)) return;
  try {
    const d = await api('account.add', { account, name: $('addName').value.trim(), lane });
    // Gmail needs only the password; another domain may also need its mail server.
    const todo = [];
    if (!d.hasPassword) todo.push(`<code>${esc(d.passwordVar)}</code> = the account's password (a Google app password for Gmail or Google Workspace)`);
    if (!d.customServer && !/@(gmail|googlemail)\.com$/.test(d.account)) {
      todo.push(`unless its mail is on Google Workspace, <code>${esc(d.serverVar)}</code> = its mail server (often mail.${esc(d.account.split('@')[1])})`);
    }
    $('addStatus').innerHTML = `${d.added ? 'Added' : 'Already a sending account; lane set'}: <b>${esc(d.account)}</b> → ${LANE_LABEL[d.lane]} lane${d.customServer ? `, via ${esc(d.server)}` : ''}. `
      + (todo.length ? `Next: in Vercel → mailer-tracker → Settings → Environment Variables, add ${todo.join('; and, ')}. Then redeploy.` : 'Password is set.');
    $('addAcct').value = ''; $('addName').value = ''; toast('Account added'); reload();
  } catch (e) { handleErr(e); }
};
// The test batch / test follow-up flows, for any lane (Regular on the Sending
// page, Work/Hot on the Hot leads page). Always preview + confirm first.
async function runTestBatch(lane, statusId, outId) {
  const st = $(statusId), out = $(outId);
  st.textContent = 'checking the queue…'; out.innerHTML = '';
  try {
    const p = await api('flow.testNow', { lane });
    const extra = [
      p.waitingForNextClick.length ? `Waiting for the next click (one per account per click): ${p.waitingForNextClick.join(', ')}` : '',
      p.suppressed.length ? `Suppressed, will not be sent: ${p.suppressed.map((x) => `${x.email} (${x.reason})`).join(', ')}` : '',
      ...p.accounts.filter((a) => a.blocked).map((a) => `${a.account} can't send: ${a.blocked}`),
      p.otherQueuedUntouched ? `${p.otherQueuedUntouched} other queued contact(s) are not on the test list and stay in the queue.` : '',
    ].filter(Boolean);
    if (!p.assign.length) { st.textContent = p.note || 'Nothing to send.'; out.innerHTML = extra.map(esc).join('<br>'); return; }
    const lines = p.assign.map((x) => `  • ${x.email}  ← from ${x.account} (${TPL_LABEL[x.template] || x.template})`).join('\n');
    const msg = `${lane !== 'regular' ? `${LANE_LABEL[lane]} lane${p.plainText ? ', plain text' : ''}: ` : ''}Send ${p.assign.length} ${p.dryRun ? 'DRY-RUN (rendered and logged, not sent) ' : 'real '}email${p.assign.length > 1 ? 's' : ''} now` +
      `${p.paused ? ', bypassing the pause' : ''} and ignoring the sending window, to exactly:\n\n${lines}${extra.length ? `\n\n${extra.join('\n')}` : ''}`;
    if (!confirm(msg)) { st.textContent = 'Cancelled, nothing sent.'; return; }
    st.textContent = 'sending…';
    const r = await api('flow.testNow', { lane, confirm: p.assign.map((x) => x.email) });
    st.textContent = `${r.sent} sent. Watch the Send log; replies show after "Check inbox" on the account card.`;
    out.innerHTML = r.results.map((x) => `${esc(x.email)} ← ${esc(x.account)}: <span class="pill ${pillFor(x.status)}">${esc(x.status)}</span>${x.reason ? ` <span class="sub">${esc(x.reason)}</span>` : ''}`).join('<br>');
    reload(true);
  } catch (e) { if (e instanceof AuthError) return handleErr(e); st.textContent = e.message; }
}
async function runTestFollowUp(lane, statusId, outId) {
  const st = $(statusId), out = $(outId);
  st.textContent = 'checking who is due a follow-up…'; out.innerHTML = '';
  try {
    const p = await api('flow.testFollowUp', { lane });
    const extra = [
      ...p.skipped.map((x) => `Skipped ${x.email} (touch ${x.touch}): ${x.reason}`),
      p.waitingForNextClick.length ? `Waiting for the next click (one per account per click): ${p.waitingForNextClick.join(', ')}` : '',
    ].filter(Boolean);
    if (!p.assign.length) { st.textContent = p.note || 'Nothing to send.'; out.innerHTML = extra.map(esc).join('<br>'); return; }
    const lines = p.assign.map((x) => `  • ${x.email}  ← from ${x.account}, follow-up touch ${x.touch} of ${p.maxTouches}`).join('\n');
    const msg = `${lane !== 'regular' ? `${LANE_LABEL[lane]} lane${p.plainText ? ', plain text' : ''}: ` : ''}Send ${p.assign.length} ${p.dryRun ? 'DRY-RUN (rendered and logged, not sent) ' : 'real '}follow-up${p.assign.length > 1 ? 's' : ''} now, skipping the ${p.followUpDays}-day wait` +
      `${p.paused ? ' and the pause' : ''}, to exactly:\n\n${lines}\n\nEach account's inbox is checked for replies first; anyone who replied, bounced or unsubscribed is skipped.` +
      `${extra.length ? `\n\n${extra.join('\n')}` : ''}`;
    if (!confirm(msg)) { st.textContent = 'Cancelled, nothing sent.'; return; }
    st.textContent = 'checking inboxes, then sending…';
    const r = await api('flow.testFollowUp', { lane, confirm: p.assign.map((x) => x.email) });
    st.textContent = `${r.sent} follow-up${r.sent === 1 ? '' : 's'} sent.${r.scans?.length ? ` Inbox check: ${r.scans.map((x) => `${short(x.account)} ${x.replies} repl${x.replies === 1 ? 'y' : 'ies'}`).join(', ')}.` : ''}`;
    out.innerHTML = r.results.map((x) => `${esc(x.email)} ← ${esc(x.account)} · touch ${x.touch}: <span class="pill ${pillFor(x.status)}">${esc(x.status)}</span>${x.reason ? ` <span class="sub">${esc(x.reason)}</span>` : ''}`).join('<br>')
      + (r.notes?.length ? `<br>${r.notes.map(esc).join('<br>')}` : '');
    reload(true);
  } catch (e) { if (e instanceof AuthError) return handleErr(e); st.textContent = e.message; }
}
$('tbGo').onclick = () => runTestBatch('regular', 'tbStatus', 'tbOut');
$('tfGo').onclick = () => runTestFollowUp('regular', 'tbStatus', 'tbOut');
$('tsGo').onclick = async () => {
  const to = $('tsTo').value.trim();
  if (!to) return toast('Type the address to send the test to');
  if (!confirm(`Send one [TEST] email from ${$('tsAcct').value} to ${to}?`)) return;
  $('tsStatus').textContent = 'sending…';
  try { const d = await api('test.send', { account: $('tsAcct').value, to, templateId: $('tsTpl').value });
    const pr = d.problems && !d.problems.ok ? ` · placeholder problems: ${[...d.problems.missing, ...d.problems.empty].join(', ')}` : '';
    $('tsStatus').textContent = `${d.dryRun ? 'dry-run, not sent' : 'sent'}${d.plain ? ' as plain text' : ''}: "${d.subject}" (rendered for ${d.renderedFor})${pr}`; }
  catch (e) { if (e instanceof AuthError) return handleErr(e); $('tsStatus').textContent = e.message; }
};

// ---------------------------------------------------------------- QUEUE
let planWhich = 'tomorrow', qFilterSel = 'all';
// A contact's personal lines in a table cell: subject on top, opening line under it.
const personalCell = (x) => (x.subjectLine || x.openingLine
  ? `<div class="pz-line" title="${esc([x.subjectLine && `Subject: ${x.subjectLine}`, x.openingLine && `Opening line: ${x.openingLine}`].filter(Boolean).join('\n'))}"><b>${esc(x.subjectLine || '(template subject)')}</b><span class="sub">${esc(x.openingLine || 'no opening line')}</span></div>`
  : '<span class="sub">standard template</span>');
loaders.queue = async () => {
  if (!ov) { ov = await api('overview'); ACCOUNTS = ov.accounts.map((x) => x.account); }
  const [p, f, q] = await Promise.all([api('plan.get', { date: planWhich }), api('followups'), api('queue.list', { filter: qFilterSel })]);
  const plan = p.plan, m = plan.meta;
  $('planWhich').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.plan === planWhich));
  $('planCap').textContent = !m ? `${plan.date}: not planned` : m.offDay ? `${plan.date} is not a sending day` :
    `${dayLong(plan.date)} · ${plan.items.length} planned · cap ${m.cap}/account · window ${m.window.join('–')} EAT · built ${when(m.builtAt)}`;
  timelineLegend('qTlLegend');
  timeline('qTimeline', [{ title: planWhich === 'today' ? `Today, ${dayLabel(plan.date)}` : `Next sending day, ${dayLong(plan.date)}`, plan, isToday: planWhich === 'today' }]);
  const done = new Set(['sent', 'bounced', 'failed', 'skipped', 'dry-run']);
  $('plan').innerHTML = '<tr><th>Time (EAT)</th><th>Account</th><th>Recipient</th><th>Company</th><th>Template</th><th>Personal line</th><th>Status</th><th></th></tr>' +
    (plan.items.length ? plan.items.map((i) => `<tr><td class="mono">${clock(i.at)}</td><td><span class="dot" style="background:${acctColor(i.account)};margin-right:6px"></span>${esc(short(i.account))} ${lanePill(i.lane)}</td><td>${esc(i.email)}</td><td>${esc(i.company)}</td>
      <td><span class="legend" style="margin:0;display:inline-flex"><span><i style="background:${segColor(i.template)}"></i>${esc(TPL_LABEL[i.template] || i.template)}</span></span>${i.followUp ? ` <span class="pill">touch ${i.touch}</span>` : ''}</td>
      <td>${i.followUp ? '<span class="sub">follow-up wording</span>' : personalCell(i)}</td>
      <td class="wrap"><span class="pill ${pillFor(i.status)}">${esc(i.status)}</span>${i.reason ? `<div class="sub">${esc(i.reason)}</div>` : ''}</td>
      <td class="n">${!i.followUp && !done.has(i.status) ? `<button class="btn small" data-pv="${esc(i.email)}">Preview</button>` : ''}</td></tr>`).join('')
      : `<tr><td colspan="8" class="sub">Nothing planned. Upload contacts, and check the accounts are not paused.</td></tr>`);
  // follow-ups due per day
  const today = p.today, next7 = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${today}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
  // By the day each one goes out (the daily follow-up limit pushes some later than their due day).
  const goes = (x) => x.sendDate || x.dueDate;
  const due = next7.map((d, i) => f.items.filter((x) => (i === 0 ? goes(x) <= d : goes(x) === d)).length);
  if (!due.some(Boolean)) empty('chFuDue', 'No follow-ups due this week', 'Contacts get a follow-up after the set number of days without a reply.', 'clock');
  else chart('chFuDue', { type: 'bar', data: { labels: next7.map((d, i) => (i === 0 ? 'Today' : `${DAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${dayLabel(d)}`)),
    datasets: ACCOUNTS.map((a) => ({ label: short(a), data: next7.map((d, i) => f.items.filter((x) => x.account === a && (i === 0 ? goes(x) <= d : goes(x) === d)).length), backgroundColor: acctColor(a), stack: 'f', maxBarThickness: 28 })) },
    options: { interaction: { mode: 'index', intersect: false }, plugins: { tooltip: { filter: (i) => i.raw > 0 } }, scales: { x: axisX({ stacked: true }), y: axisY({ stacked: true }) } } });
  $('fuCap').textContent = `${f.items.length} due in the next 7 days`;
  $('fus').innerHTML = '<tr><th>Due</th><th>Goes out</th><th>Recipient</th><th>Account</th><th class="n">Touches</th></tr>' +
    (f.items.length ? f.items.map((x) => `<tr><td>${esc(x.dueDate)}</td><td>${esc(goes(x) < today ? today : goes(x))}</td><td>${esc(x.email)}<div class="sub">${esc(x.company)}</div></td><td><span class="dot" style="background:${acctColor(x.account)};margin-right:6px"></span>${esc(short(x.account))}</td><td class="n">${x.touches}</td></tr>`).join('')
      : '<tr><td colspan="5" class="sub">No follow-ups due in the next 7 days.</td></tr>');
  const shown = q.filter === 'all' ? '' : ` · showing ${q.filter === 'personal' ? 'personalised' : 'standard'} only (${fmt(q.matched)})`;
  $('qCap').textContent = `${fmt(q.total)} contacts waiting, oldest first${shown}${q.matched > q.items.length ? `, first ${q.items.length} shown` : ''}`;
  $('qFilter').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.f === qFilterSel));
  const cov = rate(q.personal, q.total);
  $('qCoverage').innerHTML = q.total ? `<div class="pz-cov"><span class="dot" style="background:${PZ}"></span><span><b style="color:var(--text)">${fmt(q.personal)}</b> of ${fmt(q.total)} personalised</span>
    <div class="track" role="img" aria-label="${pctTxt(cov, 0)} personalised"><div style="width:${((cov || 0) * 100).toFixed(1)}%"></div></div><span>${pctTxt(cov, 0)}</span><span class="sub">· ${fmt(q.standard)} on the standard template${q.personalLinesOn === false ? ' (the CSV\'s own subject and opening lines are off, see Sending)' : ''}</span></div>` : '';
  const emptyMsg = q.total && q.filter === 'personal' && q.personalLinesOn === false ? ['No personalised contacts in the queue', 'The CSV\'s own subject and opening lines are switched off on the Sending tab, so every first email uses the template for its category.']
    : q.total && q.filter === 'personal' ? ['No personalised contacts in the queue', 'Upload a CSV with subject_line / opening_line columns, and tick "Update contacts already uploaded" to add them to contacts already here.']
    : q.total && q.filter === 'standard' ? ['Every queued contact is personalised', 'Nothing here uses the standard template.'] : ['The queue is empty', 'Upload a CSV under Contacts &amp; suppression.'];
  $('queue').innerHTML = '<tr><th>#</th><th>Recipient</th><th>Company</th><th>Template</th><th>Personal line</th><th>Added</th><th></th></tr>' +
    (q.items.length ? q.items.map((x) => `<tr><td class="sub">${x.position}</td><td>${esc(x.name) || '<span class="sub">—</span>'}<div class="sub">${esc(x.email)}</div></td><td>${esc(x.company)}</td>
      <td><span class="legend" style="margin:0;display:inline-flex"><span><i style="background:${segColor(x.template)}"></i>${esc(TPL_LABEL[x.template] || x.template)}</span></span>${x.off ? ` <span class="pill warn" title="${esc(x.off)}">not sent: switched off</span>` : ''}</td>
      <td>${personalCell(x)}</td><td>${when(x.addedAt)}</td>
      <td class="n" style="white-space:nowrap"><button class="btn small" data-pv="${esc(x.email)}">Preview</button> <button class="btn small ghost" data-rm="${esc(x.email)}">Remove</button></td></tr>`).join('')
      : `<tr><td colspan="7" style="border:0;padding:0"><div class="empty" style="min-height:110px">${ICON.inbox}<b>${emptyMsg[0]}</b><span>${emptyMsg[1]}</span></div></td></tr>`);
};
$('qFilter').onclick = (e) => { const b = e.target.closest('button[data-f]'); if (!b) return; qFilterSel = b.dataset.f; reload(); };
$('plan').onclick = (e) => { const b = e.target.closest('[data-pv]'); if (b) openPreview(b.dataset.pv); };

// The exact first email a queued or planned contact will get, rendered by the server.
async function openPreview(email) {
  $('mTitle').innerHTML = `Preview <span class="sub" style="font-weight:400">· what ${esc(email)} will receive</span>`;
  $('mBody').innerHTML = '<div class="sub">Rendering…</div>';
  $('modal').classList.remove('hidden');
  try {
    const d = await api('contact.preview', { email });
    const who = [d.name, d.company].filter(Boolean).join(' · ');
    const pz = d.personal
      ? `<div class="pz-box"><div class="lbl">Personalised</div>${d.subjectLine ? `<div><span class="sub">Subject line</span> ${esc(d.subjectLine)}</div>` : '<div class="sub">Template subject (no personal subject line)</div>'}${d.openingLine ? `<div style="margin-top:4px"><span class="sub">Opening line</span> ${esc(d.openingLine)}</div>` : '<div class="sub" style="margin-top:4px">No opening line</div>'}</div>`
      : '<div class="pz-box std"><div class="lbl">Standard</div>No personal lines for this contact, so the template\'s own subject and wording are used.</div>';
    const pr = d.problems && !d.problems.ok ? `<div class="msg warn" style="margin-bottom:12px"><span><b>Would be held back:</b> ${esc([...d.problems.missing.map((f) => `{{${f}}} missing`), ...d.problems.empty.map((f) => `{{${f}}} empty`), ...(d.problems.emptyTemplate ? ['template empty'] : [])].join(', '))}</span></div>` : '';
    $('mBody').innerHTML = `<div class="kv" style="margin:6px 0 12px;font-size:12.5px"><span>To</span><span>${esc(d.email)}${who ? ` <span class="sub">· ${esc(who)}</span>` : ''}</span>
      <span>From</span><span>${esc(d.account || '—')}</span><span>Template</span><span>${esc(TPL_LABEL[d.templateId] || d.templateId)}${d.plain ? ' <span class="pill">plain text</span>' : ''} ${lanePill(d.lane)}</span>
      <span>When</span><span>${d.at ? esc(when(d.at)) : 'not planned yet (waiting in the queue)'}</span></div>${pz}${pr}<div class="mail-subject">${esc(d.subject)}</div>`;
    if (d.html && !d.plain) $('mBody').appendChild(mailFrame(d.html));
    else { const pre = document.createElement('div'); pre.className = 'pv'; pre.textContent = d.text; $('mBody').appendChild(pre); }
  } catch (e) { if (e instanceof AuthError) return handleErr(e); $('mBody').innerHTML = `<div class="badbox">${esc(e.message)}</div>`; }
}
$('planWhich').onclick = (e) => { const b = e.target.closest('button[data-plan]'); if (!b) return; planWhich = b.dataset.plan; reload(); };
$('planRebuild').onclick = async () => { try { await api('plan.rebuild'); planWhich = 'tomorrow'; toast('Rebuilt'); reload(); } catch (e) { handleErr(e); } };
$('queue').onclick = async (e) => {
  const pv = e.target.closest('[data-pv]'); if (pv) return openPreview(pv.dataset.pv);
  const rm = e.target.dataset.rm; if (rm && confirm(`Remove ${rm} from the queue?`)) { try { await api('queue.remove', { email: rm }); reload(); } catch (err) { handleErr(err); } }
};
$('qClear').onclick = async () => { if (confirm('Remove every waiting contact from the queue?')) { try { const d = await api('queue.clear'); toast(`${d.removed} removed`); reload(); } catch (e) { handleErr(e); } } };

// ---------------------------------------------------------------- LOG
let logOffset = 0;
loaders.log = async () => {
  if (!ov) { ov = await api('overview'); ACCOUNTS = ov.accounts.map((x) => x.account); }
  if ($('lAcct').options.length === 1) $('lAcct').innerHTML += ov.accounts.map((a) => `<option>${esc(a.account)}</option>`).join('');
  const [d, a] = await Promise.all([api('log.list', { q: $('lQ').value, status: $('lStatus').value, account: $('lAcct').value, offset: logOffset, limit: 50 }), api('analytics')]);
  an = a;
  const days = an.days.slice(-14), statuses = [...new Set(days.flatMap((x) => Object.keys(an.logByDay[x] || {})))];
  const order = Object.keys(STATUS_COLOR); statuses.sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99));
  legend('logLegend', statuses.map((s) => [statusColor(s), s]));
  if (!statuses.length) empty('chLog', 'No log activity in the last 14 days', 'Sends, skips, failures, bounces and replies are logged here as they happen.');
  else chart('chLog', { type: 'bar', data: { labels: days.map(dayLabel), datasets: statuses.map((s) => ({ label: s, data: days.map((x) => an.logByDay[x]?.[s] || 0), backgroundColor: statusColor(s), stack: 'l', maxBarThickness: 26 })) },
    options: { interaction: { mode: 'index', intersect: false }, plugins: { tooltip: { filter: (i) => i.raw > 0 } }, scales: { x: axisX({ stacked: true }), y: axisY({ stacked: true }) } } });
  $('lPage').textContent = d.items.length ? `showing ${logOffset + 1}–${logOffset + d.items.length}` : '';
  $('lPrev').disabled = logOffset === 0; $('lNext').disabled = d.items.length < 50;
  $('logT').innerHTML = '<tr><th>Time</th><th>Account</th><th>To</th><th>Template</th><th>Subject</th><th>Status</th><th>Detail</th></tr>' +
    (d.items.length ? d.items.map((x) => `<tr class="click" data-id="${esc(x.id)}"><td style="white-space:nowrap">${when(x.at)}</td><td><span class="dot" style="background:${acctColor(x.account)};margin-right:6px"></span>${esc(short(x.account))}</td><td>${esc(x.to)}</td>
      <td>${x.templateId ? `<span class="legend" style="margin:0;display:inline-flex"><span><i style="background:${segColor(x.templateId)}"></i>${esc(TPL_LABEL[x.templateId] || x.templateId)}</span></span>` : ''}</td>
      <td class="wrap">${esc(x.subject)}${x.lane ? ` ${lanePill(x.lane)}` : ''}${x.plain ? ' <span class="pill">plain</span>' : ''}${pzPill(x.personal)}</td><td><span class="pill ${pillFor(x.status)}">${esc(x.status)}</span></td>
      <td class="sub wrap">${esc(x.error || x.reason || x.response || '')}</td></tr>`).join('')
      : `<tr><td colspan="7" style="border:0;padding:0"><div class="empty" style="min-height:130px">${ICON.inbox}<b>No entries</b><span>${$('lQ').value || $('lStatus').value || $('lAcct').value ? 'Nothing matches the filters.' : 'Nothing has been sent from the server yet.'}</span></div></td></tr>`);
  $('logT').onclick = async (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const entry = d.items.find((x) => x.id === tr.dataset.id);
    try {
      const b = (await api('log.get', { id: entry.id })).body;
      $('mTitle').innerHTML = `<span class="pill ${pillFor(entry.status)}" style="margin-right:8px">${esc(entry.status)}</span>${esc(entry.to)}`;
      $('mBody').innerHTML = `<div class="kv" style="margin:6px 0 14px;font-size:12.5px"><span>From</span><span>${esc(entry.account)}</span><span>To</span><span>${esc(entry.to)}</span><span>When</span><span>${when(entry.at)}</span>
        <span>Template</span><span>${esc(TPL_LABEL[entry.templateId] || entry.templateId || '—')}${entry.touch ? ` · touch ${entry.touch}` : ''}${entry.configVersion != null ? ` · v${entry.configVersion}` : ''}</span>
        <span>Message-ID</span><span class="mono">${esc(entry.messageId || '—')}</span><span>SMTP</span><span class="mono">${esc(entry.response || entry.error || entry.reason || '—')}</span></div>` +
        (b ? `<div class="pv-sub" style="border:0;margin-bottom:6px">${esc(b.subject)}</div><p class="cap" style="margin:0 0 8px">${b.html ? 'HTML part (logo untracked here):' : `Plain text only (no HTML part, no footer, no tracking; opens not tracked)${entry.lane ? `, ${LANE_LABEL[entry.lane]} lane` : ''}:`}</p>` : '<p class="sub">No body stored for this entry.</p>');
      if (b) { if (b.html) $('mBody').appendChild(mailFrame(b.html)); const pre = document.createElement('div'); pre.className = 'pv'; pre.style.marginTop = '12px'; pre.textContent = b.text; $('mBody').appendChild(pre); }
      $('modal').classList.remove('hidden');
    } catch (err) { handleErr(err); }
  };
};
$('lGo').onclick = () => { logOffset = 0; reload(); };
$('lQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lGo').click(); });
$('lNext').onclick = () => { logOffset += 50; reload(); };
$('lPrev').onclick = () => { logOffset = Math.max(0, logOffset - 50); reload(); };

// ---------------------------------------------------------------- CSV UPLOAD (shared by Contacts and Hot leads)
// Choose or drop a file -> dry-run preview on the server (contacts.preview:
// the exact checks of a real import, nothing written) -> Import -> result.
const CAT_ORDER = ['invalid', 'duplicate', 'existing', 'suppressed', 'role', 'unverified'];
const CAT_LABEL = { invalid: 'Invalid or missing email', duplicate: 'Duplicate in this file', existing: 'Already in a list or emailed before',
  suppressed: 'Do-not-email (suppressed)', role: 'Role address (info@, office@…)', unverified: 'Not verified (email_status)' };
const CAT_PILL = { invalid: 'bad', duplicate: '', existing: 'info', suppressed: 'bad', role: 'warn', unverified: 'warn' };
const UP_MAX_BYTES = 4 * 1024 * 1024;
const UP_ICON = {
  file: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg>',
  ok: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
};
let UP_FORMAT = null;
async function loadUploadFormat() {
  try { UP_FORMAT = await api('contacts.format'); } catch (e) { if (e instanceof AuthError) throw e; }
  return UP_FORMAT;
}
const csvCell = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
function sampleCsv(fmt) {
  const cols = ['email', 'first_name', 'last_name', 'company', 'segment', 'vertical', 'title', 'email_status', ...(fmt?.templateColumns || [])];
  const segs = (fmt?.segments || [{ id: 'callcenter' }, { id: 'tech' }, { id: 'va' }]).map((s) => s.id);
  const people = [['jane.doe', 'Jane', 'Doe', 'Doe Dental Clinic', 'dental', 'Practice Manager'], ['sam.lee', 'Sam', 'Lee', 'Lee Law Office', 'legal', 'Partner'],
    ['amir.khan', 'Amir', 'Khan', 'Khan Software Ltd', 'software agency', 'CTO'], ['maria.rossi', 'Maria', 'Rossi', 'Rossi Accounting', 'accounting', 'Owner']];
  const extra = { hours_gap: 'closed weekends', city: 'Leeds', country: 'GB', website: 'https://example.com' };
  const rows = segs.map((seg, i) => { const p = people[i % people.length];
    const r = { email: `${p[0]}@example.com`, first_name: p[1], last_name: p[2], company: p[3], segment: seg, vertical: p[4], title: p[5], email_status: 'valid' };
    return cols.map((c) => csvCell(r[c] ?? extra[c] ?? '')).join(','); });
  // one row with no segment: routed by its vertical (dental -> Call centre)
  rows.push(cols.map((c) => csvCell({ email: 'chris.obi@example.com', first_name: 'Chris', last_name: 'Obi', company: 'Obi Plumbing', vertical: 'plumbing', title: 'Owner', email_status: 'valid' }[c] ?? extra[c] ?? '')).join(','));
  return `${cols.join(',')}\n${rows.join('\n')}\n`;
}
function downloadText(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
const segName = (id) => TPL_LABEL[id] || id;
const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function makeUploader(host, { lane, onImported }) {
  const S = { stage: 'idle', file: null, text: '', rep: null, mapping: 'auto', unv: false, upd: false, err: '', result: null, over: false };
  const L = () => lane();
  const laneTxt = () => `${LANE_LABEL[L()]} lane`;
  const set = (patch) => { Object.assign(S, patch); render(); };

  function formatNote() {
    const f = UP_FORMAT;
    const cols = f ? f.columns : [{ id: 'email', required: true }];
    const segs = f ? f.segments.map((s) => {
      const t = s.lanes[L()];
      return `<span class="chip" title="${esc(`${s.label} → ${segName(t.template)}${t.ok ? '' : ' (template is empty)'}`)}"><code>${esc(s.id)}</code> ${esc(s.label)}${t.ok ? '' : ' <span class="pill warn">no template</span>'}</span>`;
    }).join('') : '';
    return `<div class="up-cols">
      <div class="up-h">Columns the server reads</div>
      <div class="chips">${cols.map((c) => `<span class="chip${c.required ? ' req' : ''}" title="${esc(c.use || '')}"><code>${esc(c.id)}</code>${c.required ? ' required' : ''}</span>`).join('')}</div>
      ${f?.templateColumns?.length ? `<div class="up-sub">Your templates also use ${f.templateColumns.map((c) => `<code>${esc(c)}</code>`).join(' ')}. Any other column becomes a <code>{{placeholder}}</code> too.</div>` : '<div class="up-sub">Any other column becomes a <code>{{placeholder}}</code>.</div>'}
      <div class="up-sub">Headers like "Email Address" or "Company Name" are matched for you; you can change the mapping in the preview. With <code>email_status</code>, only <code>valid</code> rows load unless you include unverified rows.</div>
      ${segs ? `<div class="up-h" style="margin-top:12px">Segments (<code>segment</code> column, id or label)</div><div class="chips">${segs}</div>
        <div class="up-sub">No segment? It is picked from <code>vertical</code>, <code>category</code> or <code>title</code>, otherwise Call centre.</div>` : ''}
      <div class="row" style="margin-top:12px"><button class="btn small" data-act="sample">${UP_ICON.down}Download sample CSV</button><span class="sub">Placeholder addresses; replace them before importing.</span></div>
    </div>`;
  }

  function idle() {
    return `<div class="up-idle">
      <label class="up-dz${S.over ? ' over' : ''}" data-dz tabindex="0" role="button" aria-label="Choose a CSV file to upload">
        <input type="file" accept=".csv,text/csv,text/plain" hidden data-file>
        <div class="up-ic">${UP_ICON.up}</div>
        <b>Drag a CSV file here</b>
        <span>or <u>choose a file</u> from your computer</span>
        <span class="sub">CSV (comma-separated, UTF-8) · up to ${fmt(UP_FORMAT?.maxRows || 5000)} rows</span>
        <span class="up-lane">Goes into the <b>${esc(laneTxt())}</b> ${lanePill(L())}</span>
      </label>
      ${formatNote()}
    </div>
    ${S.err ? `<div class="msg bad" style="margin-top:12px" role="alert"><span>${S.err}</span></div>` : ''}`;
  }

  function fileHead(extra = '') {
    const r = S.rep;
    return `<div class="up-file">
      <div class="up-fic">${UP_ICON.file}</div>
      <div class="grow"><b class="up-fname">${esc(S.file?.name || 'file')}</b><span class="sub">${kb(S.file?.size || 0)}${r && r.rows != null ? ` · ${fmt(r.rows)} row${r.rows === 1 ? '' : 's'}` : ''}${r?.headers ? ` · ${r.headers.length} column${r.headers.length === 1 ? '' : 's'}` : ''} · into the <b>${esc(laneTxt())}</b> ${lanePill(L())}</span></div>
      ${extra}
    </div>`;
  }

  function mappingPanel(r, open) {
    const f = UP_FORMAT; if (!f || !r.headers) return '';
    const heads = r.headers;
    const cur = {};
    for (const c of f.columns) cur[c.id] = heads.includes(c.id) ? c.id : '';
    for (const [t, s] of Object.entries(r.mapping || {})) if (cur[t] !== undefined) cur[t] = s;
    const extras = Object.entries(r.mapping || {}).filter(([t]) => cur[t] === undefined);
    const renamed = Object.keys(r.mapping || {}).length;
    const sel = (c) => `<label class="f"><span>${esc(c.label)}${c.required ? ' <b style="color:var(--bad)">*</b>' : ''}</span>
      <select data-map="${esc(c.id)}">${heads.includes(c.id) ? '' : '<option value="">— not in file —</option>'}${heads.map((h) => `<option value="${esc(h)}" ${cur[c.id] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`;
    return `<details class="up-map" ${open ? 'open' : ''}><summary><b>Column mapping</b> <span class="sub">${heads.length} column${heads.length === 1 ? '' : 's'} found${renamed ? ` · ${renamed} matched to a different name` : ' · all names used as they are'}</span></summary>
      <div class="form up-mapgrid">${f.columns.map(sel).join('')}</div>
      ${extras.length ? `<div class="up-sub">Also renamed so they work as placeholders: ${extras.map(([t, s]) => `"${esc(s)}" → <code>${esc(t)}</code>`).join(', ')}</div>` : ''}
      <div class="up-sub">Changing a column re-checks the file. Columns you don't map are kept under their own name.</div></details>`;
  }

  function counts(r, { result = false } = {}) {
    const cat = {};
    for (const [reason, n] of Object.entries(r.skipped || {})) { const c = r.byCategory ? null : catOf(reason); if (c) cat[c] = (cat[c] || 0) + n; }
    const byCat = r.byCategory || cat;
    const skippedTotal = Object.values(r.skipped || {}).reduce((a, b) => a + b, 0);
    const card = (cls, n, label, sub = '') => `<div class="up-card ${cls}${n ? '' : ' zero'}"><b>${fmt(n)}</b><span>${esc(label)}</span>${sub ? `<em>${sub}</em>` : ''}</div>`;
    return `<div class="up-cards">
      ${card('add', r.added, result ? `added to the ${laneTxt()}` : 'will be added', result ? '' : `to the ${esc(laneTxt())}`)}
      ${r.updated != null ? card('upd', r.updated, result ? 'updated' : 'will be updated', r.updatedColumns?.length ? `columns: ${esc(r.updatedColumns.slice(0, 6).join(', '))}${r.updatedColumns.length > 6 ? '…' : ''}` : 'already uploaded, not yet emailed') : ''}
      ${CAT_ORDER.filter((c) => c !== 'unverified' || byCat.unverified).map((c) => card(`c-${c}`, byCat[c] || 0, CAT_LABEL[c])).join('')}
    </div>
    ${skippedTotal ? `<details class="up-why"><summary class="sub">Every skip reason (${fmt(skippedTotal)} skipped)</summary>
      <table class="up-reasons">${Object.entries(r.skipped).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${fmt(v)}</td></tr>`).join('')}</table>
      ${r.samples?.length ? `<div class="sub" style="margin-top:8px">Examples: ${r.samples.slice(0, 12).map((x) => `${esc(x.email || '(no email)')} <span class="pill">${esc(x.reason)}</span>`).join(' ')}</div>` : ''}</details>` : ''}`;
  }
  const catOf = (reason) => { const s = String(reason); if (s === 'no email' || s === 'invalid address') return 'invalid'; if (s.startsWith('email_status')) return 'unverified';
    if (s === 'duplicate in this file') return 'duplicate'; if (s.startsWith('already') || s === 'in the extension history') return 'existing'; if (s.startsWith('role address')) return 'role'; return 'suppressed'; };

  function segTable(r) {
    const segs = Object.entries(r.bySegment || {}).sort((a, b) => b[1] - a[1]);
    if (!segs.length) return '';
    const laneSeg = (id) => UP_FORMAT?.segments?.find((s) => s.id === id)?.lanes?.[L()];
    return `<div class="up-block"><div class="up-h">By segment</div><table class="up-segs"><tr><th>Segment</th><th class="n">Contacts</th><th>First email uses</th><th></th></tr>
      ${segs.map(([id, n]) => { const t = laneSeg(id) || { template: id, ok: !(r.emptyTemplates || []).includes(id) };
        const ok = !(r.emptyTemplates || []).includes(t.template) && t.ok !== false;
        return `<tr><td><span class="dot" style="background:${segColor(id)};margin-right:7px"></span>${esc(segName(id))}</td><td class="n">${fmt(n)}</td><td>${esc(segName(t.template))}</td>
          <td>${ok ? '<span class="pill ok">template ready</span>' : '<span class="pill bad">no template: would be held back</span>'}</td></tr>`; }).join('')}</table></div>`;
  }

  function warnings(r) {
    const w = [];
    if ((r.emptyTemplates || []).length) w.push(`<div class="msg bad"><span><b>No matching template</b> for ${r.emptyTemplates.map((t) => esc(segName(t))).join(', ')}: its subject or body is empty, so these contacts would be held back at send time. Fill it on the Templates page${L() !== 'regular' ? ' or in this lane\'s options below' : ''} first.</span></div>`);
    const pw = Object.entries(r.placeholderWarnings || {}).filter(([k]) => !/template empty$/.test(k));
    if (pw.length) w.push(`<div class="msg warn"><span><b>Placeholder warnings</b> (held back at send time while "hold" is on): ${pw.map(([k, v]) => `${v} × ${esc(k)}`).join(' · ')}</span></div>`);
    if (r.laneAccounts === 0) w.push(`<div class="msg warn"><span><b>No sending account in the ${esc(laneTxt())}.</b> Contacts will wait in the queue until an account is assigned (Sending → Accounts).</span></div>`);
    if (r.truncated) w.push(`<div class="msg warn"><span>Only the first ${fmt(UP_FORMAT?.maxRows || 5000)} rows are read; ${fmt(r.truncated)} more rows are ignored. Split the file to import the rest.</span></div>`);
    return w.join('');
  }

  function previewTable(r) {
    const rows = r.previewRows || [];
    if (!rows.length) return '';
    const heads = r.mappedHeaders || [];
    const pref = ['email', 'first_name', 'name', 'company', 'segment', 'vertical', 'title', 'email_status'];
    let cols = pref.filter((c) => heads.includes(c) || (c === 'name' && rows.some((x) => x.row.name)));
    if (cols.includes('first_name') && cols.includes('name')) cols = cols.filter((c) => c !== 'name');
    for (const h of heads) if (cols.length < 6 && !cols.includes(h) && /^[a-z0-9_]{1,40}$/.test(h)) cols.push(h);
    cols = cols.slice(0, 6);
    const res = (x) => (x.add ? `<span class="pill ok">will add · ${esc(segName(x.template || x.segment))}</span>` : x.update ? '<span class="pill info">will update</span>'
      : `<span class="pill ${CAT_PILL[x.category] || ''}" title="${esc(x.reason)}">${esc(x.reason)}</span>`);
    return `<div class="up-block"><div class="up-h">First ${rows.length} row${rows.length === 1 ? '' : 's'}${r.rows > rows.length ? ` of ${fmt(r.rows)}` : ''}</div>
      <div class="tbl-wrap up-tbl"><table class="nowrap"><tr><th>#</th><th>${esc(cols[0] || 'email')}</th><th>Result</th>${cols.slice(1).map((c) => `<th>${esc(c)}</th>`).join('')}</tr>
      ${rows.map((x, i) => { const cell = (c) => `<td class="cell" title="${esc(x.row[c] ?? '')}">${esc(x.row[c] ?? '') || '<span class="sub">—</span>'}</td>`;
        return `<tr class="${x.add ? '' : 'skip'}"><td class="sub">${i + 1}</td>${cell(cols[0] || 'email')}<td>${res(x)}</td>${cols.slice(1).map(cell).join('')}</tr>`; }).join('')}</table></div></div>`;
  }

  function preview() {
    const r = S.rep;
    const again = '<button class="btn small" data-act="reset">Choose a different file</button>';
    if (S.stage === 'checking' || !r) return `${fileHead()}<div class="up-wait"><div class="spinner"></div><span>Checking every row against the lanes and do-not-email lists… nothing is imported yet.</span></div>`;
    const unv = r.headers?.includes('email_status') || S.unv
      ? `<label class="chk"><input type="checkbox" data-unv ${S.unv ? 'checked' : ''}> Include rows whose <code>email_status</code> is not "valid"</label>` : '';
    if (!r.ok) {
      const noEmail = r.error === 'no email column';
      return `${fileHead(again)}
        <div class="msg bad" style="margin-top:12px"><span>${noEmail
          ? '<b>No email column found.</b> Pick the column that holds the email address below, or rename it to <code>email</code> in the file.'
          : '<b>The file has no contact rows.</b> It needs a header line and at least one row under it.'}</span></div>
        ${noEmail ? mappingPanel(r, true) : ''}`;
    }
    const n = r.added, u = r.updated || 0;
    const already = Object.keys(r.skipped || {}).some((k) => k.startsWith('already uploaded'));
    const upd = already || S.upd
      ? `<label class="chk"><input type="checkbox" data-upd ${S.upd ? 'checked' : ''}> Update contacts already uploaded (not yet emailed) with this file's columns</label>` : '';
    const label = n && u ? `Import ${fmt(n)} and update ${fmt(u)}` : n ? `Import ${fmt(n)} contact${n === 1 ? '' : 's'} into the ${esc(laneTxt())}` : u ? `Update ${fmt(u)} contact${u === 1 ? '' : 's'}` : 'Nothing to import';
    return `${fileHead(again)}
      ${mappingPanel(r, r.headers && (!r.headers.includes('email') || Object.keys(r.mapping || {}).length > 0))}
      <div class="up-h" style="margin-top:14px">Preview <span class="sub" style="font-weight:400">· checked on the server with the same rules as the import, nothing saved yet</span></div>
      ${counts(r)}
      ${warnings(r)}
      ${segTable(r)}
      ${previewTable(r)}
      <div class="up-actions">
        <button class="btn primary" data-act="import" ${n || u ? '' : 'disabled'}>${label}</button>
        <button class="btn" data-act="reset">Cancel</button>
        ${unv}
        ${upd}
        <span class="sub grow" style="text-align:right">${r.paused ? 'Sending is paused: importing only adds them to the queue.' : 'Importing adds them to the queue; they are sent on the next sending days.'}</span>
      </div>`;
  }

  function importing() {
    return `${fileHead()}<div class="up-wait"><div class="spinner"></div><span>Importing ${fmt(S.rep?.added || 0)} contacts into the ${esc(laneTxt())}…</span></div>`;
  }

  function result() {
    const r = S.result, p = S.rep;
    const diff = p && p.added !== r.added;
    return `${fileHead()}
      <div class="up-done">${UP_ICON.ok}<div><b>${fmt(r.added)} contact${r.added === 1 ? '' : 's'} added to the ${esc(laneTxt())}${r.updated ? `, ${fmt(r.updated)} updated` : ''}</b>
        <span>${fmt(r.rows)} row${r.rows === 1 ? '' : 's'} read${r.truncated ? ` (only the first ${fmt(UP_FORMAT?.maxRows || 5000)})` : ''} · ${fmt(r.rows - r.added - (r.updated || 0) - (r.truncated || 0))} skipped. They are in the queue and go out on the next sending days, after one more suppression check right before each send.</span></div></div>
      ${diff ? `<div class="msg warn"><span>The preview said ${fmt(p.added)}; the lists changed in between (for example another upload), so the final numbers differ.</span></div>` : ''}
      ${counts(r, { result: true })}
      ${Object.keys(r.placeholderWarnings || {}).length ? `<div class="msg warn"><span><b>Placeholder warnings</b>: ${Object.entries(r.placeholderWarnings).map(([k, v]) => `${v} × ${esc(k)}`).join(' · ')}</span></div>` : ''}
      <div class="up-actions"><button class="btn primary" data-act="reset">${UP_ICON.up}Upload another file</button>
        <button class="btn" data-act="queue">See the queue</button></div>`;
  }

  function render() {
    host.innerHTML = `<div class="up">${S.stage === 'idle' ? idle() : S.stage === 'importing' ? importing() : S.stage === 'done' ? result() : preview()}</div>`;
  }

  async function runPreview() {
    set({ stage: 'checking', rep: null });
    const laneAt = L();
    try {
      const rep = await api('contacts.preview', { csv: S.text, lane: laneAt, includeUnverified: S.unv, mapping: S.mapping, updateExisting: S.upd });
      if (laneAt !== L() || S.stage !== 'checking') return;
      set({ stage: 'preview', rep, lane: laneAt });
    } catch (e) {
      if (e instanceof AuthError) return handleErr(e);
      set({ stage: 'idle', err: esc(e.message) });
    }
  }

  async function pick(file) {
    if (!file) return;
    const name = file.name || '';
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
    const bad = (msg) => set({ stage: 'idle', err: msg, file: null });
    if (['xlsx', 'xls', 'xlsm', 'ods', 'numbers'].includes(ext)) return bad(`<b>${esc(name)}</b> is a spreadsheet file. In Excel or Google Sheets use <b>File → Save as / Download → CSV (comma-separated)</b>, then upload that.`);
    if (ext && !['csv', 'txt'].includes(ext)) return bad(`<b>${esc(name)}</b> isn't a CSV file. Choose a <code>.csv</code> file.`);
    if (!file.size) return bad(`<b>${esc(name)}</b> is empty.`);
    if (file.size > UP_MAX_BYTES) return bad(`<b>${esc(name)}</b> is ${kb(file.size)}; one upload can be at most ${kb(UP_MAX_BYTES)}. Split it into smaller files.`);
    let text = '';
    try { text = await file.text(); } catch { return bad(`Couldn't read <b>${esc(name)}</b>.`); }
    if (/\u0000/.test(text.slice(0, 4096))) return bad(`<b>${esc(name)}</b> doesn't look like a text CSV. Save it as <b>CSV (comma-separated)</b> and try again.`);
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return bad(`<b>${esc(name)}</b> is empty.`);
    if (!lines[0].includes(',') && /[;\t]/.test(lines[0])) return bad(`<b>${esc(name)}</b> is separated by ${lines[0].includes(';') ? 'semicolons' : 'tabs'}, not commas. Save it as <b>CSV (comma-separated, UTF-8)</b> and try again.`);
    if (lines.length < 2) return bad(`<b>${esc(name)}</b> only has a header line and no contact rows.`);
    S.file = file; S.text = text; S.mapping = 'auto'; S.err = ''; S.result = null;
    runPreview();
  }

  async function doImport() {
    const r = S.rep; if (!r?.ok || !(r.added || r.updated)) return;
    const laneAt = S.lane || L();
    if (laneAt !== L()) { toast('The lane changed; check the preview again'); return runPreview(); }
    set({ stage: 'importing' });
    try {
      const mapping = Object.keys(r.mapping || {}).length ? r.mapping : undefined;
      const res = await api('contacts.upload', { csv: S.text, lane: laneAt, includeUnverified: S.unv, updateExisting: S.upd, ...(mapping ? { mapping } : {}) });
      set({ stage: 'done', result: res });
      toast(`${fmt(res.added)} contact${res.added === 1 ? '' : 's'} added to the ${LANE_LABEL[laneAt]} lane${res.updated ? `, ${fmt(res.updated)} updated` : ''}`);
      ov = null; onImported?.(res);
    } catch (e) {
      if (e instanceof AuthError) return handleErr(e);
      set({ stage: 'preview' });
      toast(`Import failed: ${e.message}`);
      host.querySelector('.up-actions')?.insertAdjacentHTML('beforebegin', `<div class="msg bad"><span><b>Import failed:</b> ${esc(e.message)}. Nothing was imported; try again.</span></div>`);
    }
  }

  function reset() { Object.assign(S, { stage: 'idle', file: null, text: '', rep: null, mapping: 'auto', unv: false, upd: false, err: '', result: null, over: false, lane: null }); render(); }

  host.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    e.preventDefault();
    const a = b.dataset.act;
    if (a === 'sample') downloadText(`contacts-sample${L() === 'regular' ? '' : `-${L()}`}.csv`, sampleCsv(UP_FORMAT));
    else if (a === 'reset') reset();
    else if (a === 'import') doImport();
    else if (a === 'queue') { if (L() === 'regular') show('queue'); else $('lQueue')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });
  host.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-dz]')) { e.preventDefault(); e.target.querySelector('[data-file]')?.click(); } });
  host.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-file]')) pick(t.files[0]);
    else if (t.matches('[data-unv]')) { S.unv = t.checked; runPreview(); }
    else if (t.matches('[data-upd]')) { S.upd = t.checked; runPreview(); }
    else if (t.matches('[data-map]')) {
      const m = { ...(S.rep?.mapping || {}) };
      host.querySelectorAll('[data-map]').forEach((s) => { const target = s.dataset.map; if (s.value && s.value !== target) m[target] = s.value; else delete m[target]; });
      S.mapping = Object.keys(m).length ? m : { _: '' };
      runPreview();
    }
  });
  host.addEventListener('dragover', (e) => { if (S.stage !== 'idle' || !e.dataTransfer?.types?.includes('Files')) return; e.preventDefault(); if (!S.over) { S.over = true; host.querySelector('[data-dz]')?.classList.add('over'); } });
  host.addEventListener('dragleave', (e) => { if (S.stage !== 'idle') return; if (!host.contains(e.relatedTarget)) { S.over = false; host.querySelector('[data-dz]')?.classList.remove('over'); } });
  host.addEventListener('drop', (e) => {
    if (S.stage !== 'idle') return; e.preventDefault(); S.over = false;
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length > 1) toast('One file at a time: using the first one');
    pick(files[0]);
  });
  render();
  return { reset, render: () => { if (S.stage === 'idle') render(); } };
}
// Dropping a file anywhere else must not navigate away from the dashboard.
window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
const upMain = makeUploader($('upMain'), { lane: () => 'regular' });

// ---------------------------------------------------------------- CONTACTS + SUPPRESSION
const SUPP_LABEL = { seedEmails: 'Bundled emails', seedDomains: 'Bundled domains', importedEmails: 'Imported emails', importedDomains: 'Imported domains', optout: 'Opt-outs', extension: 'From the extension' };
const SUPP_COLOR = { seedEmails: '#6366f1', seedDomains: '#a5b4fc', importedEmails: '#0ea5e9', importedDomains: '#7dd3fc', optout: '#a855f7', extension: '#94a3b8' };
loaders.contacts = async () => {
  const [c] = await Promise.all([api('supp.counts'), loadUploadFormat()]);
  upMain.render();
  const keys = Object.keys(SUPP_LABEL);
  $('suppCounts').innerHTML = keys.map((k) => `<div class="stat"><span><span class="dot" style="background:${SUPP_COLOR[k]};margin-right:6px"></span>${SUPP_LABEL[k]}</span><b>${fmt(c[k])}</b></div>`).join('');
  if (!keys.some((k) => c[k])) return empty('chSupp', 'No suppression lists yet', 'Import lists below.');
  chart('chSupp', { type: 'bar', data: { labels: keys.map((k) => SUPP_LABEL[k]), datasets: [{ data: keys.map((k) => c[k] || 0), backgroundColor: keys.map((k) => SUPP_COLOR[k]), maxBarThickness: 18 }] },
    options: { indexAxis: 'y', plugins: { tooltip: { callbacks: { label: (i) => ` ${fmt(i.raw)}` } } },
      scales: { x: axisY({ type: 'logarithmic', min: 1, ticks: { callback: (v) => ([1, 10, 100, 1000, 10000, 100000].includes(v) ? fmt(v) : '') } }), y: axisX() } } });
};
$('suppGo').onclick = async () => {
  const f = $('suppFile').files[0]; if (!f) return toast('Choose a file');
  const text = await f.text();
  let list; try { const j = JSON.parse(text); list = Array.isArray(j) ? j : Object.keys(j); } catch { list = text.split(/[\r\n,;]+/); }
  list = list.map((x) => String(x).trim()).filter(Boolean);
  const kind = $('suppKind').value;
  try { const r = await api('supp.import', { [kind]: list }); $('suppOut').textContent = `Read ${list.length}, valid ${r[kind]}, newly added ${r.added}.`; reload(); }
  catch (e) { handleErr(e); }
};
$('suppCheck').onclick = async () => {
  try { const r = await api('supp.check', { email: $('suppQ').value });
    $('suppOut').innerHTML = `<b>${esc(r.email)}</b>: first email → <span class="pill ${r.firstEmail ? 'bad' : 'ok'}">${esc(r.firstEmail || 'allowed')}</span> · follow-up → <span class="pill ${r.followUp ? 'bad' : 'ok'}">${esc(r.followUp || 'allowed')}</span>`; }
  catch (e) { handleErr(e); }
};
$('suppQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('suppCheck').click(); });

// Delete test data: preview what data.purge would remove, then delete exactly
// the previewed list (editing the list afterwards needs a new preview).
const EMAILS_IN = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const emailsIn = (text) => [...new Set((String(text).match(EMAILS_IN) || []).map((e) => e.toLowerCase()))];
let pgPlan = null;
function pgStale() { pgPlan = null; $('pgGo').disabled = true; }
function pgAdd(list) { $('pgList').value = [...new Set([...emailsIn($('pgList').value), ...list])].join('\n'); pgStale(); $('pgOut').innerHTML = ''; }
$('pgList').addEventListener('input', () => { pgStale(); $('pgOut').innerHTML = ''; });
$('pgFill').onclick = async () => {
  try { const o = await api('overview'); const add = o.settings.testRecipients || []; pgAdd(add); toast(`${add.length} test recipient${add.length === 1 ? '' : 's'} added`); }
  catch (e) { handleErr(e); }
};
$('pgFile').onchange = async () => {
  const f = $('pgFile').files[0]; if (!f) return;
  const found = emailsIn(await f.text()); $('pgFile').value = '';
  pgAdd(found); toast(`${found.length} address${found.length === 1 ? '' : 'es'} from ${f.name}`);
};
function purgeWhat(x) {
  const b = [];
  if (x.contact) b.push(`contact (${x.contact.status}${x.contact.lane && x.contact.lane !== 'regular' ? `, ${LANE_LABEL[x.contact.lane]} lane` : ''})`);
  if (x.queued) b.push('its place in the queue');
  if (x.planned) b.push(`${x.planned} planned send${x.planned === 1 ? '' : 's'}`);
  if (x.sent) b.push(`${x.sent.touches} email${x.sent.touches === 1 ? '' : 's'} sent from ${short(x.sent.account)}`);
  if (x.sent?.repliedAt) b.push('their reply');
  else if (x.sent?.autoReplyAt) b.push('an out-of-office');
  if (x.opens) b.push(`${x.opens} open record${x.opens === 1 ? '' : 's'}`);
  if (x.unsubscribes) b.push('an unsubscribe');
  if (x.logEntries) b.push(`${x.logEntries} send-log entr${x.logEntries === 1 ? 'y' : 'ies'}`);
  return b.length ? b.join(', ') : 'stored bookkeeping only';
}
function purgeTable(r) {
  const t = r.totals;
  return `<p class="cap" style="margin:0 0 8px"><b>${t.found} of ${t.addresses}</b> address${t.addresses === 1 ? ' has' : 'es have'} data to delete${t.emails ? `: ${t.emails} sent email${t.emails === 1 ? '' : 's'}, ${t.opens} open record${t.opens === 1 ? '' : 's'}, ${t.replies} repl${t.replies === 1 ? 'y' : 'ies'} in the feed` : ''}.</p>
    <div class="tbl-wrap"><table class="nowrap"><tr><th>Address</th><th>What will be deleted</th><th>Opt-out list</th></tr>${r.rows.map((x) =>
      `<tr><td>${esc(x.email)}</td><td class="wrap">${x.found ? esc(purgeWhat(x)) : '<span class="sub">nothing stored, nothing to do</span>'}</td><td>${x.optout ? '<span class="pill warn">on it</span>' : '<span class="sub">no</span>'}</td></tr>`).join('')}</table></div>`;
}
$('pgPreview').onclick = async () => {
  const emails = emailsIn($('pgList').value);
  if (!emails.length) return toast('List at least one address');
  pgStale(); $('pgOut').innerHTML = '<span class="sub">Looking…</span>';
  try {
    const r = await api('data.purge', { emails });
    pgPlan = { emails, rows: r.rows };
    $('pgOut').innerHTML = purgeTable(r);
    $('pgGo').disabled = !r.rows.some((x) => x.found || x.optout);
  } catch (e) { if (e instanceof AuthError) return handleErr(e); $('pgOut').innerHTML = `<div class="badbox">${esc(e.message)}</div>`; }
};
$('pgGo').onclick = async () => {
  if (!pgPlan) return;
  const optout = $('pgOptout').checked;
  const hit = pgPlan.rows.filter((x) => x.found || (optout && x.optout));
  if (!hit.length) return toast(pgPlan.rows.some((x) => x.optout) ? 'Only the opt-out list holds these; tick the box to remove them from it.' : 'Nothing to delete');
  const msg = `Delete the dashboard data of ${hit.length} address${hit.length === 1 ? '' : 'es'}?\n\n${hit.map((x) => `  • ${x.email}`).join('\n')}\n\n`
    + `Their contact records, sends, opens, replies and send-log entries are removed and stop counting in the rates.${optout ? ' They also come off the opt-out list.' : ''}`
    + ' Everyone else is untouched. A backup is kept for 180 days.';
  if (!confirm(msg)) return;
  $('pgGo').disabled = true; $('pgOut').innerHTML = '<span class="sub">Deleting…</span>';
  try {
    const r = await api('data.purge', { emails: pgPlan.emails, confirm: 'DELETE', alsoOptout: optout });
    pgPlan = null; an = null;
    $('pgOut').innerHTML = `<div class="msg ok">Deleted the data of ${r.deleted.length} address${r.deleted.length === 1 ? '' : 'es'}. The rates on the Overview now leave them out.${r.backupKey ? ` Backup: <code>${esc(r.backupKey)}</code>, kept 180 days.` : ''}</div>`;
    toast('Test data deleted');
    reload(true);
  } catch (e) { if (e instanceof AuthError) return handleErr(e); $('pgOut').innerHTML = `<div class="badbox">${esc(e.message)}</div>`; }
};

// ---------------------------------------------------------------- HOT LEADS (Work / Hot lanes)
let leadLane = 'work';
const TPL_FIRST_CHOICES = [['auto', 'Auto: route by CSV, like Regular'], ...TPL.filter(([id]) => id !== 'followup'), ['custom', "This lane's own template"]];
loaders.leads = async () => {
  const [o, q] = await Promise.all([api('overview'), api('queue.list', { lane: leadLane }), loadUploadFormat()]);
  ov = o; ACCOUNTS = ov.accounts.map((x) => x.account); sideStatus();
  const L = ov.lanes[leadLane], label = LANE_LABEL[leadLane];
  $('laneWhich').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.lane === leadLane));
  const accts = ov.accounts.filter((a) => a.lane === leadLane);
  $('laneStatus').innerHTML = (accts.length
    ? `<div class="msg ok"><span><b>${label} lane sends from:</b> ${accts.map((a) => `${esc(a.account)} ${!a.hasPassword ? `<span class="pill bad">no app password (${esc(a.passwordVar)})</span>` : a.paused ? '<span class="pill warn">paused</span>' : '<span class="pill ok">ready</span>'}`).join(' · ')}</span></div>`
    : `<div class="msg bad"><span><b>No account assigned to the ${label} lane.</b> Nothing in this lane will be sent, and it never falls back to the Regular accounts. Add or move an account under Sending → Accounts (Lane column, or "Add a sending account").</span></div>`)
    + `<div class="kv" style="margin-top:10px;font-size:12.5px"><span>Waiting</span><span>${fmt(L.queued)} lead${L.queued === 1 ? '' : 's'} in the ${label} queue</span>
       <span>Format</span><span>${L.plainText ? 'Plain text (no footer, no tracking) · opens are not tracked' : 'HTML with footer, logo and open tracking (like Regular)'}</span>
       <span>Daily cap</span><span>${L.cap} per account · window, gaps and sending days come from Sending → Schedule and safety</span>
       <span>Server sending</span><span>${ov.settings.paused ? '<span class="pill warn">paused (global)</span>' : '<span class="pill ok">on</span>'}</span></div>`;
  $('lUpTitle').textContent = `Upload leads to the ${label} lane (CSV)`; upLeads.render();
  $('lOptTitle').textContent = `Sending options: ${label} lane`; $('lTestTitle').textContent = `Test batch: ${label} lane`;
  $('lQTitle').textContent = `Waiting in the ${label} lane`; $('lQClear').textContent = `Clear the ${label} queue`;
  fillLaneForm(L);
  $('lQCap').textContent = `${fmt(q.total)} lead${q.total === 1 ? '' : 's'} waiting for a first email, oldest first${q.total > q.items.length ? ` (first ${q.items.length} shown)` : ''}`;
  $('lQueue').innerHTML = '<tr><th>#</th><th>Recipient</th><th>Name</th><th>Company</th><th>Template</th><th>Added</th><th></th></tr>' +
    (q.items.length ? q.items.map((x, i) => `<tr><td class="sub">${i + 1}</td><td>${esc(x.email)}</td><td>${esc(x.name)}</td><td>${esc(x.company)}</td>
      <td>${esc(TPL_LABEL[x.template] || x.template)}</td><td>${when(x.addedAt)}</td><td class="n"><button class="btn small ghost" data-lrm="${esc(x.email)}">Remove</button></td></tr>`).join('')
      : `<tr><td colspan="7" style="border:0;padding:0"><div class="empty" style="min-height:110px">${ICON.inbox}<b>No ${label} leads waiting</b><span>Upload a CSV above.</span></div></td></tr>`);
};
function fillLaneForm(L) {
  $('lPlain').checked = L.plainText; $('lOpt').checked = L.optOutLine; $('lOptText').value = L.optOutText; $('lFu').checked = L.followUps;
  $('lCap').value = L.cap;
  $('lTpl').innerHTML = TPL_FIRST_CHOICES.map(([id, l]) => `<option value="${id}" ${L.template === id ? 'selected' : ''}>${esc(l)}</option>`).join('');
  $('lFuTpl').value = L.followupTemplate;
  $('lCustSub').value = L.custom.subject; $('lCustBody').value = L.custom.body; $('lFuSub').value = L.followupCustom.subject; $('lFuBody').value = L.followupCustom.body;
  $('lCustBox').open = L.template === 'custom' || L.followupTemplate === 'custom';
  laneFormState();
}
function laneFormState() {
  const plain = $('lPlain').checked;
  $('lPlainNote').textContent = plain ? PLAIN_NOTE : 'Off: this lane sends HTML with the footer from Sending (with its unsubscribe link), the tracked logo and List-Unsubscribe, like Regular.';
  $('lOpt').disabled = !plain; $('lOptText').disabled = !plain || !$('lOpt').checked;
  if ($('lTpl').value === 'custom' || $('lFuTpl').value === 'custom') $('lCustBox').open = true;
}
for (const id of ['lPlain', 'lOpt', 'lTpl', 'lFuTpl']) $(id).addEventListener('change', laneFormState);
const laneForm = () => ({ [leadLane]: {
  plainText: $('lPlain').checked, optOutLine: $('lOpt').checked, optOutText: $('lOptText').value, followUps: $('lFu').checked, cap: +$('lCap').value,
  template: $('lTpl').value, followupTemplate: $('lFuTpl').value,
  custom: { subject: $('lCustSub').value, body: $('lCustBody').value }, followupCustom: { subject: $('lFuSub').value, body: $('lFuBody').value } } });
$('laneWhich').onclick = (e) => {
  const b = e.target.closest('button[data-lane]'); if (!b || b.dataset.lane === leadLane) return;
  leadLane = b.dataset.lane;
  for (const id of ['lPvBox', 'lTbOut']) $(id).innerHTML = '';
  upLeads.reset();
  $('lSaveStatus').textContent = ''; $('lTbStatus').textContent = '';
  reload();
};
$('lSave').onclick = async () => {
  const lanes = laneForm(), o = lanes[leadLane];
  const empty = (t) => !t.subject.trim() || !t.body.trim();
  if ((o.template === 'custom' && empty(o.custom)) || (o.followupTemplate === 'custom' && empty(o.followupCustom))) {
    if (!confirm("This lane's own template is chosen but its subject or body is empty. Those emails will be held back (placeholder check). Save anyway?")) return;
  }
  if (!o.plainText && ov?.lanes?.[leadLane]?.plainText && !confirm(`Turn plain text OFF for the ${LANE_LABEL[leadLane]} lane? Its emails would then carry the footer, logo and open tracking.`)) return;
  try { await api('lanes.save', { lanes }); $('lSaveStatus').textContent = 'saved; plans not yet started are rebuilt'; toast(`${LANE_LABEL[leadLane]} lane options saved`); reload(); }
  catch (e) { handleErr(e); }
};
async function lanePreview(which) {
  try {
    const d = await api('lane.preview', { lane: leadLane, which, lanes: laneForm() });
    const src = { queue: `${LANE_LABEL[leadLane]} lead ${(d.index ?? 0) + 1} of ${d.of}`, sample: 'built-in sample row (no leads in this lane yet)' }[d.source] || d.source;
    const w = [];
    if (d.problems.missing.length) w.push(`<div class="msg bad">Column missing, would be held back: ${d.problems.missing.map((f) => `<code>{{${esc(f)}}}</code>`).join(' ')}</div>`);
    if (d.problems.empty.length) w.push(`<div class="msg warn">Empty for this lead: ${d.problems.empty.map((f) => `<code>{{${esc(f)}}}</code>`).join(' ')}</div>`);
    if (d.problems.emptyTemplate) w.push('<div class="msg bad">Subject or body is empty; emails would be held back.</div>');
    $('lPvBox').innerHTML = `<p class="cap" style="margin:0 0 6px">${which === 'followup' ? 'Follow-up' : 'First email'} · ${esc(TPL_LABEL[d.templateId] || d.templateId)} · to ${esc(d.to)} (${esc(src)}) · from ${esc(d.account || 'no account assigned')} · ${d.plain ? '<b>plain text</b>, no footer, no tracking' : 'HTML with footer and tracking'}</p>${w.join('')}
      <div class="pv"><div class="pv-sub">${esc(d.subject)}</div>${esc(d.text)}</div>`;
    if (!d.plain) { const f = mailFrame(d.html); f.style.marginTop = '10px'; $('lPvBox').appendChild(f); }
  } catch (e) { if (e instanceof AuthError) return handleErr(e); $('lPvBox').innerHTML = `<div class="msg bad">${esc(e.message)}</div>`; }
}
$('lPvGo').onclick = () => lanePreview('first');
$('lPvFu').onclick = () => lanePreview('followup');
const upLeads = makeUploader($('upLeads'), { lane: () => leadLane, onImported: () => reload(true) });
$('lTbGo').onclick = () => runTestBatch(leadLane, 'lTbStatus', 'lTbOut');
$('lTfGo').onclick = () => runTestFollowUp(leadLane, 'lTbStatus', 'lTbOut');
$('lQueue').onclick = async (e) => { const rm = e.target.dataset.lrm; if (rm && confirm(`Remove ${rm} from the ${LANE_LABEL[leadLane]} queue?`)) { try { await api('queue.remove', { email: rm }); reload(); } catch (err) { handleErr(err); } } };
$('lQClear').onclick = async () => { if (confirm(`Remove every waiting lead from the ${LANE_LABEL[leadLane]} lane? The other lanes are not touched.`)) { try { const d = await api('queue.clear', { lane: leadLane }); toast(`${d.removed} removed`); reload(); } catch (e) { handleErr(e); } } };

// ---------------------------------------------------------------- boot
(async function boot() {
  SERVER = await probe();
  if (PW && SERVER?.adminConfigured) {
    try { const o = await api('overview'); enterApp(o); return; }
    catch (e) { if (!(e instanceof AuthError)) { showLogin({ error: `Couldn't load the dashboard: ${e.message}` }); return; } PW = ''; sessionStorage.removeItem('adminPw'); }
  }
  showLogin();
})();

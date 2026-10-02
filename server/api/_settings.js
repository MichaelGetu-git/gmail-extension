// Settings for server-side sending, kept apart from mailer:config (which the
// extension polls) so nothing here can change how the extension behaves.
//
// Everything defaults to the safe side: paused until an admin unpauses.
import { command, configured, pipeline } from './_store.js';
import { DEFAULT_FOOTER, PREVIOUS_DEFAULT_FOOTER, EMAIL_RE, TEMPLATE_IDS } from './_render.js';

export const K = {
  settings: 'mailer:srv:settings',
  acct: 'mailer:srv:acct',               // hash account -> {paused, reason, at, auto, ...}
  lock: 'mailer:srv:lock',
  lastTick: 'mailer:srv:lastTick',
  fixItemIds: 'mailer:srv:fix:itemIds',  // set once the shared-name plan repair has run (requeueStranded)
  contacts: 'mailer:srv:contacts',       // hash email -> contact JSON
  queue: 'mailer:srv:queue',             // list of emails waiting for a first email (Regular lane)
  queueOf: (lane) => (lane && lane !== 'regular' ? `mailer:srv:queue:${lane}` : 'mailer:srv:queue'),
  sent: 'mailer:srv:sent',               // hash email -> record of every server send to them
  tokens: 'mailer:srv:tokens',           // hash token -> email (server-sent mail only)
  touch: 'mailer:srv:touch',             // hash "email#n" -> item id; the never-twice guard
  fu: 'mailer:srv:fu',                   // zset email -> lastSentAt (candidates for a follow-up)
  byAcct: (a) => `mailer:srv:byacct:${a}`,   // zset email -> lastSentAt, per sending account
  recent: (a) => `mailer:srv:recent:${a}`,   // list: last 50 recipients, per account
  last: (a) => `mailer:srv:last:${a}`,       // ms of the account's last actual send
  count: (d) => `mailer:srv:count:${d}`,     // hash account -> attempts that day (hard cap)
  plan: (d) => `mailer:srv:plan:${d}`,       // hash: meta + item id -> item JSON
  plans: 'mailer:srv:plans',             // set of plan dates still holding reservations
  log: 'mailer:srv:log',                 // list of log entries (newest first)
  logBody: 'mailer:srv:logbody',         // hash log id -> {subject, text, html}
  replies: 'mailer:srv:replies',         // list of detected replies and auto-replies (newest first, last 500)
  lastReply: 'mailer:srv:lastReplyAt',   // ms of the newest real reply, for the dashboard's "new replies" badge
  suppEmails: 'mailer:srv:supp:emails',  // set
  suppDomains: 'mailer:srv:supp:domains',// set
  optout: 'mailer:srv:optout',           // set: unsubscribed / never email again (applies to follow-ups too)
  extContacted: 'mailer:ext:contacted',  // set, pushed by the extension from its history
  unsubSeen: 'mailer:srv:unsubSeen',     // count of mailer:unsub entries already mapped
  configHistory: 'mailer:config:history',
  leadsClaimed: 'mailer:leads:claimed',  // the extension's claimed leads (leads.js)
  leadDesk: 'leaddesk:state',            // the Lead Desk, if it shares this database
};

// ---- sending lanes
// Regular is the original setup (every existing account and contact). Work and
// Hot are separate lanes with their own accounts, contacts and queue. A lane's
// contacts only ever go out from that lane's accounts; a lane with no account
// assigned sends nothing (never falls back to another lane).
export const LANES = ['regular', 'work', 'hot'];
export const LANE_LABEL = { regular: 'Regular', work: 'Work', hot: 'Hot' };
export const DEFAULT_OPTOUT = "If you'd rather not hear from me again, just reply and let me know.";
const LANE_DEFAULTS = {
  regular: { plainText: false, optOutLine: false, optOutText: DEFAULT_OPTOUT },
  work: { plainText: true, optOutLine: false, optOutText: DEFAULT_OPTOUT, cap: 15, followUps: true,
    template: 'auto', followupTemplate: 'followup', custom: { subject: '', body: '' }, followupCustom: { subject: '', body: '' } },
  hot: { plainText: true, optOutLine: false, optOutText: DEFAULT_OPTOUT, cap: 15, followUps: true,
    template: 'auto', followupTemplate: 'followup', custom: { subject: '', body: '' }, followupCustom: { subject: '', body: '' } },
};
export const FIRST_TEMPLATE_CHOICES = ['auto', ...TEMPLATE_IDS.filter((t) => t !== 'followup'), 'custom'];
export const CATEGORY_IDS = TEMPLATE_IDS.filter((t) => t !== 'followup');
export const FOLLOWUP_TEMPLATE_CHOICES = ['followup', 'custom'];

export const DEFAULT_SETTINGS = {
  paused: true,
  dryRun: false,
  windowStart: '09:00',
  windowEnd: '11:30',
  weekdays: [1, 2, 3, 4, 5],
  perAccountCap: 15,
  minGapMin: 3,
  maxGapMin: 8,
  lateCutoff: '18:00',
  followUps: true,
  // At most this many of an account's daily sends are follow-ups; the rest of
  // its cap goes to new contacts. Follow-ups over the limit wait, oldest first.
  followUpsPerDay: 5,
  replyCheckHours: 24,
  footer: DEFAULT_FOOTER,
  listUnsubscribe: true,
  skipRoleAddresses: true,
  freemailDomainExempt: true,
  blockOnPlaceholderIssues: true,
  // Use a contact's own subject_line / opening_line from the CSV. Off: every
  // first email is the dashboard template for the contact's category.
  personalLines: false,
  // Categories (first-email templates) that get no emails: their contacts wait
  // in the queue, and contacts already emailed with them get no follow-up,
  // until the category is switched back on.
  skipTemplates: ['va'],
  // Who "Send test batch now" may email. Only queued contacts on this list are
  // ever touched by that button; it bypasses the pause and window for them only.
  testRecipients: ['michaelgetu21@gmail.com', 'michaelgetu07@gmail.com', 'mickgetu@gmail.com'],
  // Per-lane sending options, and which lane each account sends for
  // (accounts not listed are Regular). Both are missing from settings saved
  // before lanes existed; readSettings fills in the defaults.
  lanes: LANE_DEFAULTS,
  accountLanes: {},
  updatedAt: 0,
};
export const TEST_RECIPIENTS_MAX = 10;
export function cleanRecipients(v, d = []) {
  if (v === undefined) return d;
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
  return [...new Set(arr.map((x) => String(x || '').trim().toLowerCase()).filter((x) => EMAIL_RE.test(x)))].slice(0, TEST_RECIPIENTS_MAX);
}
export const CAP_MAX = 40;

const int = (v, lo, hi, d) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
export const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
// Any time of day. Times earlier than the window start mean the next morning
// (see dayWindow), so nothing here needs ordering.
const time = (v, d, lo = 0, hi = 24 * 60 - 1) => {
  const m = toMin(v);
  return Number.isFinite(m) ? hhmm(Math.min(hi, Math.max(lo, m))) : d;
};

const tpl = (v, d) => ({
  subject: v && typeof v === 'object' && v.subject !== undefined ? String(v.subject).slice(0, 300) : d.subject,
  body: v && typeof v === 'object' && v.body !== undefined ? String(v.body).slice(0, 6000) : d.body,
});

// Lane options, rebuilt from known fields with bounds. `input` may be partial
// (one lane, one field); everything else comes from `prev`, then the defaults.
export function cleanLanes(input, prev) {
  const out = {};
  for (const lane of LANES) {
    const d = LANE_DEFAULTS[lane];
    const p = { ...d, ...((prev && typeof prev === 'object' && prev[lane]) || {}) };
    const i = (input && typeof input === 'object' && input[lane]) || {};
    const o = {
      plainText: bool(i.plainText, bool(p.plainText, d.plainText)),
      optOutLine: bool(i.optOutLine, bool(p.optOutLine, d.optOutLine)),
      optOutText: (i.optOutText !== undefined ? String(i.optOutText) : String(p.optOutText ?? d.optOutText)).replace(/\s+/g, ' ').trim().slice(0, 300) || d.optOutText,
    };
    if (lane !== 'regular') {
      o.cap = int(i.cap, 1, CAP_MAX, int(p.cap, 1, CAP_MAX, d.cap));
      o.followUps = bool(i.followUps, bool(p.followUps, d.followUps));
      o.template = FIRST_TEMPLATE_CHOICES.includes(i.template) ? i.template : FIRST_TEMPLATE_CHOICES.includes(p.template) ? p.template : d.template;
      o.followupTemplate = FOLLOWUP_TEMPLATE_CHOICES.includes(i.followupTemplate) ? i.followupTemplate
        : FOLLOWUP_TEMPLATE_CHOICES.includes(p.followupTemplate) ? p.followupTemplate : d.followupTemplate;
      o.custom = tpl(i.custom, tpl(p.custom, d.custom));
      o.followupCustom = tpl(i.followupCustom, tpl(p.followupCustom, d.followupCustom));
    }
    out[lane] = o;
  }
  return out;
}

// { account: lane } for Work/Hot accounts only; Regular is the default and is
// never stored, so settings saved before lanes existed mean "all Regular".
export function cleanAccountLanes(input, prev = {}) {
  const src = input && typeof input === 'object' ? { ...(prev || {}), ...input } : (prev || {});
  const out = {};
  for (const [a, l] of Object.entries(src).slice(0, 50)) {
    const e = String(a || '').trim().toLowerCase();
    if (EMAIL_RE.test(e) && LANES.includes(l) && l !== 'regular') out[e] = l;
  }
  return out;
}

export const laneOf = (settings, account) => {
  const l = (settings?.accountLanes || {})[String(account || '').toLowerCase()];
  return LANES.includes(l) ? l : 'regular';
};
export const contactLane = (c) => (c && LANES.includes(c.lane) ? c.lane : 'regular');
export const laneOpts = (settings, lane) => cleanLanes(undefined, settings?.lanes)[LANES.includes(lane) ? lane : 'regular'];
export const laneCap = (settings, lane) => (lane && lane !== 'regular' ? laneOpts(settings, lane).cap : settings.perAccountCap);
export const normLane = (v) => (LANES.includes(v) ? v : 'regular');

export function cleanSettings(input = {}, prev = DEFAULT_SETTINGS) {
  const p = { ...DEFAULT_SETTINGS, ...prev };
  const s = {
    paused: bool(input.paused, p.paused),
    dryRun: bool(input.dryRun, p.dryRun),
    windowStart: time(input.windowStart, p.windowStart),
    windowEnd: time(input.windowEnd, p.windowEnd),
    weekdays: Array.isArray(input.weekdays)
      ? [...new Set(input.weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : p.weekdays,
    perAccountCap: int(input.perAccountCap, 1, CAP_MAX, p.perAccountCap),
    minGapMin: int(input.minGapMin, 1, 60, p.minGapMin),
    maxGapMin: int(input.maxGapMin, 1, 90, p.maxGapMin),
    lateCutoff: time(input.lateCutoff, p.lateCutoff),
    followUps: bool(input.followUps, p.followUps),
    followUpsPerDay: int(input.followUpsPerDay, 1, CAP_MAX, p.followUpsPerDay),
    replyCheckHours: int(input.replyCheckHours, 1, 168, p.replyCheckHours),
    footer: input.footer !== undefined ? String(input.footer).slice(0, 1000) : p.footer,
    listUnsubscribe: bool(input.listUnsubscribe, p.listUnsubscribe),
    skipRoleAddresses: bool(input.skipRoleAddresses, p.skipRoleAddresses),
    freemailDomainExempt: bool(input.freemailDomainExempt, p.freemailDomainExempt),
    blockOnPlaceholderIssues: bool(input.blockOnPlaceholderIssues, p.blockOnPlaceholderIssues),
    personalLines: bool(input.personalLines, p.personalLines),
    skipTemplates: Array.isArray(input.skipTemplates)
      ? [...new Set(input.skipTemplates.filter((t) => CATEGORY_IDS.includes(t)))]
      : p.skipTemplates,
    testRecipients: cleanRecipients(input.testRecipients, p.testRecipients),
    lanes: cleanLanes(input.lanes, p.lanes),
    accountLanes: cleanAccountLanes(input.accountLanes, p.accountLanes),
    updatedAt: Date.now(),
  };
  // The latest start is never after the last send.
  const w = dayWindow(s);
  if (relMin(s, s.windowEnd) > w.cutoff) s.windowEnd = s.lateCutoff;
  if (s.maxGapMin < s.minGapMin) s.maxGapMin = s.minGapMin;
  if (!/\{\{unsubscribe(_url)?\}\}/i.test(s.footer)) s.footer = `${s.footer.trim()}\n{{unsubscribe}}`.trim();
  return s;
}

// Settings saved before lanes existed have no `lanes` / `accountLanes`: every
// account is then Regular and the lanes get their defaults.
const withLanes = (s) => ({ ...s, lanes: cleanLanes(undefined, s.lanes), accountLanes: cleanAccountLanes(undefined, s.accountLanes) });
export async function readSettings() {
  if (!configured) return withLanes({ ...DEFAULT_SETTINGS });
  const raw = await command('GET', K.settings);
  if (!raw) return withLanes({ ...DEFAULT_SETTINGS });
  try { return withLanes(upgradeFooter({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) })); } catch { return withLanes({ ...DEFAULT_SETTINGS, paused: true }); }
}

// A footer still saved with exactly the previous default wording is read as
// the current default; a footer anyone has edited is left as it is.
const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();
const sameText = (a, b) => norm(a) === norm(b);
function upgradeFooter(s) {
  if (sameText(s.footer, PREVIOUS_DEFAULT_FOOTER)) s.footer = DEFAULT_FOOTER;
  return s;
}

export async function writeSettings(s) {
  await command('SET', K.settings, JSON.stringify(s));
  return s;
}

export async function readAccountStates() {
  const flat = (await command('HGETALL', K.acct)) || [];
  const out = {};
  for (let i = 0; i < flat.length; i += 2) { try { out[flat[i]] = JSON.parse(flat[i + 1]); } catch { /* skip */ } }
  return out;
}

// Read-modify-write under the caller's lock (the tick holds the global lock;
// admin edits are rare and touch different fields).
export async function patchAccountState(account, patch) {
  const raw = await command('HGET', K.acct, account);
  let cur = {};
  try { cur = raw ? JSON.parse(raw) : {}; } catch { cur = {}; }
  const next = { ...cur, ...patch };
  await command('HSET', K.acct, account, JSON.stringify(next));
  return next;
}

// App passwords live only in env vars, one per account:
//   daniellzelalem@gmail.com -> GMAIL_APP_PASSWORD_DANIELLZELALEM
// The value is only ever handed to nodemailer/imapflow, never logged or returned.
export const passwordVar = (account) =>
  `GMAIL_APP_PASSWORD_${String(account).split('@')[0].toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
export const hasPassword = (account) => Boolean(process.env[passwordVar(account)]);
export const getPassword = (account) => String(process.env[passwordVar(account)] || '').replace(/\s+/g, '');

// The mail server an account signs in to. Gmail and Google Workspace use
// Google's, which is the default, so those accounts need nothing here. A domain
// whose mail is hosted elsewhere (cPanel and the like) names its server once:
//   dawit@africanrecruitment.com -> MAIL_SERVER_AFRICANRECRUITMENT_COM=mail.africanrecruitment.com
// SMTP is then that host on 465 and IMAP on 993 (both TLS), with the password above.
export const serverVar = (account) =>
  `MAIL_SERVER_${String(account).split('@').pop().toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
export function mailServer(account) {
  const host = String(process.env[serverVar(account)] || '').trim().toLowerCase();
  return host ? { smtp: host, imap: host, custom: true } : { smtp: 'smtp.gmail.com', imap: 'imap.gmail.com', custom: false };
}

// ---- time, always Africa/Nairobi (UTC+3, no daylight saving)
export const EAT_OFFSET = 3 * 3600000;
export const DAY = 86400000;
export const eatDate = (ms) => new Date(ms + EAT_OFFSET).toISOString().slice(0, 10);
export const eatWeekday = (dateKey) => new Date(`${dateKey}T00:00:00Z`).getUTCDay();
// ms timestamp of HH:MM (minutes since midnight) EAT on that date
export const eatAt = (dateKey, minutes) => Date.parse(`${dateKey}T00:00:00Z`) - EAT_OFFSET + minutes * 60000;
export const eatClock = (ms) => new Date(ms + EAT_OFFSET).toISOString().slice(11, 16);
export const addDays = (dateKey, n) => new Date(Date.parse(`${dateKey}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
// ---- the sending day
// A sending day opens at windowStart on its date. windowEnd (the latest start)
// and lateCutoff (no sends after) earlier than the start fall on the next
// morning: 17:00 / 17:00 / 06:00 is Monday 17:00 -> Tuesday 06:00, all of it
// Monday's run (its plan, its daily cap, its weekday). A cutoff equal to the
// start is a full 24 hours. Minutes are counted from the sending day's
// midnight, so they can pass 1440; eatAt(date, minutes) takes them as they are.
const relMin = (s, hhmm) => { const m = toMin(hhmm), st = toMin(s.windowStart); return m < st ? m + 24 * 60 : m; };
export function dayWindow(s) {
  const start = toMin(s.windowStart);
  const c = toMin(s.lateCutoff);
  const cutoff = c <= start ? c + 24 * 60 : c;
  return { start, end: Math.min(relMin(s, s.windowEnd), cutoff), cutoff };
}
// The run a moment belongs to: at Tue 02:00 with a 17:00 -> 06:00 window that
// is Monday's; otherwise the calendar date (EAT). With a window that ends the
// same day it is always the calendar date.
export function sendingDay(now, s) {
  const d = eatDate(now), prev = addDays(d, -1);
  return now < eatAt(prev, dayWindow(s).cutoff) ? prev : d;
}

export function nextWeekday(dateKey, weekdays) {
  for (let i = 1; i <= 7; i++) {
    const d = addDays(dateKey, i);
    if (weekdays.includes(eatWeekday(d))) return d;
  }
  return addDays(dateKey, 1);
}

export { pipeline };

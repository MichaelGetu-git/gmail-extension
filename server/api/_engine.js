// Server-side sending: the contact queue, each day's randomized plan, the tick
// that sends whatever is due, the send log, bounce/reply scanning and health.
//
// Never-twice guarantees, from the outside in:
//   1. one tick at a time (Redis lock, SET NX PX, released only by its owner)
//   2. every recipient is re-checked against every suppression source right
//      before sending, whatever the plan said
//   3. HSETNX mailer:srv:touch "email#n" before the SMTP call: the first touch
//      and each follow-up can be claimed exactly once, ever
//   4. an item is marked "sending" before the network call, so a crash mid-send
//      leaves it out of every later tick instead of retrying it
//   5. the hard per-account daily cap is an atomic HINCRBY, checked per send
import { command, pipeline } from './_store.js';
import {
  K, readSettings, readAccountStates, patchAccountState, hasPassword, passwordVar, mailServer, serverVar,
  DAY, eatDate, eatWeekday, eatAt, eatClock, toMin, addDays, nextWeekday, dayWindow, sendingDay,
  LANES, LANE_LABEL, laneOf, laneOpts, laneCap, contactLane, normLane,
} from './_settings.js';
import { readConfig } from './config.js';
import { renderEmail, newToken, routeContact, normEmail, EMAIL_RE, parseCsv, withWording, problems, personalise, SEGMENTS } from './_render.js';
import { checkMany, checkOne, syncUnsubscribes } from './_suppress.js';
import { transportFor, classifySmtpError } from './_smtp.js';
import { scanInbox, msgIds } from './_imap.js';

let rand = Math.random;
export function setRandom(f) { rand = f; }

const FINAL = new Set(['sent', 'failed', 'bounced', 'skipped']);
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
export const accountsOf = (config) => Object.keys(config.senders || {});
// The name and nickname an account's emails use (renderEmail's senderName / nickName).
export const senderOf = (config, account) => ({ senderName: (config.senders || {})[account] || '', nickName: (config.nicknames || {})[account] || '' });
// The From header: the account's name exactly as set ("Dawit @ ZemenayTech");
// just the address when no name is set.
export function fromHeader(name, account) {
  const n = String(name || '').trim();
  return n ? { name: n, address: account } : account;
}
// The accounts that send for one lane (Regular = every account not assigned
// to Work or Hot). Never falls back: an empty list means the lane sends nothing.
export const laneAccounts = (config, settings, lane) => accountsOf(config).filter((a) => laneOf(settings, a) === normLane(lane));

// ------------------------------------------------------------------ lanes: templates and rendering
//
// Work and Hot may pick a Regular template, route like Regular ('auto'), or
// use their own template (stored in the lane's settings, never in
// mailer:config, so the extension is untouched). Lane templates render under
// the ids "work", "hot", "work-followup" and "hot-followup".
export function templatesFor(config, settings) {
  const t = { ...config.templates };
  for (const lane of LANES) {
    if (lane === 'regular') continue;
    const o = laneOpts(settings, lane);
    t[lane] = o.custom;
    t[`${lane}-followup`] = o.followupCustom;
  }
  return t;
}
export function firstTemplateFor(settings, lane, routed) {
  if (normLane(lane) === 'regular') return routed;
  const o = laneOpts(settings, lane);
  return o.template === 'auto' ? routed : o.template === 'custom' ? lane : o.template;
}
export function followupTemplateFor(settings, lane) {
  if (normLane(lane) === 'regular') return 'followup';
  return laneOpts(settings, lane).followupTemplate === 'custom' ? `${lane}-followup` : 'followup';
}
// Footer/plain-text options for renderEmail, per lane.
export function renderOptsFor(settings, lane) {
  const o = laneOpts(settings, lane);
  if (!o.plainText) return { plain: false, footer: settings.footer };
  return { plain: true, optOut: o.optOutLine ? o.optOutText : '', footer: '' };
}
const laneTag = (lane) => (normLane(lane) === 'regular' ? {} : { lane });
const UNLOCK = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

// ------------------------------------------------------------------ locking

export async function acquireLock(ttlMs = 90000) {
  const id = newToken();
  const ok = await command('SET', K.lock, id, 'NX', 'PX', ttlMs);
  return ok === 'OK' ? id : null;
}
export async function releaseLock(id) {
  if (id) await command('EVAL', UNLOCK, 1, K.lock, id);
}
// Admin changes that touch plans or the queue wait briefly for a running tick.
export async function withLock(fn, { waitMs = 8000 } = {}) {
  const until = Date.now() + waitMs;
  let id = await acquireLock(60000);
  while (!id && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 400));
    id = await acquireLock(60000);
  }
  if (!id) { const e = new Error('a send is in progress, try again in a minute'); e.status = 409; throw e; }
  try { return await fn(); } finally { await releaseLock(id); }
}

// ------------------------------------------------------------------ contacts

const cleanRow = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row).slice(0, 60)) {
    if (/^[a-z0-9_]{1,40}$/.test(k)) out[k] = String(v ?? '').slice(0, 1000);
  }
  return out;
};

// ---- upload format: what the server actually reads from a contact CSV.
// The dashboard builds its column note, column mapping and sample CSV from this.
export const CONTACT_COLUMNS = [
  { id: 'email', label: 'Email', required: true, use: 'the address (required)' },
  { id: 'first_name', label: 'First name', use: '{{first_name}}; with last_name it fills {{name}} when there is no name column' },
  { id: 'last_name', label: 'Last name', use: 'joined with first_name into {{name}}' },
  { id: 'name', label: 'Full name', use: '{{name}}' },
  { id: 'company', label: 'Company', use: '{{company}}, and shown in the queue' },
  { id: 'segment', label: 'Segment', use: 'picks the template: a segment id or label (see below)' },
  { id: 'vertical', label: 'Industry / vertical', use: 'routes to a segment when there is no segment column' },
  { id: 'title', label: 'Job title', use: 'also used for routing' },
  { id: 'email_status', label: 'Email status', use: 'if present, only rows with "valid" load (unless "Include unverified rows" is ticked)' },
];
// Other columns the routing reads, and ones with built-in fallbacks.
export const ROUTING_COLUMNS = ['category', 'osm_type', 'detail', 'eng_roles', 'support_roles'];
export const WORDING_COLUMNS = ['business_type', 'pain'];
const ALIASES = {
  email: ['email', 'e_mail', 'email_address', 'e_mail_address', 'mail', 'work_email', 'business_email', 'contact_email', 'email_1', 'primary_email', 'emailaddress'],
  first_name: ['first_name', 'firstname', 'first', 'given_name', 'fname', 'forename'],
  last_name: ['last_name', 'lastname', 'last', 'surname', 'family_name', 'lname'],
  name: ['name', 'full_name', 'fullname', 'contact_name', 'contact_person', 'person'],
  company: ['company', 'company_name', 'companyname', 'organization', 'organisation', 'organization_name', 'organisation_name', 'org', 'business', 'business_name', 'account_name', 'employer'],
  segment: ['segment', 'template'],
  vertical: ['vertical', 'industry', 'sector', 'niche'],
  title: ['title', 'job_title', 'jobtitle', 'position', 'role'],
  email_status: ['email_status', 'emailstatus'],
};
export const headerKey = (h) => String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

// Suggested {target: sourceHeader}: known columns under another name
// ("Email Address", "Company Name"), plus any header that only needs
// normalising to become a usable {{placeholder}} ("hours gap" -> hours_gap).
export function suggestMapping(headers) {
  const have = new Set(headers);
  const used = new Set();
  const out = {};
  for (const [target, names] of Object.entries(ALIASES)) {
    if (have.has(target)) { used.add(target); continue; }
    const src = headers.find((h) => !used.has(h) && !ALIASES[h] && names.includes(headerKey(h)));
    if (src) { out[target] = src; used.add(src); }
  }
  for (const h of headers) {
    if (used.has(h) || /^[a-z0-9_]{1,40}$/.test(h)) continue;
    const k = headerKey(h);
    if (k && !have.has(k) && out[k] === undefined) { out[k] = h; used.add(h); }
  }
  return out;
}

// Apply {target: sourceHeader} to parsed rows: the source column is renamed
// to the target. Only used when the caller passes a mapping, so plain uploads
// behave exactly as before.
export function applyMapping(parsed, mapping) {
  const pairs = Object.entries(mapping || {})
    .map(([t, s]) => [headerKey(t), String(s || '').trim().toLowerCase()])
    .filter(([t, s]) => t && s && t !== s && parsed.headers.includes(s));
  if (!pairs.length) return { ...parsed, applied: {} };
  // One source column may feed several targets (e.g. email and name).
  const renamed = new Map();
  for (const [t, s] of pairs) renamed.set(s, [...(renamed.get(s) || []), t]);
  const targets = new Set(pairs.map(([t]) => t));
  const headers = [...new Set(parsed.headers.flatMap((h) => (renamed.has(h) ? renamed.get(h) : targets.has(h) ? [] : [h])))];
  const rows = parsed.rows.map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) {
      if (renamed.has(k) || targets.has(k)) continue;   // renamed, or replaced by a mapped column
      o[k] = v;
    }
    for (const [t, s] of pairs) o[t] = r[s] ?? '';
    // parseCsv fills name from first/last; do it again for mapped columns.
    if (!String(o.name || '').trim() && (o.first_name || o.last_name)) o.name = [o.first_name, o.last_name].filter(Boolean).join(' ');
    return o;
  });
  return { headers, rows, applied: Object.fromEntries(pairs) };
}

// Which bucket each skip reason falls into, for the upload preview.
export function skipCategory(reason) {
  const r = String(reason || '');
  if (r === 'no email' || r === 'invalid address') return 'invalid';
  if (r.startsWith('email_status')) return 'unverified';
  if (r === 'duplicate in this file') return 'duplicate';
  if (r.startsWith('already') || r === 'in the extension history') return 'existing';
  if (r.startsWith('role address')) return 'role';
  return 'suppressed';
}
export const SKIP_CATEGORIES = {
  invalid: 'Invalid or missing email', unverified: 'Not verified (email_status)', duplicate: 'Duplicate in this file',
  existing: 'Already in a list or emailed before', suppressed: 'Do-not-email (suppressed)', role: 'Role address (info@, office@…)',
};

// One path for real imports and dry runs: parsing, validation, dedupe,
// lane check and every suppression source are identical; dryRun only skips
// the final writes (and returns a few preview rows). Without dryRun and
// mapping the result is exactly what it always was.
// updateExisting: contacts already uploaded to this lane and never emailed get
// this file's columns merged into their row (non-empty values win; a blank
// never erases), e.g. to add subject_line / opening_line to a list that is
// already queued. Anyone the server has emailed is left as is.
export async function uploadContacts(csv, { includeUnverified = false, now = Date.now(), lane = 'regular', dryRun = false, mapping = null, updateExisting = false } = {}) {
  lane = normLane(lane);
  const settings = await readSettings();
  const config = await readConfig();
  const templates = templatesFor(config, settings);
  const ro = renderOptsFor(settings, lane);
  const footer = ro.plain ? ro.optOut : settings.footer;
  const raw = parseCsv(csv);
  const suggested = mapping === 'auto' || dryRun ? suggestMapping(raw.headers) : null;
  const { headers, rows, applied } = mapping ? applyMapping(raw, mapping === 'auto' ? suggested : mapping) : { ...raw, applied: null };
  const report = { rows: rows.length, added: 0, skipped: {}, byTemplate: {}, placeholderWarnings: {}, samples: [], lane };
  if (updateExisting) Object.assign(report, { updated: 0, updatedColumns: [] });
  if (dryRun) {
    Object.assign(report, { dryRun: true, headers: raw.headers, mappedHeaders: headers, suggestedMapping: suggested, mapping: applied || {},
      bySegment: {}, byCategory: {}, emptyTemplates: [], previewRows: [], laneLabel: LANE_LABEL[lane],
      laneAccounts: laneAccounts(config, settings, lane).length, paused: Boolean(settings.paused) });
  }
  if (!headers.includes('email')) {
    // A dry run explains instead of failing, so the dashboard can offer the mapping.
    if (dryRun) return { ...report, ok: false, error: rows.length ? 'no email column' : 'empty' };
    const e = new Error('the CSV needs an "email" column'); e.status = 400; throw e;
  }
  const hasStatus = headers.includes('email_status');
  const outcome = new Map();                 // row index -> preview outcome (first 10 rows)
  const skip = (reason, email, i) => {
    report.skipped[reason] = (report.skipped[reason] || 0) + 1;
    if (report.samples.length < 40) report.samples.push({ email, reason });
    if (dryRun) { const c = skipCategory(reason); report.byCategory[c] = (report.byCategory[c] || 0) + 1; }
    if (i !== undefined && i < 10) outcome.set(i, { add: false, reason, category: skipCategory(reason) });
  };
  if (rows.length > 5000) report.truncated = rows.length - 5000;
  const seen = new Set();
  const cand = [];
  rows.slice(0, 5000).forEach((row, i) => {
    const email = normEmail(row.email);
    if (!email) { skip('no email', '', i); return; }
    if (hasStatus && !includeUnverified && String(row.email_status || '').trim().toLowerCase() !== 'valid') { skip('email_status is not "valid"', email, i); return; }
    if (!EMAIL_RE.test(email)) { skip('invalid address', email, i); return; }
    if (seen.has(email)) { skip('duplicate in this file', email, i); return; }
    seen.add(email);
    cand.push({ email, row: cleanRow({ ...row, email }), i });
  });
  const existing = new Map();
  for (let i = 0; i < cand.length; i += 500) {
    const chunk = cand.slice(i, i + 500);
    const got = (await command('HMGET', K.contacts, ...chunk.map((c) => c.email))) || [];
    chunk.forEach((c, j) => { if (got[j]) existing.set(c.email, parse(got[j], {})); });
  }
  const reasons = await checkMany(cand.map((c) => c.email), { settings, firstTouch: true });
  // Who the server has already emailed: their first email is out, nothing to update.
  const emailed = new Set();
  if (updateExisting && existing.size) {
    const ex = [...existing.keys()];
    for (let i = 0; i < ex.length; i += 500) {
      const chunk = ex.slice(i, i + 500);
      const got = (await command('HMGET', K.sent, ...chunk)) || [];
      chunk.forEach((e, j) => { if (got[j]) emailed.add(e); });
    }
  }
  const fresh = [], updates = [], newCols = new Set();
  for (const c of cand) {
    if (existing.has(c.email)) {
      // One lane per contact: someone already in another lane is never queued here.
      const ex = existing.get(c.email), exLane = contactLane(ex);
      if (exLane !== lane) { skip(`already in the ${LANE_LABEL[exLane]} lane (${ex.status || 'queued'})`, c.email, c.i); continue; }
      if (!updateExisting) { skip(`already uploaded (${ex.status || 'queued'})`, c.email, c.i); continue; }
      if (emailed.has(c.email) || ['sent', 'bounced', 'failed'].includes(ex.status)) { skip('already emailed, not updated', c.email, c.i); continue; }
      const row = { ...(ex.row || {}) };
      let changed = false;
      for (const [k, v] of Object.entries(c.row)) {
        if (String(v ?? '').trim() && row[k] !== v) { row[k] = v; changed = true; if (k !== 'email') newCols.add(k); }
      }
      if (!changed) { skip('already uploaded, nothing new in this file', c.email, c.i); continue; }
      updates.push({ ...ex, row, updatedAt: now });
      if (c.i < 10) outcome.set(c.i, { add: false, update: true, reason: 'updates the queued contact' });
      continue;
    }
    const r = reasons.get(c.email);
    if (r) { skip(r, c.email, c.i); continue; }
    const routed = routeContact(c.row);
    const template = firstTemplateFor(settings, lane, routed);
    const sendRow = rowFor(settings, c.row);
    const p = problems(personalise(templates[template] || {}, sendRow, template), withWording({ ...sendRow, _segment: template, sender_name: 'x' }), footer);
    if (!p.ok) {
      const key = `${template}: ${[...p.missing.map((f) => `{{${f}}} missing`), ...p.empty.map((f) => `{{${f}}} empty`)].join(', ') || 'template empty'}`;
      report.placeholderWarnings[key] = (report.placeholderWarnings[key] || 0) + 1;
    }
    report.byTemplate[template] = (report.byTemplate[template] || 0) + 1;
    if (dryRun) {
      report.bySegment[routed] = (report.bySegment[routed] || 0) + 1;
      if (p.emptyTemplate && !report.emptyTemplates.includes(template)) report.emptyTemplates.push(template);
      if (c.i < 10) outcome.set(c.i, { add: true, segment: routed, template });
    }
    fresh.push({ email: c.email, row: c.row, template: routed, addedAt: now, status: 'queued', ...laneTag(lane) });
  }
  report.added = fresh.length;
  if (updateExisting) { report.updated = updates.length; report.updatedColumns = [...newCols].sort(); }
  if (dryRun) {
    report.ok = true;
    report.previewRows = rows.slice(0, 10).map((row, i) => ({ row: cleanRow(row), ...(outcome.get(i) || { add: false, reason: 'not read' }) }));
    return report;                           // nothing written
  }
  const cmds = [];
  for (let i = 0; i < fresh.length; i += 200) {
    const chunk = fresh.slice(i, i + 200);
    cmds.push(['HSET', K.contacts, ...chunk.flatMap((c) => [c.email, JSON.stringify(c)])]);
    cmds.push(['RPUSH', K.queueOf(lane), ...chunk.map((c) => c.email)]);
  }
  for (let i = 0; i < updates.length; i += 200) {
    cmds.push(['HSET', K.contacts, ...updates.slice(i, i + 200).flatMap((c) => [c.email, JSON.stringify(c)])]);
  }
  if (cmds.length) await pipeline(cmds);
  if (applied && Object.keys(applied).length) report.mapping = applied;
  if (fresh.length) await invalidatePlans(now, { includeUntouchedToday: true });
  return report;
}

// Categories switched off on the Sending tab (Virtual assistants by default).
// A contact whose first email would use one waits in the queue; one already
// emailed with one gets no follow-up. Switching it back on resumes both.
export const templateOff = (settings, templateId) => Boolean(templateId) && (settings?.skipTemplates || []).includes(templateId);
export const offReason = (templateId) => `${(SEGMENTS.find((s) => s.id === templateId) || {}).label || templateId} emails are switched off`;

// A contact's row as the first email sees it: without its subject_line and
// opening_line unless the Sending tab's "personal lines" switch is on, so the
// email is the dashboard template for the contact's category. The stored row
// keeps them either way.
export function rowFor(settings, row) {
  if (settings?.personalLines || !row) return row;
  const out = { ...row };
  delete out.subject_line;
  delete out.opening_line;
  return out;
}

// filter: 'all', 'personal' (has a subject_line or opening_line that will be
// used) or 'standard'. personal / standard count the whole queue, whatever the filter.
export const personalLines = (row) => ({ subjectLine: String(row?.subject_line ?? '').trim(), openingLine: String(row?.opening_line ?? '').trim() });
export async function queueView({ offset = 0, limit = 200, lane = 'regular', filter = 'all' } = {}) {
  lane = normLane(lane);
  const emails = (await command('LRANGE', K.queueOf(lane), 0, -1)) || [];
  const settings = await readSettings();
  const rows = [];
  for (let i = 0; i < emails.length; i += 500) {
    const chunk = emails.slice(i, i + 500);
    const recs = (await command('HMGET', K.contacts, ...chunk)) || [];
    chunk.forEach((e, j) => rows.push({ e, c: parse(recs[j], { email: e }), position: i + j + 1 }));
  }
  const isPersonal = (x) => { const p = personalLines(rowFor(settings, x.c.row)); return Boolean(p.subjectLine || p.openingLine); };
  const personal = rows.filter(isPersonal).length;
  const picked = filter === 'personal' ? rows.filter(isPersonal) : filter === 'standard' ? rows.filter((x) => !isPersonal(x)) : rows;
  return { lane, total: emails.length, personal, standard: emails.length - personal, filter, matched: picked.length,
    personalLinesOn: Boolean(settings.personalLines),
    items: picked.slice(offset, offset + limit).map(({ e, c, position }) => {
      const template = firstTemplateFor(settings, lane, c.template);
      return { email: e, position, template, company: c.row?.company || '', ...(templateOff(settings, template) ? { off: offReason(template) } : {}),
        name: c.row?.name || c.row?.first_name || '', addedAt: c.addedAt, ...personalLines(rowFor(settings, c.row)) };
    }) };
}

// Exactly what a queued or planned contact's first email will look like: the
// template, account and rendering the send will use (plan's account if it is
// planned, else the lane's first account). Nothing is recorded.
export async function previewContact(email) {
  const e = normEmail(email);
  const [config, settings] = await Promise.all([readConfig(), readSettings()]);
  const c = parse(await command('HGET', K.contacts, e));
  if (!c) { const err = new Error('no such contact'); err.status = 404; throw err; }
  const lane = contactLane(c);
  const templateId = firstTemplateFor(settings, lane, c.template || routeContact(c.row || {}));
  let account = null, at = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(c.plannedFor || ''))) {
    const it = (await readPlan(c.plannedFor)).items.find((x) => x.email === e && !x.followUp);
    if (it) ({ account, at } = it);
  }
  account ||= laneAccounts(config, settings, lane)[0] || accountsOf(config)[0] || '';
  const ro = renderOptsFor(settings, lane);
  const row = rowFor(settings, c.row || { email: e });
  const r = renderEmail({ contact: { ...row, _segment: templateId }, templates: templatesFor(config, settings), templateId,
    ...senderOf(config, account), token: 'preview0000000', footer: ro.plain ? '' : settings.footer, plain: ro.plain, optOut: ro.optOut });
  return { email: e, name: c.row?.name || c.row?.first_name || '', company: c.row?.company || '', status: c.status || 'queued', lane,
    account, at, templateId, subject: r.subject, text: r.text, html: r.html || '', plain: Boolean(r.plain), personal: r.personal,
    ...personalLines(row), problems: r.problems };
}

export async function removeFromQueue(email) {
  const e = normEmail(email);
  const c = parse(await command('HGET', K.contacts, e));
  let n = 0;
  for (const lane of LANES) n += Number(await command('LREM', K.queueOf(lane), 0, e)) || 0;
  if (c) await command('HSET', K.contacts, e, JSON.stringify({ ...c, status: 'removed' }));
  return Number(n) || 0;
}

export async function clearQueue(lane = 'regular') {
  const key = K.queueOf(normLane(lane));
  const emails = (await command('LRANGE', key, 0, -1)) || [];
  for (let i = 0; i < emails.length; i += 300) {
    const chunk = emails.slice(i, i + 300);
    const recs = await command('HMGET', K.contacts, ...chunk);
    const pairs = chunk.flatMap((e, j) => [e, JSON.stringify({ ...parse(recs[j], { email: e }), status: 'removed' })]);
    if (pairs.length) await command('HSET', K.contacts, ...pairs);
  }
  await command('DEL', key);
  return emails.length;
}

// ------------------------------------------------------------------ plans

export async function readPlan(date) {
  const flat = (await command('HGETALL', K.plan(date))) || [];
  let meta = null;
  const items = [];
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i] === 'meta') meta = parse(flat[i + 1]);
    else { const it = parse(flat[i + 1]); if (it) items.push(it); }
  }
  items.sort((a, b) => a.at - b.at);
  return { date, meta, items };
}

const saveItems = (date, items) => items.length
  ? command('HSET', K.plan(date), ...items.flatMap((it) => [it.id, JSON.stringify(it)]))
  : null;

// Hand un-sent first-touch contacts of a plan back to the front of the queue,
// in their original order. Follow-ups need nothing: they come from mailer:srv:fu.
async function releaseItems(items) {
  const back = items.filter((it) => !it.followUp && !FINAL.has(it.status) && it.status !== 'sending')
    .sort((a, b) => a.at - b.at).map((it) => it.email);
  if (!back.length) return 0;
  const recs = await command('HMGET', K.contacts, ...back);
  const cs = back.map((e, j) => parse(recs[j], { email: e }));
  const pairs = back.flatMap((e, j) => [e, JSON.stringify({ ...cs[j], status: 'queued', plannedFor: null })]);
  // Each contact goes back to the front of its own lane's queue.
  const byLane = {};
  back.forEach((e, j) => (byLane[contactLane(cs[j])] ||= []).push(e));
  const cmds = LANES.filter((l) => byLane[l]).map((l) => ['LPUSH', K.queueOf(l), ...[...byLane[l]].reverse()]);
  await pipeline([...cmds, ['HSET', K.contacts, ...pairs]]);
  return back.length;
}

async function releaseStale(today) {
  const dates = (await command('SMEMBERS', K.plans)) || [];
  let n = 0;
  for (const d of dates.filter((d) => d < today)) {
    const plan = await readPlan(d);
    n += await releaseItems(plan.items);
    await command('SREM', K.plans, d);
  }
  return n;
}

// Future plans (and today's, if nothing has been attempted) are provisional:
// changed settings, pauses or new contacts rebuild them.
export async function invalidatePlans(now, { includeUntouchedToday = true, settings = null } = {}) {
  const today = sendingDay(now, settings || await readSettings());
  const dates = (await command('SMEMBERS', K.plans)) || [];
  let n = 0;
  for (const d of dates.filter((d) => d >= today)) {
    const plan = await readPlan(d);
    const untouched = plan.items.every((it) => it.status === 'planned');
    if (d > today || (includeUntouchedToday && untouched)) {
      await releaseItems(plan.items);
      await command('DEL', K.plan(d));
      await command('SREM', K.plans, d);
      n++;
    }
  }
  return n;
}

export async function ensurePlan(date, { now = Date.now() } = {}) {
  const settings = await readSettings();
  const today = sendingDay(now, settings);
  if (Number(await command('HEXISTS', K.plan(date), 'meta'))) {
    // A plan previewed on an earlier day stays as shown, unless contacts that
    // an earlier day failed to send have just come back to the front of the
    // queue; then an untouched plan is rebuilt so they go first.
    if (date !== today) return readPlan(date);
    const plan = await readPlan(date);
    if (!plan.meta || sendingDay(plan.meta.builtAt, settings) >= today || plan.items.some((it) => it.status !== 'planned')) return plan;
    let returning = 0;
    for (const d of ((await command('SMEMBERS', K.plans)) || []).filter((d) => d < today)) {
      const old = await readPlan(d);
      const back = old.items.filter((it) => !it.followUp && !FINAL.has(it.status) && it.status !== 'sending').length;
      if (!back) await command('SREM', K.plans, d);
      returning += back;
    }
    if (!returning) return plan;
    await releaseItems(plan.items);   // first, so the older contacts land in front of these
    await command('DEL', K.plan(date));
    await command('SREM', K.plans, date);
  }
  await releaseStale(today);
  // First in, first out: today's plan takes its contacts before any later
  // day's, for as long as today's run has not ended (its cutoff), the same
  // rule the tick follows. A later day's plan built before today's gives its
  // contacts back first.
  const buildToday = async () => {
    await invalidatePlans(now, { includeUntouchedToday: false, settings });
    return buildPlan(today, now, settings);
  };
  if (date === today) return buildToday();
  if (date > today && settings.weekdays.includes(eatWeekday(today)) &&
      now < eatAt(today, dayWindow(settings).cutoff) &&
      !Number(await command('HEXISTS', K.plan(today), 'meta'))) {
    await buildToday();
  }
  return buildPlan(date, now, settings);
}

export async function buildPlan(date, now, settings) {
  settings ||= await readSettings();
  const config = await readConfig();
  const states = await readAccountStates();
  const cap = settings.perAccountCap;
  const win = dayWindow(settings);
  const meta = { date, builtAt: now, cap, accounts: {}, offDay: false, window: [settings.windowStart, settings.windowEnd, settings.lateCutoff], lanes: {} };
  const key = K.plan(date);
  const accounts = accountsOf(config);
  const active = accounts.filter((a) => !states[a]?.paused);
  const laneOfAcct = Object.fromEntries(accounts.map((a) => [a, laneOf(settings, a)]));
  const capOf = (a) => laneCap(settings, laneOfAcct[a]);
  for (const a of accounts) {
    meta.accounts[a] = { paused: Boolean(states[a]?.paused), noPassword: !hasPassword(a), followUps: 0, fresh: 0, start: null };
    if (laneOfAcct[a] !== 'regular') meta.accounts[a].lane = laneOfAcct[a];
  }
  for (const lane of LANES) {
    const la = accounts.filter((a) => laneOfAcct[a] === lane);
    meta.lanes[lane] = { accounts: la, active: la.filter((a) => !states[a]?.paused).length, cap: laneCap(settings, lane), noAccount: !la.length };
  }

  if (!settings.weekdays.includes(eatWeekday(date)) || !active.length) {
    meta.offDay = !settings.weekdays.includes(eatWeekday(date));
    await pipeline([['HSET', key, 'meta', JSON.stringify(meta)], ['EXPIRE', key, 40 * 86400]]);
    return readPlan(date);
  }

  // Follow-ups first: contacts whose last email is followUpDays old by then,
  // from the same account (and so the same lane) as their first email.
  const byAcct = Object.fromEntries(active.map((a) => [a, []]));
  if (settings.followUps) {
    const cutoff = eatAt(date, Math.max(24 * 60, win.cutoff)) - config.followUpDays * DAY;
    const emails = (await command('ZRANGEBYSCORE', K.fu, '-inf', cutoff, 'LIMIT', 0, 1000)) || [];
    if (emails.length) {
      const reasons = await checkMany(emails, { settings, firstTouch: false });
      const recs = [];
      for (let i = 0; i < emails.length; i += 300) recs.push(...(await command('HMGET', K.sent, ...emails.slice(i, i + 300))));
      for (let i = 0; i < emails.length; i++) {
        const rec = parse(recs[i]);
        const touches = rec?.touches?.length || 0;
        if (!rec || reasons.get(emails[i]) || touches >= config.maxTouches) { await command('ZREM', K.fu, emails[i]); continue; }
        if (!byAcct[rec.account] || byAcct[rec.account].length >= capOf(rec.account)) continue;
        // Never across lanes: if the account has moved to another lane, its
        // earlier contacts' follow-ups wait (they stay in rotation).
        const lane = contactLane(rec);
        if (laneOfAcct[rec.account] !== lane) continue;
        if (lane !== 'regular' && !laneOpts(settings, lane).followUps) continue;
        if (templateOff(settings, rec.touches[0]?.template)) continue;   // stays in rotation until switched back on
        byAcct[rec.account].push({ email: rec.email, template: followupTemplateFor(settings, lane), followUp: true, touch: touches + 1, company: rec.company || '', ...laneTag(lane) });
      }
    }
  }

  // Then new contacts, each lane from its own queue, balanced across that
  // lane's active accounts. A lane with no active account takes nothing.
  const skipped = [];
  const allPicked = [];
  for (const lane of LANES) {
    const laneActive = active.filter((a) => laneOfAcct[a] === lane);
    if (!laneActive.length) continue;
    const need = Object.fromEntries(laneActive.map((a) => [a, Math.max(0, capOf(a) - byAcct[a].length)]));
    let total = Object.values(need).reduce((s, n) => s + n, 0);
    const picked = [];
    const strays = [];
    const held = [];                          // category switched off: they wait, in order
    const tplOf = (c) => firstTemplateFor(settings, lane, c.template || routeContact(c.row || {}));
    while (picked.length < total) {
      const popped = [].concat((await command('LPOP', K.queueOf(lane), total - picked.length)) || []);
      if (!popped.length) break;
      const recs = await command('HMGET', K.contacts, ...popped);
      const reasons = await checkMany(popped, { settings, firstTouch: true });
      popped.forEach((e, j) => {
        const c = parse(recs[j]);
        if (!c || c.status === 'removed') return;
        if (contactLane(c) !== lane) { strays.push(c); return; }   // belt and braces: back to its own lane
        const r = reasons.get(e);
        if (r) skipped.push({ ...c, status: 'skipped', reason: r });
        else if (templateOff(settings, tplOf(c))) held.push(c);
        else picked.push(c);
      });
    }
    if (held.length) await command('LPUSH', K.queueOf(lane), ...held.map((c) => c.email).reverse());
    for (const c of strays) await command('RPUSH', K.queueOf(contactLane(c)), c.email);
    for (const c of picked) {
      const max = Math.max(...laneActive.map((a) => need[a]));
      const choices = laneActive.filter((a) => need[a] === max);
      const a = choices[Math.floor(rand() * choices.length)];
      need[a]--;
      byAcct[a].push({ email: c.email, template: tplOf(c), followUp: false, touch: 1, company: c.row?.company || '', ...laneTag(lane) });
    }
    allPicked.push(...picked);
  }

  // Random start per account inside the window, then random gaps. A run
  // planned after its window opened starts from now (a minute from now).
  const lo = Math.max(eatAt(date, win.start), now + 60000);
  const hi = Math.max(eatAt(date, win.end), lo);
  const items = [];
  for (const a of active) {
    const list = byAcct[a];
    if (!list.length) continue;
    let at = lo + Math.floor(rand() * ((hi - lo) / 1000 + 1)) * 1000;
    meta.accounts[a].start = at;
    list.forEach((it, i) => {
      if (i > 0) at += Math.round((settings.minGapMin + rand() * (settings.maxGapMin - settings.minGapMin)) * 60) * 1000;
      items.push({ id: `${date}:${a.split('@')[0]}:${i}`, date, account: a, ...it, at, status: 'planned' });
    });
    meta.accounts[a].followUps = list.filter((x) => x.followUp).length;
    meta.accounts[a].fresh = list.length - meta.accounts[a].followUps;
  }
  meta.skippedOnBuild = skipped.length;
  const cmds = [['HSET', key, 'meta', JSON.stringify(meta)], ['EXPIRE', key, 40 * 86400], ['SADD', K.plans, date]];
  if (items.length) cmds.push(['HSET', key, ...items.flatMap((it) => [it.id, JSON.stringify(it)])]);
  const pickedBy = new Map(allPicked.map((c) => [c.email, c]));
  const contactPairs = [
    ...items.filter((it) => !it.followUp).map((it) => [it.email, pickedBy.get(it.email)])
      .flatMap(([e, c]) => [e, JSON.stringify({ ...c, status: 'planned', plannedFor: date })]),
    ...skipped.flatMap((c) => [c.email, JSON.stringify(c)]),
  ];
  if (contactPairs.length) cmds.push(['HSET', K.contacts, ...contactPairs]);
  await pipeline(cmds);
  return readPlan(date);
}

// If the trigger was down or sending was paused, the remaining sends are
// re-timed from now with fresh random gaps rather than fired back to back.
async function reflow(date, account, planned, now, settings) {
  const cutoff = eatAt(date, dayWindow(settings).cutoff);
  let at = now + Math.round((1 + rand() * 2) * 60) * 1000;
  const out = [];
  planned.forEach((it, i) => {
    if (i > 0) at += Math.round((settings.minGapMin + rand() * (settings.maxGapMin - settings.minGapMin)) * 60) * 1000;
    if (at >= cutoff) out.push({ ...it, status: 'deferred', reason: 'past the day\'s cutoff' });
    else out.push({ ...it, at, reflowed: true });
  });
  await saveItems(date, out);
  return out.filter((it) => it.status === 'planned');
}

// ------------------------------------------------------------------ log

export async function addLog(entry, body) {
  const id = entry.id || `${Date.now().toString(36)}${newToken().slice(0, 6)}`;
  const e = { id, at: Date.now(), ...entry };
  const cmds = [['LPUSH', K.log, JSON.stringify(e)]];
  if (body) cmds.push(['HSET', K.logBody, id, JSON.stringify(body)]);
  cmds.push(['LLEN', K.log]);
  const res = await pipeline(cmds);
  if (Number(res[res.length - 1]) > 3100) {
    const old = ((await command('LRANGE', K.log, 3000, -1)) || []).map((j) => parse(j, {}).id).filter(Boolean);
    await command('LTRIM', K.log, 0, 2999);
    if (old.length) await command('HDEL', K.logBody, ...old);
  }
  return e;
}

export async function listLog({ q = '', offset = 0, limit = 50, account = '', status = '' } = {}) {
  const needle = String(q).trim().toLowerCase();
  const out = [];
  let matched = 0;
  for (let start = 0; start < 3100 && out.length < limit; start += 500) {
    const chunk = (await command('LRANGE', K.log, start, start + 499)) || [];
    for (const j of chunk) {
      const e = parse(j);
      if (!e) continue;
      if (account && e.account !== account) continue;
      if (status && e.status !== status) continue;
      if (needle && !`${e.to} ${e.subject} ${e.account} ${e.status} ${e.templateId} ${e.error || ''} ${e.reason || ''}`.toLowerCase().includes(needle)) continue;
      if (matched++ < offset) continue;
      if (out.length < limit) out.push(e);
    }
    if (chunk.length < 500) break;
  }
  return { items: out, offset, limit };
}

export async function getLogBody(id) {
  return parse(await command('HGET', K.logBody, id));
}

// ------------------------------------------------------------------ sending

async function saveItem(item) { await saveItems(item.date, [item]); }

async function setContact(email, patch) {
  const c = parse(await command('HGET', K.contacts, email));
  if (c) await command('HSET', K.contacts, email, JSON.stringify({ ...c, ...patch }));
}

async function recordSend({ email, account, item, token, row, messageId, logId, now, bounced, bounceReason, config, plain = false, personal = false }) {
  const rec = parse(await command('HGET', K.sent, email)) || {
    email, account, company: row.company || '', row, template: item.template, firstSentAt: now, touches: [],
    repliedAt: null, bouncedAt: null, unsubscribedAt: null, ...laneTag(item.lane),
  };
  // plain: no pixel or link carries this token, so it can never register an open.
  // personal: the email carried the contact's own subject_line / opening_line.
  rec.touches.push({ at: now, n: item.touch, t: token, template: item.template, followUp: item.followUp, messageId, logId, v: config.version || 0,
    ...(plain ? { plain: true } : {}), ...(personal ? { personal: true } : {}) });
  rec.lastSentAt = now;
  if (bounced) { rec.bouncedAt = now; rec.bounceReason = bounceReason; }
  const more = !bounced && rec.touches.length < config.maxTouches;
  await pipeline([
    ['HSET', K.sent, email, JSON.stringify(rec)],
    ['HSET', K.tokens, token, email],
    ['ZADD', K.byAcct(account), now, email],
    ['LPUSH', K.recent(account), email],
    ['LTRIM', K.recent(account), 0, 49],
    more ? ['ZADD', K.fu, now, email] : ['ZREM', K.fu, email],
  ]);
  return rec;
}

export async function bounceRate(account) {
  const recent = (await command('LRANGE', K.recent(account), 0, 49)) || [];
  if (!recent.length) return { rate: 0, bounced: 0, of: 0 };
  const recs = await command('HMGET', K.sent, ...recent);
  const bounced = recs.filter((r) => parse(r)?.bouncedAt).length;
  return { rate: bounced / recent.length, bounced, of: recent.length };
}

async function checkBounceAutoPause(account, now) {
  const b = await bounceRate(account);
  if (b.rate > 0.05) {
    await patchAccountState(account, { paused: true, auto: true, at: now,
      reason: `bounce rate ${(b.rate * 100).toFixed(1)}% (${b.bounced} of last ${b.of})` });
    return true;
  }
  return false;
}

async function failureStreak(account, now, n) {
  const st = await patchAccountState(account, { consecutiveFailures: n });
  if (n >= 3 && !st.paused) {
    await patchAccountState(account, { paused: true, auto: true, at: now, reason: `${n} failed sends in a row` });
  }
}

export async function sendItem(item, { now = Date.now(), today: todayArg = null, bypassPause = false, skipWait = false } = {}) {
  const settings = await readSettings();
  const today = todayArg || sendingDay(now, settings);
  // Only the test batch may pass bypassPause, and only for allowlisted addresses.
  const allowlisted = bypassPause && (settings.testRecipients || []).includes(normEmail(item.email));
  if (bypassPause && !allowlisted) return { status: 'not on the test-recipient list' };
  if (settings.paused && !allowlisted) return { status: 'paused' };
  const states = await readAccountStates();
  const st = states[item.account] || {};
  if (st.paused) return { status: 'account paused' };
  const config = await readConfig();
  const email = normEmail(item.email);
  const firstTouch = !item.followUp;
  const lane = laneOf(settings, item.account);
  const itemLane = normLane(item.lane);
  const skipItem = async (status, reason, extra = {}) => {
    await saveItem({ ...item, status, reason, attemptedAt: now });
    if (firstTouch && status === 'skipped') await setContact(email, { status: 'skipped', reason });
    await addLog({ account: item.account, to: email, templateId: item.template, status, reason, itemId: item.id, touch: item.touch, followUp: item.followUp, ...laneTag(itemLane), ...extra });
    return { status, reason };
  };
  // Lanes never mix: an item only goes out from an account in its own lane
  // (the account may have been moved after the day was planned). Deferred, so
  // the contact returns to its own lane's queue.
  if (lane !== itemLane) return skipItem('deferred', `${item.account} is now in the ${LANE_LABEL[lane]} lane; this ${LANE_LABEL[itemLane]} lane email waits for a ${LANE_LABEL[itemLane]} account`);

  if (!settings.dryRun && !hasPassword(item.account)) return skipItem('deferred', `no app password (${passwordVar(item.account)})`);

  let reason = await checkOne(email, { settings, firstTouch });
  const rec = parse(await command('HGET', K.sent, email));
  // A category switched off after this was planned: it waits (a first email
  // goes back to the queue, a follow-up stays in rotation).
  const category = firstTouch ? item.template : rec?.touches?.[0]?.template;
  if (!reason && templateOff(settings, category)) return skipItem('deferred', offReason(category));
  if (!reason && item.followUp && rec && contactLane(rec) !== lane) {
    return skipItem('deferred', `first email went out in the ${LANE_LABEL[contactLane(rec)]} lane`);
  }
  if (!reason && item.followUp) {
    if (!rec) reason = 'no earlier email from the server';
    else if (rec.account !== item.account) reason = 'first email came from another account';
    else if (rec.touches.length !== item.touch - 1) reason = 'this touch was already sent';
    else if (rec.touches.length >= config.maxTouches) reason = 'reached max touches';
    // The test follow-up button skips the wait, for allowlisted addresses only.
    else if (!(skipWait && allowlisted) && sendingDay(rec.lastSentAt + config.followUpDays * DAY, settings) > today) {
      await saveItem({ ...item, status: 'deferred', reason: 'not due yet' });
      return { status: 'deferred', reason: 'not due yet' };
    } else if (!(st.lastImapOkAt >= now - settings.replyCheckHours * 3600000)) {
      return skipItem('deferred', 'inbox not checked for replies recently; follow-up held back');
    }
    if (reason) await command('ZREM', K.fu, email);
  }
  if (reason) return skipItem('skipped', reason);

  let row;
  if (firstTouch) {
    const c = parse(await command('HGET', K.contacts, email));
    if (!c) return skipItem('skipped', 'contact record missing');
    if (contactLane(c) !== lane) return skipItem('deferred', `contact belongs to the ${LANE_LABEL[contactLane(c)]} lane`);
    row = c.row;
  } else row = rec.row || { email, company: rec.company };

  const token = newToken();
  const { senderName, nickName } = senderOf(config, item.account);
  const ro = renderOptsFor(settings, lane);
  const r = renderEmail({ contact: { ...rowFor(settings, row), _segment: item.template }, templates: templatesFor(config, settings),
    templateId: item.template, senderName, nickName, token, footer: ro.plain ? '' : settings.footer, plain: ro.plain, optOut: ro.optOut });
  if (settings.blockOnPlaceholderIssues && !r.problems.ok) {
    const why = [...r.problems.missing.map((f) => `{{${f}}} missing`), ...r.problems.empty.map((f) => `{{${f}}} empty`),
      ...(r.problems.emptyTemplate ? ['template empty'] : [])].join(', ');
    await saveItem({ ...item, status: 'skipped', reason: `placeholder problem: ${why}`, attemptedAt: now });
    if (firstTouch) await setContact(email, { status: 'blocked', reason: `placeholder problem: ${why}` });
    await addLog({ account: item.account, to: email, templateId: item.template, status: 'skipped', reason: `placeholder problem: ${why}`, subject: r.subject, itemId: item.id, touch: item.touch, followUp: item.followUp, ...laneTag(lane), ...(r.plain ? { plain: true } : {}) },
      { subject: r.subject, text: r.text, html: r.html, ...(r.plain ? { plain: true } : {}) });
    return { status: 'skipped', reason: 'placeholder' };
  }

  // Hard cap, atomically.
  const countKey = K.count(today);
  const n = Number(await command('HINCRBY', countKey, item.account, 1));
  await command('EXPIRE', countKey, 4 * 86400);
  if (n > laneCap(settings, lane)) {
    await command('HINCRBY', countKey, item.account, -1);
    await saveItem({ ...item, status: 'deferred', reason: 'daily cap reached' });
    return { status: 'deferred', reason: 'daily cap reached' };
  }
  // The never-twice guard.
  const guardField = `${email}#${item.touch}`;
  if (!Number(await command('HSETNX', K.touch, guardField, item.id))) {
    await command('HINCRBY', countKey, item.account, -1);
    return skipItem('skipped', 'already sent (guard)');
  }
  await saveItem({ ...item, status: 'sending', attemptedAt: now });

  const logId = `${now.toString(36)}${token.slice(0, 6)}`;
  const mail = r.plain
    // Plain text: a single text/plain part, no HTML, no List-Unsubscribe link.
    ? { from: fromHeader(senderName, item.account), to: email, subject: r.subject, text: r.text }
    : {
      from: fromHeader(senderName, item.account),
      to: email,
      subject: r.subject,
      text: r.text,
      html: r.html,
      headers: settings.listUnsubscribe
        ? { 'List-Unsubscribe': `<${r.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
        : {},
    };
  const body = { subject: r.subject, text: r.text, html: r.html, from: item.account, ...(r.plain ? { plain: true } : {}) };
  const base = { id: logId, account: item.account, to: email, templateId: r.templateId, subject: r.subject,
    itemId: item.id, touch: item.touch, followUp: item.followUp, token, configVersion: config.version || 0,
    ...(item.testBatch ? { testBatch: true } : {}), ...laneTag(lane), ...(r.plain ? { plain: true } : {}), ...(r.personal ? { personal: true } : {}) };
  const transport = transportFor(item.account, { dryRun: settings.dryRun });
  try {
    const info = await transport.sendMail(mail);
    if (settings.dryRun) {
      await command('HDEL', K.touch, guardField);
      await command('HINCRBY', countKey, item.account, -1);
      await saveItem({ ...item, status: 'dry-run', attemptedAt: now, logId });
      await addLog({ ...base, status: 'dry-run', messageId: info.messageId || '' }, body);
      return { status: 'dry-run', logId };
    }
    await recordSend({ email, account: item.account, item, token, row, messageId: info.messageId, logId, now, config, plain: r.plain, personal: Boolean(r.personal) });
    await command('SET', K.last(item.account), String(now));
    await saveItem({ ...item, status: 'sent', attemptedAt: now, logId, messageId: info.messageId });
    if (firstTouch) await setContact(email, { status: 'sent', sentAt: now, account: item.account });
    await addLog({ ...base, status: 'sent', messageId: info.messageId || '', response: String(info.response || '').slice(0, 200),
      accepted: (info.accepted || []).map(String), rejected: (info.rejected || []).map(String) }, body);
    if (st.consecutiveFailures) await patchAccountState(item.account, { consecutiveFailures: 0 });
    return { status: 'sent', logId, messageId: info.messageId };
  } catch (err) {
    const c = classifySmtpError(err);
    if (c.kind === 'rejected') {
      await recordSend({ email, account: item.account, item, token, row, messageId: '', logId, now, bounced: true, bounceReason: c.msg, config, plain: r.plain, personal: Boolean(r.personal) });
      await saveItem({ ...item, status: 'bounced', attemptedAt: now, logId, reason: c.msg });
      if (firstTouch) await setContact(email, { status: 'bounced', reason: c.msg });
      await addLog({ ...base, status: 'bounced', error: c.msg }, body);
      await checkBounceAutoPause(item.account, now);
      return { status: 'bounced' };
    }
    if (c.notSent) {
      // Nothing was handed over: undo the claim so the contact can go another day.
      await command('HDEL', K.touch, guardField);
      await command('HINCRBY', countKey, item.account, -1);
      await saveItem({ ...item, status: 'deferred', attemptedAt: now, logId, reason: `${c.kind}: ${c.msg}` });
      await addLog({ ...base, status: 'failed', error: `${c.kind}: ${c.msg}`, retryable: true }, body);
      if (c.kind === 'auth') {
        await patchAccountState(item.account, { paused: true, auto: true, at: now, reason: `SMTP login failed: ${c.msg.slice(0, 120)}` });
      } else await failureStreak(item.account, now, (st.consecutiveFailures || 0) + 1);
      return { status: 'failed', retryable: true, kind: c.kind };
    }
    // It may have gone out. Never retried.
    await saveItem({ ...item, status: 'failed', attemptedAt: now, logId, reason: c.msg });
    if (firstTouch) await setContact(email, { status: 'failed', reason: c.msg });
    await addLog({ ...base, status: 'failed', error: c.msg }, body);
    await failureStreak(item.account, now, (st.consecutiveFailures || 0) + 1);
    return { status: 'failed', kind: c.kind };
  } finally {
    try { transport.close?.(); } catch { /* ignore */ }
  }
}

// ------------------------------------------------------------------ test batch
//
// "Send test batch now": one real send per account, right now, to queued
// contacts on the settings' test-recipient allowlist, whatever the pause or the
// window say. Everyone else in the queue is left exactly where they are. The
// send itself is the normal sendItem (suppression re-check, rendering, cap,
// never-twice guard, SMTP, log, tracking token, follow-up rotation, bounce
// auto-pause). Shares test.send's limit: 10 test emails per account per day.

export const TEST_DAILY_LIMIT = 10;
export const testCountKey = (d) => `mailer:srv:tests:${d}`;
const flatToObj = (flat) => { const o = {}; for (let i = 0; i < (flat || []).length; i += 2) o[flat[i]] = Number(flat[i + 1]) || 0; return o; };

// Plans invalidatePlans() would hand back (future ones, and today's if untouched).
async function releasablePlanned(today, lane = 'regular') {
  const out = [];
  for (const d of ((await command('SMEMBERS', K.plans)) || []).filter((x) => x >= today)) {
    const plan = await readPlan(d);
    const untouched = plan.items.every((it) => it.status === 'planned');
    if (d > today || untouched) out.push(...plan.items.filter((it) => !it.followUp && it.status === 'planned' && normLane(it.lane) === lane).map((it) => it.email));
  }
  return out;
}

// Which accounts of a lane may send a test email right now, and why not.
async function testAccounts(settings, config, today, lane = 'regular') {
  const states = await readAccountStates();
  const counts = flatToObj(await command('HGETALL', K.count(today)));
  const tests = flatToObj(await command('HGETALL', testCountKey(today)));
  const cap = laneCap(settings, lane);
  return laneAccounts(config, settings, lane).map((a, i) => {
    let blocked = null;
    if (states[a]?.paused) blocked = states[a].auto ? `auto-paused: ${states[a].reason || ''}`.trim() : 'paused';
    else if (!settings.dryRun && !hasPassword(a)) blocked = `no app password (${passwordVar(a)})`;
    else if ((counts[a] || 0) >= cap) blocked = `daily cap reached (${counts[a]}/${cap})`;
    else if ((tests[a] || 0) >= TEST_DAILY_LIMIT) blocked = `${TEST_DAILY_LIMIT} test emails today already`;
    return { account: a, order: i, tests: tests[a] || 0, sentToday: counts[a] || 0, blocked };
  });
}

export async function testBatchPlan({ now = Date.now(), lane = 'regular' } = {}) {
  lane = normLane(lane);
  const settings = await readSettings();
  const config = await readConfig();
  const today = sendingDay(now, settings);
  const allow = settings.testRecipients || [];
  const allowSet = new Set(allow);
  const queued = (await command('LRANGE', K.queueOf(lane), 0, -1)) || [];
  const waiting = [...new Set([...queued, ...(await releasablePlanned(today, lane))])];
  const candidates = waiting.filter((e) => allowSet.has(normEmail(e)));
  const otherQueued = waiting.length - candidates.length;
  const reasons = candidates.length ? await checkMany(candidates, { settings, firstTouch: true }) : new Map();
  const recs = candidates.length ? ((await command('HMGET', K.contacts, ...candidates)) || []).map((r) => parse(r)) : [];
  const ready = [], suppressed = [];
  candidates.forEach((e, i) => {
    const c = recs[i];
    if (!c || c.status === 'removed' || contactLane(c) !== lane) return;
    const template = firstTemplateFor(settings, lane, c.template || routeContact(c.row || {}));
    if (reasons.get(e)) suppressed.push({ email: e, reason: reasons.get(e) });
    else if (templateOff(settings, template)) suppressed.push({ email: e, reason: offReason(template) });
    else ready.push({ email: e, template, company: c.row?.company || '' });
  });
  const accounts = await testAccounts(settings, config, today, lane);
  const usable = accounts.filter((a) => !a.blocked).sort((x, y) => x.tests - y.tests || x.order - y.order);
  const assign = ready.slice(0, usable.length).map((c, i) => ({ ...c, account: usable[i].account }));
  return {
    lane, laneLabel: LANE_LABEL[lane], plainText: laneOpts(settings, lane).plainText,
    today, allowlist: allow, paused: settings.paused, dryRun: settings.dryRun, assign,
    waitingForNextClick: ready.slice(usable.length).map((c) => c.email), suppressed, otherQueuedUntouched: otherQueued,
    accounts: accounts.map(({ order, ...a }) => a),
    note: !accounts.length ? `no account assigned to the ${LANE_LABEL[lane]} lane; nothing can be sent from it`
      : !allow.length ? 'the test-recipient list is empty'
      : !candidates.length ? 'no queued contacts are on the test-recipient list; nothing to send'
      : !ready.length ? 'every allowlisted contact in the queue is suppressed'
      : !usable.length ? 'no account can send a test right now' : null,
  };
}

export async function sendTestBatch({ now = Date.now(), only = null, lane = 'regular' } = {}) {
  lane = normLane(lane);
  const today = sendingDay(now, await readSettings());
  const queueKey = K.queueOf(lane);
  // Hand untouched plans back to the queue (as a settings change would), so a
  // test contact already planned for the next sending day is found.
  await invalidatePlans(now, { includeUntouchedToday: true });
  const plan = await testBatchPlan({ now, lane });
  const onlySet = only ? new Set(only.map(normEmail)) : null;
  const results = [];
  const allowSet = new Set(plan.allowlist);
  for (const p of plan.assign) {
    const email = normEmail(p.email);
    if (!allowSet.has(email)) continue;   // belt and braces: never anyone else
    if (onlySet && !onlySet.has(email)) { results.push({ ...p, status: 'not in the confirmed list' }); continue; }
    const key = testCountKey(today);
    const n = Number(await command('HINCRBY', key, p.account, 1));
    await command('EXPIRE', key, 3 * 86400);
    const undoCount = () => command('HINCRBY', key, p.account, -1);
    if (n > TEST_DAILY_LIMIT) { await undoCount(); results.push({ ...p, status: 'test limit reached' }); continue; }
    if (!Number(await command('LREM', queueKey, 0, email))) { await undoCount(); results.push({ ...p, status: 'no longer queued' }); continue; }
    await setContact(email, { status: 'planned', plannedFor: `${today} (test batch)` });
    const item = { id: `${today}:test:${p.account.split('@')[0]}:${now.toString(36)}`, date: today, account: p.account, email,
      template: p.template, followUp: false, touch: 1, company: p.company, at: now, status: 'planned', testBatch: true, ...laneTag(lane) };
    const r = await sendItem(item, { now, today, bypassPause: true });
    await command('EXPIRE', K.plan(today), 40 * 86400);
    const wentOut = r.status === 'sent' || r.status === 'bounced' || r.status === 'dry-run' || (r.status === 'failed' && !r.retryable);
    if (!wentOut) await undoCount();
    if (r.status === 'dry-run') await setContact(email, { status: 'queued', plannedFor: null });
    // Not attempted (deferred, cap, retryable failure, account paused): back to the front of the queue.
    if (!wentOut && r.status !== 'skipped') {
      await command('LPUSH', queueKey, email);
      await setContact(email, { status: 'queued', plannedFor: null });
    }
    if (r.status === 'dry-run') await command('LPUSH', queueKey, email);
    results.push({ ...p, ...r });
  }
  return { ...plan, results, sent: results.filter((r) => r.status === 'sent').length };
}

// "Send test follow-up now": the next follow-up, immediately, to allowlisted
// contacts the server has already emailed. Same account as their last email,
// the follow-up template, touch n+1, stopping at maxTouches, through the normal
// sendItem (its reply-freshness rule included). Only the follow-up wait, the
// pause and the window are skipped, and only for the allowlist.
//
// Before sending, it does what the tick would have done many times during the
// real wait: maps new unsubscribes and checks each involved account's inbox for
// replies and bounces. A contact whose inbox check fails is held back.
export async function testFollowUpPlan({ now = Date.now(), lane = 'regular' } = {}) {
  lane = normLane(lane);
  const settings = await readSettings();
  const config = await readConfig();
  const today = sendingDay(now, settings);
  const allow = settings.testRecipients || [];
  const recs = allow.length ? ((await command('HMGET', K.sent, ...allow)) || []).map((r) => parse(r)) : [];
  // Only contacts whose first email went out in this lane.
  const withSends = allow.map((e, i) => ({ email: e, rec: recs[i] })).filter((x) => x.rec?.touches?.length && contactLane(x.rec) === lane);
  const reasons = withSends.length ? await checkMany(withSends.map((x) => x.email), { settings, firstTouch: false }) : new Map();
  const accounts = await testAccounts(settings, config, today, lane);
  const byAcct = Object.fromEntries(accounts.map((a) => [a.account, a]));
  const assign = [], skipped = [], waitingForNextClick = [];
  const used = new Set();
  for (const { email, rec } of withSends) {
    const touches = rec.touches.length;
    const base = { email, account: rec.account, touch: touches + 1, company: rec.company || '' };
    const why = reasons.get(email) || (rec.repliedAt ? 'replied' : rec.bouncedAt ? 'bounced before' : rec.unsubscribedAt ? 'unsubscribed' : null)
      || (templateOff(settings, rec.touches[0]?.template) ? offReason(rec.touches[0].template) : null);
    if (why) { skipped.push({ ...base, reason: why }); continue; }
    if (touches >= config.maxTouches) { skipped.push({ ...base, touch: touches, reason: `reached max touches (${touches} of ${config.maxTouches})` }); continue; }
    const acc = byAcct[rec.account];
    if (!acc) {
      skipped.push({ ...base, reason: accountsOf(config).includes(rec.account)
        ? `${rec.account} is no longer in the ${LANE_LABEL[lane]} lane` : `${rec.account} is no longer a sending account` });
      continue;
    }
    if (acc.blocked) { skipped.push({ ...base, reason: `${rec.account}: ${acc.blocked}` }); continue; }
    if (used.has(rec.account)) { waitingForNextClick.push(email); continue; }
    used.add(rec.account);
    assign.push({ ...base, lastSentAt: rec.lastSentAt, dueAt: rec.lastSentAt + config.followUpDays * DAY });
  }
  const laneFuOn = lane === 'regular' || laneOpts(settings, lane).followUps;
  return {
    lane, laneLabel: LANE_LABEL[lane], plainText: laneOpts(settings, lane).plainText,
    today, allowlist: allow, paused: settings.paused, dryRun: settings.dryRun, followUpsOn: settings.followUps && laneFuOn,
    maxTouches: config.maxTouches, followUpDays: config.followUpDays, assign, skipped, waitingForNextClick,
    accounts: accounts.map(({ order, ...a }) => a),
    note: !settings.followUps ? 'follow-ups are turned off in the schedule settings'
      : !laneFuOn ? `follow-ups are turned off for the ${LANE_LABEL[lane]} lane`
      : !accounts.length ? `no account assigned to the ${LANE_LABEL[lane]} lane; nothing can be sent from it`
      : !allow.length ? 'the test-recipient list is empty'
      : !withSends.length ? 'no one on the test-recipient list has been emailed yet; send a test batch first'
      : !assign.length ? 'nobody can get a follow-up right now (see the reasons)' : null,
  };
}

export async function sendTestFollowUps({ now = Date.now(), only = null, lane = 'regular' } = {}) {
  lane = normLane(lane);
  const today = sendingDay(now, await readSettings());
  const notes = [];
  try { const u = await syncUnsubscribes(); if (u) notes.push(`${u} new unsubscribe(s) recorded`); }
  catch (e) { notes.push(`unsubscribe sync failed: ${e.message}`); }
  const first = await testFollowUpPlan({ now, lane });
  if (!first.followUpsOn) return { ...first, results: [], sent: 0, notes };
  const onlySet = only ? new Set(only.map(normEmail)) : null;
  // The reply check the real wait would have given every account.
  const scanFailed = new Map();
  const scans = [];
  for (const a of [...new Set(first.assign.filter((p) => !onlySet || onlySet.has(p.email)).map((p) => p.account))]) {
    if (!hasPassword(a)) continue;
    try { scans.push(await scanAccount(a, now)); }
    catch (e) { scanFailed.set(a, String(e.message || e).slice(0, 200)); }
  }
  const plan = await testFollowUpPlan({ now, lane });   // again, now that replies are in
  const fuTemplate = followupTemplateFor(await readSettings(), lane);
  const allowSet = new Set(plan.allowlist);
  const results = [];
  for (const p of plan.assign) {
    const email = normEmail(p.email);
    if (!allowSet.has(email)) continue;
    if (onlySet && !onlySet.has(email)) { results.push({ ...p, status: 'not in the confirmed list' }); continue; }
    if (scanFailed.has(p.account)) {
      results.push({ ...p, status: 'deferred', reason: `inbox check failed (${scanFailed.get(p.account)}); click Check inbox, then try again` });
      continue;
    }
    const key = testCountKey(today);
    const n = Number(await command('HINCRBY', key, p.account, 1));
    await command('EXPIRE', key, 3 * 86400);
    if (n > TEST_DAILY_LIMIT) { await command('HINCRBY', key, p.account, -1); results.push({ ...p, status: 'test limit reached' }); continue; }
    const item = { id: `${today}:testfu:${p.account.split('@')[0]}:${now.toString(36)}`, date: today, account: p.account, email,
      template: fuTemplate, followUp: true, touch: p.touch, company: p.company, at: now, status: 'planned', testBatch: true, ...laneTag(lane) };
    const r = await sendItem(item, { now, today, bypassPause: true, skipWait: true });
    await command('EXPIRE', K.plan(today), 40 * 86400);
    const wentOut = r.status === 'sent' || r.status === 'bounced' || r.status === 'dry-run' || (r.status === 'failed' && !r.retryable);
    if (!wentOut) await command('HINCRBY', key, p.account, -1);
    results.push({ ...p, ...r });
  }
  // What the re-check stopped: replies or bounces found by the inbox check.
  const firstEmails = new Set(first.assign.map((p) => p.email));
  const stopped = plan.skipped.filter((s) => firstEmails.has(s.email) && (!onlySet || onlySet.has(s.email)));
  for (const s of stopped) results.push({ ...s, status: 'skipped' });
  return { ...plan, results, scans, notes, sent: results.filter((r) => r.status === 'sent').length };
}

// ------------------------------------------------------------------ tick

export async function tick({ now = Date.now(), budgetMs = 40000, scan = true } = {}) {
  const t0 = Date.now();
  const lockId = await acquireLock(90000);
  if (!lockId) return { ok: true, busy: true };
  const out = { ok: true, at: now, results: [], notes: [] };
  try {
    await command('SET', K.lastTick, String(now));
    try { const u = await syncUnsubscribes(); if (u) out.notes.push(`${u} new unsubscribe(s)`); }
    catch (e) { out.notes.push(`unsubscribe sync failed: ${e.message}`); }
    const settings = await readSettings();
    const config = await readConfig();
    const today = sendingDay(now, settings);
    if (settings.paused) out.paused = true;
    else if (!settings.weekdays.includes(eatWeekday(today))) out.notes.push('not a sending day');
    else if (now >= eatAt(today, dayWindow(settings).cutoff)) out.notes.push('past the day\'s cutoff');
    else {
      const plan = await ensurePlan(today, { now });
      let states = await readAccountStates();
      for (const account of shuffle(accountsOf(config))) {
        if (Date.now() - t0 > budgetMs) { out.notes.push('time budget used'); break; }
        if (states[account]?.paused) continue;
        if (!settings.dryRun && !hasPassword(account)) { out.notes.push(`${account}: no app password set (${passwordVar(account)})`); continue; }
        let planned = plan.items.filter((i) => i.account === account && i.status === 'planned');
        if (!planned.length) continue;
        if (planned[0].at < now - 10 * 60000) planned = await reflow(today, account, planned, now, settings);
        const due = planned[0];
        if (!due || due.at > now) continue;
        const last = Number(await command('GET', K.last(account))) || 0;
        if (now - last < settings.minGapMin * 60000) continue;
        const r = await sendItem(due, { now, today });
        out.results.push({ account, item: due.id, ...r });
        if (r.status === 'paused') break;
        states = await readAccountStates();
      }
    }
    if (scan && Date.now() - t0 < budgetMs / 2) {
      const s = await maybeScan(now, config, { t0, budgetMs, notes: out.notes });
      if (s.length) { out.scan = s[0]; out.scans = s; }
    }
  } finally {
    await releaseLock(lockId);
  }
  return out;
}

// ------------------------------------------------------------------ inbox scan

export async function scanAccount(account, now = Date.now()) {
  const st = (await readAccountStates())[account] || {};
  const known = new Set((await command('ZRANGEBYSCORE', K.byAcct(account), now - 60 * DAY, '+inf')) || []);
  if (!known.size) {
    await patchAccountState(account, { lastImapAt: now, lastImapOkAt: now, lastImapError: null });
    return { account, replies: 0, autoReplies: 0, bounces: 0, skipped: 'nobody emailed yet' };
  }
  const since = Math.max(now - 14 * DAY, (st.lastImapOkAt || 0) - 2 * DAY);
  // Our Message-IDs -> recipient, for a reply sent from another address. Only
  // built when the scan meets a message it could not match by sender.
  const threadOf = async (ids) => {
    const want = new Set(ids), map = new Map(), list = [...known];
    for (let i = 0; i < list.length && map.size < want.size; i += 300) {
      const chunk = list.slice(i, i + 300);
      const recs = (await command('HMGET', K.sent, ...chunk)) || [];
      recs.forEach((raw, j) => {
        for (const t of parse(raw)?.touches || []) {
          const id = msgIds(t.messageId)[0] || String(t.messageId || '').toLowerCase();
          if (id && want.has(id)) map.set(id, chunk[j]);
        }
      });
    }
    return map;
  };
  let found;
  try {
    found = await scanInbox(account, { since, known, threadOf });
  } catch (e) {
    const msg = String(e?.responseText || e?.message || e).slice(0, 200);
    await patchAccountState(account, { lastImapAt: now, lastImapError: msg });
    throw new Error(`${account}: ${msg}`);
  }
  let replies = 0, autoReplies = 0, bounces = 0;
  const feed = [];
  for (const r of found.replies) {
    const rec = parse(await command('HGET', K.sent, r.email));
    if (!rec || rec.repliedAt || r.at < rec.firstSentAt) continue;
    rec.repliedAt = r.at;
    rec.replySubject = r.subject || '';
    if (r.from && r.from !== r.email) rec.replyFrom = r.from;
    await pipeline([['HSET', K.sent, r.email, JSON.stringify(rec)], ['ZREM', K.fu, r.email]]);
    await addLog({ account, to: r.email, status: 'replied', subject: r.subject, templateId: rec.template, ...(rec.replyFrom ? { from: rec.replyFrom } : {}) });
    feed.push({ email: r.email, at: r.at, account, subject: r.subject || '', ...(rec.replyFrom ? { from: rec.replyFrom } : {}) });
    replies++;
  }
  // An out-of-office is not an answer: it is kept apart from the reply rate
  // and does not stop the follow-ups.
  for (const r of found.autoReplies || []) {
    const rec = parse(await command('HGET', K.sent, r.email));
    if (!rec || rec.repliedAt || rec.autoReplyAt || r.at < rec.firstSentAt) continue;
    rec.autoReplyAt = r.at;
    rec.autoReplySubject = r.subject || '';
    await command('HSET', K.sent, r.email, JSON.stringify(rec));
    await addLog({ account, to: r.email, status: 'auto-reply', subject: r.subject, templateId: rec.template });
    feed.push({ email: r.email, at: r.at, account, subject: r.subject || '', auto: true });
    autoReplies++;
  }
  if (feed.length) {
    await pipeline([['LPUSH', K.replies, ...feed.map((f) => JSON.stringify(f))], ['LTRIM', K.replies, 0, 499]]);
    // Only ever forward: accounts are scanned one after another, and an older
    // reply found later must not hide a newer one from the badge.
    const newest = Math.max(0, ...feed.filter((f) => !f.auto).map((f) => f.at));
    if (newest > (Number(await command('GET', K.lastReply)) || 0)) await command('SET', K.lastReply, String(newest));
  }
  for (const b of found.bounces) {
    const rec = parse(await command('HGET', K.sent, b.email));
    if (!rec || rec.bouncedAt || b.at < rec.firstSentAt) continue;
    rec.bouncedAt = b.at; rec.bounceReason = b.reason;
    await pipeline([['HSET', K.sent, b.email, JSON.stringify(rec)], ['ZREM', K.fu, b.email]]);
    await addLog({ account, to: b.email, status: 'bounced', error: b.reason, templateId: rec.template });
    bounces++;
  }
  await patchAccountState(account, { lastImapAt: now, lastImapOkAt: now, lastImapError: null });
  if (bounces) await checkBounceAutoPause(account, now);
  return { account, replies, autoReplies, bounces };
}

// Inboxes not checked in the last SCAN_EVERY_MIN minutes, oldest first.
export const SCAN_EVERY_MIN = 10;
async function dueForScan(now, config) {
  const states = await readAccountStates();
  return accountsOf(config).filter((a) => hasPassword(a) && !(states[a]?.lastImapAt > now - SCAN_EVERY_MIN * 60000))
    .sort((a, b) => (states[a]?.lastImapAt || 0) - (states[b]?.lastImapAt || 0));
}

// Every due inbox while the tick has time, so replies show up within minutes
// of arriving whatever the trigger's rhythm. One failing account doesn't stop
// the others.
async function maybeScan(now, config, { t0, budgetMs, notes }) {
  const out = [];
  for (const a of await dueForScan(now, config)) {
    if (Date.now() - t0 > budgetMs / 2) { notes.push('inbox checks continue next tick'); break; }
    try { out.push(await scanAccount(a, now)); }
    catch (e) { notes.push(`inbox check failed: ${e.message}`); }
  }
  return out;
}

// "Check inboxes now": every account with an app password, whenever asked.
export async function scanAll(now = Date.now()) {
  const config = await readConfig();
  const results = [];
  for (const a of accountsOf(config).filter(hasPassword)) {
    try { results.push(await scanAccount(a, now)); }
    catch (e) { results.push({ account: a, error: String(e.message || e).slice(0, 200) }); }
  }
  return { results, replies: results.reduce((n, r) => n + (r.replies || 0), 0), autoReplies: results.reduce((n, r) => n + (r.autoReplies || 0), 0),
    bounces: results.reduce((n, r) => n + (r.bounces || 0), 0), failed: results.filter((r) => r.error).length };
}

// ------------------------------------------------------------------ today's run
//
// Where the current sending day stands, for the dashboard: its date, when it
// opens, its latest start and its cutoff, and the next run after it.
// state: 'before' (opens later), 'open', 'closed' (cutoff passed) or 'offDay'.
export function runStatus(now, settings) {
  const w = dayWindow(settings);
  const day = sendingDay(now, settings);
  const at = (d) => ({ opensAt: eatAt(d, w.start), lastStartAt: eatAt(d, w.end), closesAt: eatAt(d, w.cutoff) });
  const t = at(day);
  const state = !settings.weekdays.includes(eatWeekday(day)) ? 'offDay' : now < t.opensAt ? 'before' : now < t.closesAt ? 'open' : 'closed';
  const nextDay = state === 'before' || state === 'open' ? day : nextWeekday(day, settings.weekdays);
  return { day, state, paused: Boolean(settings.paused), ...t, overnight: w.cutoff > 24 * 60, next: { day: nextDay, ...at(nextDay) } };
}

// ------------------------------------------------------------------ health

export async function health(now = Date.now()) {
  const config = await readConfig();
  const settings = await readSettings();
  const states = await readAccountStates();
  const today = sendingDay(now, settings);
  const dayStart = eatAt(today, 0);
  const counts = (await command('HGETALL', K.count(today))) || [];
  const attempts = {};
  for (let i = 0; i < counts.length; i += 2) attempts[counts[i]] = Number(counts[i + 1]);
  const out = [];
  for (const a of accountsOf(config)) {
    const emails = (await command('ZRANGEBYSCORE', K.byAcct(a), now - 7 * DAY, '+inf')) || [];
    const recs = emails.length ? (await command('HMGET', K.sent, ...emails)).map((r) => parse(r)).filter(Boolean) : [];
    let sentToday = 0, sent7 = 0;
    const tokens = [];
    for (const r of recs) for (const t of r.touches) {
      if (t.at >= now - 7 * DAY) { sent7++; tokens.push(t.t); }
      if (t.at >= dayStart) sentToday++;
    }
    let opened = 0;
    for (let i = 0; i < tokens.length; i += 300) {
      const hits = await command('HMGET', 'mailer:opens', ...tokens.slice(i, i + 300));
      opened += hits.filter(Boolean).length;
    }
    const b = await bounceRate(a);
    const st = states[a] || {};
    const lane = laneOf(settings, a);
    out.push({
      account: a, name: config.senders[a] || '', hasPassword: hasPassword(a), passwordVar: passwordVar(a),
      server: mailServer(a).smtp, customServer: mailServer(a).custom, serverVar: serverVar(a),
      lane, plainText: laneOpts(settings, lane).plainText,
      paused: Boolean(st.paused), autoPaused: Boolean(st.paused && st.auto), pauseReason: st.reason || '', pausedAt: st.at || null,
      attemptsToday: attempts[a] || 0, sentToday, sent7d: sent7, opened7d: opened,
      replied7d: recs.filter((r) => r.repliedAt).length, bounced7d: recs.filter((r) => r.bouncedAt).length,
      unsubscribed7d: recs.filter((r) => r.unsubscribedAt).length,
      bounceRate50: b, cap: laneCap(settings, lane),
      lastSendAt: Number(await command('GET', K.last(a))) || null,
      lastImapAt: st.lastImapAt || null, lastImapOkAt: st.lastImapOkAt || null, lastImapError: st.lastImapError || null,
    });
  }
  return out;
}

export async function followUpsDue(now = Date.now(), days = 7) {
  const config = await readConfig();
  const emails = (await command('ZRANGEBYSCORE', K.fu, '-inf', now + days * DAY - config.followUpDays * DAY, 'LIMIT', 0, 500)) || [];
  if (!emails.length) return [];
  const recs = await command('HMGET', K.sent, ...emails);
  return emails.map((e, i) => {
    const r = parse(recs[i], {});
    return { email: e, account: r.account, lane: contactLane(r), company: r.company, touches: r.touches?.length || 0,
      lastSentAt: r.lastSentAt, dueAt: r.lastSentAt + config.followUpDays * DAY, dueDate: eatDate(r.lastSentAt + config.followUpDays * DAY) };
  }).filter((x) => x.touches < config.maxTouches);
}

export { eatDate, eatClock, nextWeekday, addDays };

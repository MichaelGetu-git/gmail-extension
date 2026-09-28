// data.purge — take named addresses (a test upload, your own inboxes) out of
// the sending data, so they stop counting in the rates. Unlike data.reset it
// touches nothing else: real sends, their replies and their history stay.
//
// Removed, per address: the contact record, its place in every lane's queue
// and in every day plan, the send record, its tokens and their open and
// unsubscribe hits, the never-twice claims, follow-up rotation, per-account
// history, its send-log entries (test sends included) and their bodies, and
// its entries in the replies feed.
//
// Kept: every suppression list. An address on the opt-out list stays there
// unless alsoOptout is set (meant for your own test inboxes only). Daily
// counters are left to expire.
//
// Without confirm it only reports what it would remove. With confirm:
// 'DELETE' it writes everything it removes to mailer:backup:purge:<ts> (kept
// 180 days, one field per address), reads that back, then deletes.
import { command, pipeline } from './_store.js';
import { K, LANES } from './_settings.js';
import { EMAIL_RE, normEmail } from './_render.js';
import { scanKeys } from './_reset.js';

export const PURGE_MAX = 100;
const OPENS = 'mailer:opens', UNSUB = 'mailer:unsub';
const BACKUP_TTL = 180 * 86400;
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const globEscape = (s) => s.replace(/[*?[\]\\]/g, '\\$&');

export function cleanEmails(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/);
  const list = [...new Set(raw.map((x) => normEmail(String(x || ''))).filter(Boolean))];
  const invalid = list.filter((e) => !EMAIL_RE.test(e));
  if (invalid.length) throw bad(`not an email address: ${invalid.slice(0, 3).join(', ')}`);
  if (!list.length) throw bad('list the addresses to delete');
  if (list.length > PURGE_MAX) throw bad(`at most ${PURGE_MAX} addresses at a time`);
  return list;
}

async function hscanMatch(key, match) {
  const out = [];
  let cursor = '0';
  for (let guard = 0; guard < 1000; guard++) {
    const [next, flat] = await command('HSCAN', key, cursor, 'MATCH', match, 'COUNT', 500);
    for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]);
    cursor = String(next);
    if (cursor === '0') break;
  }
  return out;
}

async function hmget(key, fields) {
  if (!fields.length) return [];
  return (await command('HMGET', key, ...fields)) || [];
}

// Everything stored about each address, raw, so it can be backed up exactly.
async function collect(list) {
  const want = new Set(list);
  const found = new Map(list.map((e) => [e, {
    contact: null, queues: {}, plan: [], sent: null, tokens: [], opens: {}, unsub: {}, guards: [], fu: null,
    byAcct: {}, recent: {}, log: [], feed: [], optout: false,
  }]));
  // Read once for everyone.
  for (const lane of LANES) {
    for (const e of (await command('LRANGE', K.queueOf(lane), 0, -1)) || []) {
      const f = found.get(normEmail(e));
      if (f) f.queues[lane] = (f.queues[lane] || 0) + 1;
    }
  }
  for (const key of await scanKeys('mailer:srv:plan:*')) {
    const flat = (await command('HGETALL', key)) || [];
    for (let i = 0; i < flat.length; i += 2) {
      if (flat[i] === 'meta') continue;
      const f = found.get(normEmail(parse(flat[i + 1])?.email || ''));
      if (f) f.plan.push({ key, field: flat[i], raw: flat[i + 1] });
    }
  }
  const logTokens = new Map();
  for (const raw of (await command('LRANGE', K.log, 0, -1)) || []) {
    const e = parse(raw);
    const f = e && found.get(normEmail(e.to || ''));
    if (!f) continue;
    f.log.push({ raw, id: e.id || null, body: null });
    if (e.token) logTokens.set(e.token, normEmail(e.to));
  }
  for (const raw of (await command('LRANGE', K.replies, 0, -1)) || []) {
    const f = found.get(normEmail(parse(raw)?.email || ''));
    if (f) f.feed.push(raw);
  }
  const byAcctKeys = await scanKeys('mailer:srv:byacct:*');
  const recentKeys = await scanKeys('mailer:srv:recent:*');
  const recentLists = {};
  for (const key of recentKeys) recentLists[key] = (await command('LRANGE', key, 0, -1)) || [];

  for (const email of list) {
    const f = found.get(email);
    const [contact, sent, fu, optout] = await pipeline([
      ['HGET', K.contacts, email], ['HGET', K.sent, email], ['ZSCORE', K.fu, email], ['SISMEMBER', K.optout, email],
    ]);
    f.contact = contact;
    f.sent = sent;
    f.fu = fu;
    f.optout = Boolean(Number(optout));
    const rec = parse(sent);
    const tokens = new Set([...(rec?.touches || []).map((t) => t.t), ...[...logTokens].filter(([, e]) => e === email).map(([t]) => t)].filter(Boolean));
    const list2 = [...tokens];
    // Only token -> address mappings that really point at this address.
    const mapped = await hmget(K.tokens, list2);
    f.tokens = list2.filter((t, i) => mapped[i] === email);
    const opens = await hmget(OPENS, list2);
    const unsub = await hmget(UNSUB, list2);
    list2.forEach((t, i) => { if (opens[i] != null) f.opens[t] = opens[i]; if (unsub[i] != null) f.unsub[t] = unsub[i]; });
    f.guards = await hscanMatch(K.touch, `${globEscape(email)}#*`);
    for (const key of byAcctKeys) {
      const score = await command('ZSCORE', key, email);
      if (score != null) f.byAcct[key] = score;
    }
    for (const key of recentKeys) {
      const n = recentLists[key].filter((x) => normEmail(x) === email).length;
      if (n) f.recent[key] = n;
    }
    const ids = f.log.map((l) => l.id).filter(Boolean);
    const bodies = await hmget(K.logBody, ids);
    const byId = new Map(ids.map((id, i) => [id, bodies[i]]));
    for (const l of f.log) l.body = l.id ? byId.get(l.id) ?? null : null;
  }
  return found;
}

function summarise(email, f) {
  const c = parse(f.contact), r = parse(f.sent);
  const queued = Object.values(f.queues).reduce((n, x) => n + x, 0);
  const summary = {
    email,
    contact: c ? { status: c.status || '', lane: c.lane || 'regular' } : null,
    queued,
    planned: f.plan.length,
    sent: r ? { account: r.account, touches: (r.touches || []).length, firstSentAt: r.firstSentAt || null,
      repliedAt: r.repliedAt || null, autoReplyAt: r.autoReplyAt || null, bouncedAt: r.bouncedAt || null, unsubscribedAt: r.unsubscribedAt || null } : null,
    logEntries: f.log.length,
    opens: Object.keys(f.opens).length,
    unsubscribes: Object.keys(f.unsub).length,
    replies: f.feed.length,
    optout: f.optout,
  };
  summary.found = Boolean(summary.contact || queued || summary.planned || summary.sent || summary.logEntries || summary.opens
    || summary.unsubscribes || summary.replies || f.guards.length || f.fu != null || Object.keys(f.byAcct).length || Object.keys(f.recent).length);
  return summary;
}

function totalsOf(rows) {
  const t = { addresses: rows.length, found: 0, contacts: 0, sent: 0, emails: 0, logEntries: 0, opens: 0, replies: 0, optout: 0 };
  for (const r of rows) {
    if (r.found) t.found++;
    if (r.contact) t.contacts++;
    if (r.sent) { t.sent++; t.emails += r.sent.touches; }
    t.logEntries += r.logEntries; t.opens += r.opens; t.replies += r.replies;
    if (r.optout) t.optout++;
  }
  return t;
}

export async function purgePreview(input) {
  const list = cleanEmails(input);
  const found = await collect(list);
  const rows = list.map((e) => summarise(e, found.get(e)));
  return { rows, totals: totalsOf(rows) };
}

export async function purgeData(input, { now = Date.now(), alsoOptout = false } = {}) {
  const list = cleanEmails(input);
  const found = await collect(list);
  const rows = list.map((e) => summarise(e, found.get(e)));
  const hit = list.filter((e, i) => rows[i].found || (alsoOptout && rows[i].optout));
  const backupKey = `mailer:backup:purge:${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
  if (!hit.length) return { ok: true, rows, totals: totalsOf(rows), backupKey: null, deleted: [] };

  // Back up, then read back, before deleting anything.
  const backup = Object.fromEntries(hit.map((e) => [e, JSON.stringify(found.get(e))]));
  await command('HSET', backupKey, '_meta', JSON.stringify({ at: now, addresses: hit, alsoOptout }));
  for (const [k, v] of Object.entries(backup)) await command('HSET', backupKey, k, v);
  await command('EXPIRE', backupKey, BACKUP_TTL);
  for (const [k, v] of Object.entries(backup)) {
    if ((await command('HGET', backupKey, k)) !== v) { const e = new Error(`backup of ${k} did not read back; nothing deleted`); e.status = 500; throw e; }
  }

  let unsubTouched = false;
  for (const email of hit) {
    const f = found.get(email);
    const cmds = [['HDEL', K.contacts, email], ['HDEL', K.sent, email], ['ZREM', K.fu, email]];
    for (const lane of Object.keys(f.queues)) cmds.push(['LREM', K.queueOf(lane), 0, email]);
    for (const p of f.plan) cmds.push(['HDEL', p.key, p.field]);
    if (f.tokens.length) cmds.push(['HDEL', K.tokens, ...f.tokens]);
    if (Object.keys(f.opens).length) cmds.push(['HDEL', OPENS, ...Object.keys(f.opens)]);
    if (Object.keys(f.unsub).length) { cmds.push(['HDEL', UNSUB, ...Object.keys(f.unsub)]); unsubTouched = true; }
    if (f.guards.length) cmds.push(['HDEL', K.touch, ...f.guards.map(([k]) => k)]);
    for (const key of Object.keys(f.byAcct)) cmds.push(['ZREM', key, email]);
    for (const key of Object.keys(f.recent)) cmds.push(['LREM', key, 0, email]);
    for (const l of f.log) cmds.push(['LREM', K.log, 1, l.raw]);
    const ids = f.log.map((l) => l.id).filter(Boolean);
    if (ids.length) cmds.push(['HDEL', K.logBody, ...ids]);
    for (const raw of f.feed) cmds.push(['LREM', K.replies, 1, raw]);
    if (alsoOptout && f.optout) cmds.push(['SREM', K.optout, email]);
    await pipeline(cmds);
  }
  // The unsubscribe mapping counts entries; after removing some, make the next
  // tick re-map them all (idempotent) rather than risk skipping a new one.
  if (unsubTouched) await command('DEL', K.unsubSeen);
  return { ok: true, rows, totals: totalsOf(rows), backupKey, deleted: hit };
}

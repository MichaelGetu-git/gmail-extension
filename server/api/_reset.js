// data.reset — empty the dashboard's sending data, keep every setting.
//
// Wiped: contacts, queue (every lane's), day plans, the send log and its bodies, per-recipient
// send records and tokens, the replies feed, the never-twice guard, follow-up rotation, per-account
// history/recent/last-send, daily attempt counters and test-send counters, and
// the open records that belong to server-sent mail (server tokens, test-send
// tokens from the log) or to junk timing probes (zzjunkzz…).
//
// Kept: settings (pause, footer, …), templates/config and their history, sender
// accounts and their states, every suppression source (imported lists, opt-outs,
// the extension's history, claimed leads, unsubscribes), the extension's reports
// and the extension's own open records, the lock, the last-tick time, earlier
// backups, and anything under mailer: this file does not recognise.
//
// Everything removed is first written to a backup hash, mailer:backup:reset:<ts>,
// one field per key, and read back before anything is deleted.
import { command } from './_store.js';
import { K } from './_settings.js';

export const WIPE_EXACT = [K.contacts, K.queue, K.sent, K.tokens, K.touch, K.fu, K.plans, K.log, K.logBody, K.replies, K.lastReply];
export const WIPE_PREFIX = ['mailer:srv:plan:', 'mailer:srv:count:', 'mailer:srv:byacct:', 'mailer:srv:recent:',
  'mailer:srv:last:', 'mailer:srv:tests:', 'mailer:srv:queue:'];   // queue: = the Work and Hot lane queues
export const KEEP_EXACT = [K.settings, K.acct, K.lock, K.lastTick, K.fixItemIds, 'mailer:config', K.configHistory, K.suppEmails,
  K.suppDomains, K.optout, K.extContacted, K.unsubSeen, K.leadsClaimed, 'mailer:leads:queue', 'mailer:reports', 'mailer:unsub'];
export const KEEP_PREFIX = ['mailer:backup:', 'mailer:claims:'];
export const OPENS_KEY = 'mailer:opens';
export const JUNK_TOKEN = /^zzjunkzz/;
const BACKUP_TTL = 180 * 86400;

export function classify(key) {
  if (key === OPENS_KEY) return 'partial';
  if (WIPE_EXACT.includes(key) || WIPE_PREFIX.some((p) => key.startsWith(p))) return 'wipe';
  if (KEEP_EXACT.includes(key) || KEEP_PREFIX.some((p) => key.startsWith(p))) return 'keep';
  return 'unknown';   // kept, and reported
}

export async function scanKeys(match) {
  const out = new Set();
  let cursor = '0';
  for (let guard = 0; guard < 1000; guard++) {
    const [next, keys] = await command('SCAN', cursor, 'MATCH', match, 'COUNT', 500);
    for (const k of keys || []) out.add(k);
    cursor = String(next);
    if (cursor === '0') break;
  }
  return [...out].sort();
}

async function sizeOf(key, type) {
  switch (type) {
    case 'hash': return Number(await command('HLEN', key)) || 0;
    case 'list': return Number(await command('LLEN', key)) || 0;
    case 'set': return Number(await command('SCARD', key)) || 0;
    case 'zset': return Number(await command('ZCARD', key)) || 0;
    case 'string': return 1;
    default: return 0;
  }
}

async function dump(key, type) {
  switch (type) {
    case 'hash': return command('HGETALL', key);
    case 'list': return command('LRANGE', key, 0, -1);
    case 'set': return command('SMEMBERS', key);
    case 'zset': return command('ZRANGE', key, 0, -1, 'WITHSCORES');
    case 'string': return command('GET', key);
    default: return null;
  }
}

// Open records that belong to this server's own mail (or junk probes).
async function openFieldsToRemove() {
  const fields = (await command('HKEYS', OPENS_KEY)) || [];
  if (!fields.length) return { remove: [], keep: [] };
  const serverTokens = new Set((await command('HKEYS', K.tokens)) || []);
  const logTokens = new Set();
  for (const j of (await command('LRANGE', K.log, 0, -1)) || []) {
    try { const e = JSON.parse(j); if (e.token) logTokens.add(String(e.token)); } catch { /* skip */ }
  }
  const remove = [], keep = [];
  for (const f of fields) {
    if (serverTokens.has(f)) remove.push({ f, why: 'server-sent' });
    else if (logTokens.has(f)) remove.push({ f, why: 'test send' });
    else if (JUNK_TOKEN.test(f)) remove.push({ f, why: 'junk probe' });
    else keep.push(f);
  }
  return { remove, keep };
}

export async function inventory() {
  const keys = await scanKeys('mailer:*');
  const rows = [];
  for (const key of keys) {
    const type = await command('TYPE', key);
    rows.push({ key, type, size: await sizeOf(key, type), action: classify(key) });
  }
  const opens = await openFieldsToRemove();
  const why = {};
  for (const r of opens.remove) why[r.why] = (why[r.why] || 0) + 1;
  const unsub = (await command('HGETALL', 'mailer:unsub')) || [];
  const unsubTokens = [];
  for (let i = 0; i < unsub.length; i += 2) unsubTokens.push(unsub[i]);
  const unsubMapped = unsubTokens.length ? ((await command('HMGET', K.tokens, ...unsubTokens)) || []).filter(Boolean).length : 0;
  return {
    keys: rows,
    opens: { total: opens.remove.length + opens.keep.length, remove: opens.remove.length, removeBy: why, keep: opens.keep.length },
    unsub: { total: unsubTokens.length, fromServerMail: unsubMapped, kept: true },
    wipe: rows.filter((r) => r.action === 'wipe').map((r) => r.key),
    unknown: rows.filter((r) => r.action === 'unknown').map((r) => r.key),
  };
}

export async function resetData({ now = Date.now() } = {}) {
  const inv = await inventory();
  const opens = await openFieldsToRemove();
  const backupKey = `mailer:backup:reset:${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
  const backup = {};
  const wipeRows = inv.keys.filter((r) => r.action === 'wipe');
  for (const r of wipeRows) backup[r.key] = { type: r.type, data: await dump(r.key, r.type) };
  if (opens.remove.length) {
    const vals = (await command('HMGET', OPENS_KEY, ...opens.remove.map((x) => x.f))) || [];
    backup[`${OPENS_KEY} (removed fields)`] = { type: 'hash-fields', data: opens.remove.flatMap((x, i) => [x.f, vals[i]]) };
  }
  const meta = { at: now, keys: wipeRows.map((r) => ({ key: r.key, type: r.type, size: r.size })), opensRemoved: opens.remove.length };
  // Write the backup, one field per key, then read it back before deleting.
  await command('HSET', backupKey, '_meta', JSON.stringify(meta));
  for (const [k, v] of Object.entries(backup)) await command('HSET', backupKey, k, JSON.stringify(v));
  await command('EXPIRE', backupKey, BACKUP_TTL);
  const stored = Number(await command('HLEN', backupKey)) || 0;
  if (stored !== Object.keys(backup).length + 1) {
    const e = new Error(`backup incomplete (${stored} of ${Object.keys(backup).length + 1} fields); nothing deleted`); e.status = 500; throw e;
  }
  for (const [k, v] of Object.entries(backup)) {
    const back = await command('HGET', backupKey, k);
    if (back !== JSON.stringify(v)) { const e = new Error(`backup of ${k} did not read back; nothing deleted`); e.status = 500; throw e; }
  }
  // Delete.
  const deleted = [];
  for (const r of wipeRows) { if (Number(await command('DEL', r.key))) deleted.push(r.key); }
  let opensRemoved = 0;
  const fields = opens.remove.map((x) => x.f);
  for (let i = 0; i < fields.length; i += 500) opensRemoved += Number(await command('HDEL', OPENS_KEY, ...fields.slice(i, i + 500))) || 0;
  return { ok: true, backupKey, before: inv, deleted, opensRemoved, opensKept: opens.keep.length, backup };
}

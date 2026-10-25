// The store's Redis commands on Cloud Firestore, as a second backend next to
// Upstash (_store.js picks it when MAILER_STORE=firestore). Only the commands
// this app sends are here, with the replies Upstash gives for them, so
// nothing above _store.js knows which backend it is talking to.
//
// It lives in its own named Firestore database (FIRESTORE_DATABASE, default
// "mailer"), so a project's (default) database and anything else in it are
// never read or written.
//
// Layout, one root collection "kv", one document per Redis key:
//   kv/{key}            {k: key, t: type, exp?: ms, v?: string value}
//   kv/{key}/h/{field}  {f, v}        hash fields
//   kv/{key}/s/{member} {m}           set members
//   kv/{key}/z/{member} {m, s}        sorted-set members and scores
//   kv/{key}/l/{auto}   {v, p, h}     list items: p orders them, h = sha1(v)
// A key with exp in the past reads as missing and is cleared on the next write.
// Like an Upstash pipeline, a pipeline here is not atomic; the commands that
// must be (SET NX, HSETNX, HINCRBY, LPOP, the unlock script) are.
import { createHash } from 'node:crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldPath, FieldValue } from 'firebase-admin/firestore';

let db = null;
function store() {
  if (db) return db;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  const sa = raw ? JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')) : null;
  const projectId = process.env.FIREBASE_PROJECT_ID || sa?.project_id;
  const app = getApps().find((a) => a.name === 'mailer')
    || initializeApp(sa ? { credential: cert(sa), projectId } : { projectId }, 'mailer');
  db = getFirestore(app, process.env.FIRESTORE_DATABASE || 'mailer');
  return db;
}

// Document ids: no '/', never '.', '..' or '__x__'.
const did = (s) => `~${encodeURIComponent(String(s)).replace(/\./g, '%2E')}`;
const sha = (v) => createHash('sha1').update(String(v)).digest('hex');
const ref = (key) => store().collection('kv').doc(did(key));
const sub = (key, kind) => ref(key).collection(kind);
const now = () => Date.now();
const alive = (snap) => snap.exists && !(snap.get('exp') && snap.get('exp') <= now());
const S = (v) => (v === null || v === undefined ? v : String(v));

async function meta(key) { return ref(key).get(); }
async function wipe(key) { await store().recursiveDelete(ref(key)); }

// Before writing a collection type: an expired or differently typed key is
// cleared, and the key document exists with its type.
async function prep(key, type) {
  const m = await meta(key);
  if (m.exists && (!alive(m) || m.get('t') !== type)) await wipe(key);
  else if (m.exists) return;
  await ref(key).set({ k: String(key), t: type });
}

async function commitAll(ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const b = store().batch();
    for (const op of ops.slice(i, i + 450)) op(b);
    await b.commit();
  }
}

async function count(key, kind) {
  const m = await meta(key);
  if (!alive(m)) return 0;
  return (await sub(key, kind).count().get()).data().count;
}

function glob(pattern) {
  return new RegExp(`^${String(pattern).replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}
function opt(args, name) {
  const i = args.findIndex((a) => String(a).toUpperCase() === name);
  return i < 0 ? undefined : args[i + 1];
}

// ---- strings
async function get(key) {
  const m = await meta(key);
  return alive(m) && m.get('t') === 'string' ? S(m.get('v')) : null;
}
async function set(key, value, ...rest) {
  const up = rest.map((r) => String(r).toUpperCase());
  const px = opt(rest, 'PX'), ex = opt(rest, 'EX');
  const exp = px !== undefined ? now() + Number(px) : ex !== undefined ? now() + Number(ex) * 1000 : null;
  const doc = { k: String(key), t: 'string', v: String(value), ...(exp ? { exp } : {}) };
  if (up.includes('NX')) return setNX(key, doc);
  const m = await meta(key);
  if (m.exists && m.get('t') !== 'string') await wipe(key);
  await ref(key).set(doc);
  return 'OK';
}

// The tick lock, without a transaction: twenty-five ticks racing for one
// document in transactions can time out instead of simply losing. create()
// fails atomically when the key exists; an expired one is replaced only if it
// is still the version just read (compare-and-swap on its update time).
const conflict = (e) => [6, 9].includes(e.code) || /already exists|precondition/i.test(e.message);
async function setNX(key, doc) {
  try { await ref(key).create(doc); return 'OK'; } catch (e) { if (!conflict(e)) throw e; }
  const m = await meta(key);
  if (!m.exists || alive(m)) return null;
  try { await ref(key).update({ ...doc, exp: doc.exp ?? FieldValue.delete() }, { lastUpdateTime: m.updateTime }); return 'OK'; }
  catch (e) { if (conflict(e)) return null; throw e; }
}

// A transaction that lost to a concurrent one is tried again a few times,
// after a short random pause, on top of the SDK's own retries.
async function transact(fn) {
  for (let attempt = 0; ; attempt++) {
    try { return await store().runTransaction(fn); }
    catch (e) {
      if (attempt >= 4 || !(e.code === 10 || /aborted|contention|lock timeout/i.test(e.message))) throw e;
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 200 * (attempt + 1)));
    }
  }
}

// ---- hashes
async function hset(key, ...fv) {
  if (!fv.length) return 0;
  await prep(key, 'hash');
  const pairs = [];
  for (let i = 0; i < fv.length; i += 2) pairs.push([String(fv[i]), String(fv[i + 1])]);
  const snaps = await store().getAll(...pairs.map(([f]) => sub(key, 'h').doc(did(f))));
  await commitAll(pairs.map(([f, v]) => (b) => b.set(sub(key, 'h').doc(did(f)), { f, v })));
  return snaps.filter((s) => !s.exists).length;
}
async function hmget(key, ...fields) {
  if (!fields.length) return [];
  const [m, ...snaps] = await store().getAll(ref(key), ...fields.map((f) => sub(key, 'h').doc(did(f))));
  if (!alive(m)) return fields.map(() => null);
  return snaps.map((s) => (s.exists ? S(s.get('v')) : null));
}
async function hgetall(key) {
  const m = await meta(key);
  if (!alive(m)) return [];
  return (await sub(key, 'h').get()).docs.flatMap((d) => [d.get('f'), S(d.get('v'))]);
}
async function hdel(key, ...fields) {
  if (!fields.length) return 0;
  const m = await meta(key);
  if (!alive(m)) return 0;
  const snaps = await store().getAll(...fields.map((f) => sub(key, 'h').doc(did(f))));
  const there = snaps.filter((s) => s.exists);
  await commitAll(there.map((s) => (b) => b.delete(s.ref)));
  return there.length;
}
async function hsetnx(key, field, value) {
  await prep(key, 'hash');
  try { await sub(key, 'h').doc(did(field)).create({ f: String(field), v: String(value) }); return 1; }
  catch (e) { if (e.code === 6 || /already exists/i.test(e.message)) return 0; throw e; }
}
async function hincrby(key, field, by) {
  await prep(key, 'hash');
  const r = sub(key, 'h').doc(did(field));
  return transact(async (tx) => {
    const s = await tx.get(r);
    const n = (s.exists ? Number(s.get('v')) || 0 : 0) + Number(by);
    tx.set(r, { f: String(field), v: String(n) });
    return n;
  });
}
async function hscan(key, cursor, ...rest) {
  const m = await meta(key);
  if (!alive(m)) return ['0', []];
  const n = Number(opt(rest, 'COUNT') || 10);
  const match = opt(rest, 'MATCH');
  let q = sub(key, 'h').orderBy(FieldPath.documentId()).limit(n);
  if (String(cursor) !== '0') q = q.startAfter(String(cursor));
  const docs = (await q.get()).docs;
  const re = match ? glob(match) : null;
  const flat = docs.filter((d) => !re || re.test(d.get('f'))).flatMap((d) => [d.get('f'), S(d.get('v'))]);
  return [docs.length === n ? docs[docs.length - 1].id : '0', flat];
}

// ---- sets
async function sadd(key, ...members) {
  if (!members.length) return 0;
  await prep(key, 'set');
  const ms = [...new Set(members.map(String))];
  const snaps = await store().getAll(...ms.map((m) => sub(key, 's').doc(did(m))));
  const fresh = ms.filter((_, i) => !snaps[i].exists);
  await commitAll(fresh.map((m) => (b) => b.set(sub(key, 's').doc(did(m)), { m })));
  return fresh.length;
}
async function srem(key, ...members) {
  if (!members.length) return 0;
  const m = await meta(key);
  if (!alive(m)) return 0;
  const snaps = await store().getAll(...members.map((x) => sub(key, 's').doc(did(x))));
  const there = snaps.filter((s) => s.exists);
  await commitAll(there.map((s) => (b) => b.delete(s.ref)));
  return there.length;
}
async function smismember(key, ...members) {
  if (!members.length) return [];
  const [m, ...snaps] = await store().getAll(ref(key), ...members.map((x) => sub(key, 's').doc(did(x))));
  return snaps.map((s) => (alive(m) && s.exists ? 1 : 0));
}
async function smembers(key) {
  const m = await meta(key);
  if (!alive(m)) return [];
  return (await sub(key, 's').get()).docs.map((d) => d.get('m'));
}

// ---- sorted sets
async function zadd(key, ...sm) {
  if (!sm.length) return 0;
  await prep(key, 'zset');
  const pairs = [];
  for (let i = 0; i < sm.length; i += 2) pairs.push([Number(sm[i]), String(sm[i + 1])]);
  const snaps = await store().getAll(...pairs.map(([, m]) => sub(key, 'z').doc(did(m))));
  await commitAll(pairs.map(([s, m]) => (b) => b.set(sub(key, 'z').doc(did(m)), { m, s })));
  return snaps.filter((x) => !x.exists).length;
}
async function zrem(key, ...members) {
  if (!members.length) return 0;
  const m = await meta(key);
  if (!alive(m)) return 0;
  const snaps = await store().getAll(...members.map((x) => sub(key, 'z').doc(did(x))));
  const there = snaps.filter((s) => s.exists);
  await commitAll(there.map((s) => (b) => b.delete(s.ref)));
  return there.length;
}
async function zscore(key, member) {
  const [m, s] = await store().getAll(ref(key), sub(key, 'z').doc(did(member)));
  return alive(m) && s.exists ? String(s.get('s')) : null;
}
const bound = (v) => {
  const s = String(v);
  if (/^[-+]?inf$/i.test(s)) return { v: s.startsWith('-') ? -Infinity : Infinity, open: false };
  return s.startsWith('(') ? { v: Number(s.slice(1)), open: true } : { v: Number(s), open: false };
};
const withScores = (docs, ws) => docs.flatMap((d) => (ws ? [d.get('m'), String(d.get('s'))] : [d.get('m')]));
async function zrangebyscore(key, min, max, ...rest) {
  const m = await meta(key);
  if (!alive(m)) return [];
  const lo = bound(min), hi = bound(max);
  let q = sub(key, 'z');
  if (lo.v !== -Infinity) q = q.where('s', lo.open ? '>' : '>=', lo.v);
  if (hi.v !== Infinity) q = q.where('s', hi.open ? '<' : '<=', hi.v);
  q = q.orderBy('s');
  const li = rest.findIndex((a) => String(a).toUpperCase() === 'LIMIT');
  if (li >= 0) {
    const off = Number(rest[li + 1]), cnt = Number(rest[li + 2]);
    if (off) q = q.offset(off);
    if (cnt >= 0) q = q.limit(cnt);
  }
  const ws = rest.some((a) => String(a).toUpperCase() === 'WITHSCORES');
  return withScores((await q.get()).docs, ws);
}
async function zrange(key, start, stop, ...rest) {
  const m = await meta(key);
  if (!alive(m)) return [];
  const docs = (await sub(key, 'z').orderBy('s').get()).docs;
  const [a, b] = span(Number(start), Number(stop), docs.length);
  return withScores(docs.slice(a, b + 1), rest.some((x) => String(x).toUpperCase() === 'WITHSCORES'));
}

// ---- lists
function span(start, stop, len) {
  const a = start < 0 ? Math.max(0, len + start) : start;
  const b = stop < 0 ? len + stop : Math.min(stop, len - 1);
  return [a, b];
}
// Positions are handed out in a small transaction on the key document; the
// items are written after it, so pushing thousands never hits the 500-write limit.
async function push(key, values, left) {
  if (!values.length) return count(key, 'l');
  await prep(key, 'list');
  const vs = values.map(String);
  const pos = await transact(async (tx) => {
    const m = await tx.get(ref(key));
    const head = m.get('head') ?? 0, tail = m.get('tail') ?? -1;
    if (left) { tx.update(ref(key), { head: head - vs.length }); return vs.map((_, i) => head - 1 - i); }
    tx.update(ref(key), { tail: tail + vs.length });
    return vs.map((_, i) => tail + 1 + i);
  });
  await commitAll(vs.map((v, i) => (b) => b.set(sub(key, 'l').doc(), { v, p: pos[i], h: sha(v) })));
  return (await sub(key, 'l').count().get()).data().count;
}
async function lrange(key, start, stop) {
  const m = await meta(key);
  if (!alive(m)) return [];
  start = Number(start); stop = Number(stop);
  let q = sub(key, 'l').orderBy('p');
  if (start >= 0 && stop >= 0) {
    if (stop < start) return [];
    if (start) q = q.offset(start);
    return (await q.limit(stop - start + 1).get()).docs.map((d) => d.get('v'));
  }
  const docs = (await q.get()).docs;
  const [a, b] = span(start, stop, docs.length);
  return docs.slice(a, b + 1).map((d) => d.get('v'));
}
async function lpop(key, n) {
  const m = await meta(key);
  if (!alive(m)) return null;
  const want = n === undefined ? 1 : Number(n);
  const vals = await transact(async (tx) => {
    const docs = (await tx.get(sub(key, 'l').orderBy('p').limit(want))).docs;
    for (const d of docs) tx.delete(d.ref);
    return docs.map((d) => d.get('v'));
  });
  if (n === undefined) return vals[0] ?? null;
  return vals.length ? vals : null;
}
async function ltrim(key, start, stop) {
  const m = await meta(key);
  if (!alive(m)) return 'OK';
  const len = (await sub(key, 'l').count().get()).data().count;
  const [a, b] = span(Number(start), Number(stop), len);
  const drop = [];
  if (a > 0) drop.push(...(await sub(key, 'l').orderBy('p').limit(a).get()).docs);
  if (b + 1 < len) drop.push(...(await sub(key, 'l').orderBy('p').offset(Math.max(0, b + 1)).get()).docs);
  await commitAll(drop.map((d) => (bt) => bt.delete(d.ref)));
  return 'OK';
}
async function lrem(key, n, value) {
  const m = await meta(key);
  if (!alive(m)) return 0;
  // Equality on the hash, ordering in memory: no composite index needed.
  let docs = (await sub(key, 'l').where('h', '==', sha(value)).get()).docs
    .filter((d) => d.get('v') === String(value)).sort((x, y) => x.get('p') - y.get('p'));
  n = Number(n);
  if (n > 0) docs = docs.slice(0, n);
  else if (n < 0) docs = docs.slice(n);
  await commitAll(docs.map((d) => (b) => b.delete(d.ref)));
  return docs.length;
}

// ---- keys
async function del(...keys) {
  let n = 0;
  for (const k of keys) { const m = await meta(k); if (m.exists) { if (alive(m)) n++; await wipe(k); } }
  return n;
}
async function exists(...keys) {
  if (!keys.length) return 0;
  const snaps = await store().getAll(...keys.map(ref));
  return snaps.filter(alive).length;
}
async function expire(key, secs) {
  const m = await meta(key);
  if (!alive(m)) return 0;
  await ref(key).update({ exp: now() + Number(secs) * 1000 });
  return 1;
}
// Redis: -2 no such key, -1 no expiry, else the time left.
async function ttl(key, unit) {
  const m = await meta(key);
  if (!alive(m)) return -2;
  if (!m.get('exp')) return -1;
  return Math.max(0, Math.round((m.get('exp') - now()) / unit));
}
async function type(key) {
  const m = await meta(key);
  return alive(m) ? m.get('t') : 'none';
}
async function scan(cursor, ...rest) {
  const n = Number(opt(rest, 'COUNT') || 10);
  const re = opt(rest, 'MATCH') ? glob(opt(rest, 'MATCH')) : null;
  let q = store().collection('kv').orderBy(FieldPath.documentId()).limit(n);
  if (String(cursor) !== '0') q = q.startAfter(String(cursor));
  const docs = (await q.get()).docs;
  const keys = docs.filter((d) => alive(d) && (!re || re.test(d.get('k')))).map((d) => d.get('k'));
  return [docs.length === n ? docs[docs.length - 1].id : '0', keys];
}
// Every live key matching a pattern (the tests' secret-hygiene dump).
async function keys(pattern) {
  const re = glob(pattern);
  return (await store().collection('kv').get()).docs.filter((d) => alive(d) && re.test(d.get('k'))).map((d) => d.get('k'));
}
// The one script the app runs: release the tick lock only if it is still ours.
async function evalScript(script, nkeys, key, arg) {
  if (!/redis\.call\('get',KEYS\[1\]\)==ARGV\[1\]/.test(script) || !/redis\.call\('del',KEYS\[1\]\)/.test(script)) {
    throw new Error('EVAL: only the unlock script is supported on Firestore');
  }
  const m = await meta(key);
  if (!alive(m) || m.get('v') !== String(arg)) return 0;
  try { await ref(key).delete({ lastUpdateTime: m.updateTime }); return 1; }
  catch (e) { if (conflict(e)) return 0; throw e; }
}

const COMMANDS = {
  GET: get, SET: set, DEL: del, EXISTS: exists, EXPIRE: expire, TYPE: type, SCAN: scan, KEYS: keys, EVAL: evalScript,
  TTL: (k) => ttl(k, 1000), PTTL: (k) => ttl(k, 1),
  HSET: hset, HGET: async (k, f) => (await hmget(k, f))[0], HMGET: hmget, HGETALL: hgetall, HDEL: hdel,
  HSETNX: hsetnx, HINCRBY: hincrby, HSCAN: hscan, HLEN: (k) => count(k, 'h'),
  HEXISTS: async (k, f) => ((await hmget(k, f))[0] === null ? 0 : 1),
  HKEYS: async (k) => (await hgetall(k)).filter((_, i) => i % 2 === 0),
  HVALS: async (k) => (await hgetall(k)).filter((_, i) => i % 2 === 1),
  SADD: sadd, SREM: srem, SMEMBERS: smembers, SMISMEMBER: smismember, SCARD: (k) => count(k, 's'),
  SISMEMBER: async (k, m) => (await smismember(k, m))[0],
  ZADD: zadd, ZREM: zrem, ZSCORE: zscore, ZRANGEBYSCORE: zrangebyscore, ZRANGE: zrange, ZCARD: (k) => count(k, 'z'),
  LPUSH: (k, ...v) => push(k, v, true), RPUSH: (k, ...v) => push(k, v, false), LRANGE: lrange, LPOP: lpop,
  LTRIM: ltrim, LREM: lrem, LLEN: (k) => count(k, 'l'),
};

export async function fsCommand(args) {
  const [name, ...rest] = args;
  const fn = COMMANDS[String(name).toUpperCase()];
  if (!fn) throw new Error(`ERR command ${name} is not supported on Firestore`);
  return fn(...rest);
}

// Tests only: empty this store's database (never another one).
export async function fsFlush() { await store().recursiveDelete(store().collection('kv')); }

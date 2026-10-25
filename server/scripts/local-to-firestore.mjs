// One-time copy of every mailer key from the local Redis (Docker) into the
// Firestore backend, then a count check of each key on both sides.
//
//   node scripts/local-to-firestore.mjs --sa ../firebase-sa.local.json [--database mailer] [--dry]
//
// Only the database named by --database (default "mailer") is written; a
// project's (default) database is never touched. Keys keep their expiry.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startShim } from '../test/upstash-shim.mjs';
import { root, arg, flag } from './_local.mjs';

const sa = readFileSync(arg('sa', join(root, '..', 'firebase-sa.local.json')), 'utf8');
Object.assign(process.env, { MAILER_STORE: 'firestore', FIREBASE_SERVICE_ACCOUNT: sa, FIRESTORE_DATABASE: arg('database', 'mailer') });
const { fsCommand } = await import('../api/_firestore.js');

// Redis side, through the same Upstash-style shim the local runner uses.
const shim = await startShim({ redisPort: Number(arg('redis-port', 6390)), token: 'copy' });
const redis = async (...args) => {
  const r = await (await fetch(`http://127.0.0.1:${shim.port}`, { method: 'POST', headers: { authorization: 'Bearer copy' }, body: JSON.stringify(args) })).json();
  if (r.error) throw new Error(r.error);
  return r.result;
};

const keys = [];
let cursor = '0';
do { const [next, batch] = await redis('SCAN', cursor, 'MATCH', 'mailer:*', 'COUNT', 1000); keys.push(...batch); cursor = next; } while (cursor !== '0');
keys.sort();
console.log(`${keys.length} keys in the local Redis`);

const pairs = (flat) => { const o = []; for (let i = 0; i < flat.length; i += 2) o.push([flat[i], flat[i + 1]]); return o; };
const sizeOf = { string: async () => 1, hash: (k, c) => c('HLEN', k), set: (k, c) => c('SCARD', k), zset: (k, c) => c('ZCARD', k), list: (k, c) => c('LLEN', k) };
const fsc = (...a) => fsCommand(a);
const report = [];
for (const key of keys) {
  const type = await redis('TYPE', key);
  const ttl = Number(await redis('PTTL', key));
  if (!flag('dry')) {
    await fsCommand(['DEL', key]);
    if (type === 'string') await fsCommand(['SET', key, await redis('GET', key)]);
    else if (type === 'hash') { const p = pairs(await redis('HGETALL', key)); for (let i = 0; i < p.length; i += 200) await fsCommand(['HSET', key, ...p.slice(i, i + 200).flat()]); }
    else if (type === 'set') { const m = await redis('SMEMBERS', key); for (let i = 0; i < m.length; i += 300) await fsCommand(['SADD', key, ...m.slice(i, i + 300)]); }
    else if (type === 'zset') { const p = pairs(await redis('ZRANGE', key, 0, -1, 'WITHSCORES')); for (let i = 0; i < p.length; i += 200) await fsCommand(['ZADD', key, ...p.slice(i, i + 200).flatMap(([m, s]) => [s, m])]); }
    else if (type === 'list') { const v = await redis('LRANGE', key, 0, -1); for (let i = 0; i < v.length; i += 300) await fsCommand(['RPUSH', key, ...v.slice(i, i + 300)]); }
    else { report.push([key, type, 'skipped: unknown type']); continue; }
    if (ttl > 0) await fsCommand(['EXPIRE', key, Math.ceil(ttl / 1000)]);
  }
  const want = await sizeOf[type]?.(key, redis);
  const got = flag('dry') ? '-' : await sizeOf[type]?.(key, fsc);
  report.push([key, type, want, got]);
  process.stderr.write('.');
}
process.stderr.write('\n');
const bad = report.filter(([, , w, g]) => g !== '-' && Number(w) !== Number(g));
for (const r of report) console.log(r.join('  '));
console.log(bad.length ? `MISMATCHES: ${bad.length}` : `all ${report.length} keys match`);
shim.close();
process.exit(bad.length ? 1 : 0);

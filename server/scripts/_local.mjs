// Shared by the local-* scripts: run the server's code on this machine against
// a Redis in Docker instead of Upstash, with the production env file.
//
//   docker run -d --name mailer-local-redis --restart unless-stopped \
//     -p 127.0.0.1:6390:6379 -v mailer-local-redis:/data redis:7-alpine redis-server --appendonly yes
//
// The Upstash variables in the env file are ignored: KV_REST_API_URL points at
// test/upstash-shim.mjs, which speaks Upstash's REST API to that Redis.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startShim } from '../test/upstash-shim.mjs';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
export const flag = (name) => process.argv.includes(`--${name}`);

// vercel env pull writes KEY="value" with escapes; several values end in \r\n.
export function loadEnv(file) {
  if (!existsSync(file)) throw new Error(`no env file at ${file}`);
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\([nrt"\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' }[c] || c));
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    process.env[m[1]] = v.trim();
  }
}

// Env file, then the local Redis in place of Upstash. Call before importing api/.
// --store firestore uses the Firestore backend instead (no Docker needed):
// the "mailer" database of the project in the --sa service account key.
export async function useLocal({ env = arg('env', join(root, '..', '.env.production.local')), redisPort = Number(arg('redis-port', 6390)) } = {}) {
  loadEnv(env);
  if (arg('store') === 'firestore') {
    Object.assign(process.env, { MAILER_STORE: 'firestore', FIRESTORE_DATABASE: arg('database', 'mailer'),
      FIREBASE_SERVICE_ACCOUNT: readFileSync(arg('sa', join(root, '..', 'firebase-sa.local.json')), 'utf8') });
    return null;
  }
  const token = 'local';
  const shim = await startShim({ redisPort, token });
  Object.assign(process.env, { KV_REST_API_URL: `http://127.0.0.1:${shim.port}`, KV_REST_API_TOKEN: token });
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_URL; delete process.env.REDIS_URL;
  return shim;
}

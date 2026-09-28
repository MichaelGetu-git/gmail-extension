// Local preview of the whole app: public/ plus every api/ function, against a
// throwaway redis-server and a fake SMTP transport (nothing is ever sent).
//
//   node test/dev-server.mjs        then open http://127.0.0.1:3100
//   admin password: dev
//
//   DEV_SEED=1       fill it with realistic sample data (test/seed-sample.mjs)
//   DEV_NO_ADMIN=1   run with ADMIN_PASSWORD unset (the sign-in screen's "not configured" state)
//   DEV_PORT=3101    listen elsewhere (redis gets DEV_PORT + 3800)
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startShim } from './upstash-shim.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DEV_PORT) || 3100;
const REDIS_PORT = PORT + 3800;
const redis = spawn('redis-server', ['--port', String(REDIS_PORT), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));
const shim = await startShim({ redisPort: REDIS_PORT, token: 'dev' });
Object.assign(process.env, { KV_REST_API_URL: `http://127.0.0.1:${shim.port}`, KV_REST_API_TOKEN: 'dev',
  ADMIN_PASSWORD: 'dev', TEAM_KEY: 'dev-team', CRON_SECRET: 'dev-cron', GMAIL_APP_PASSWORD_DANIELLZELALEM: 'not-a-real-password' });
if (process.env.DEV_NO_ADMIN) delete process.env.ADMIN_PASSWORD;
if (process.env.DEV_SEED) Object.assign(process.env, { GMAIL_APP_PASSWORD_BROOKKDANIELL: 'not-a-real-password', GMAIL_APP_PASSWORD_BERRYYDANIEL: 'not-a-real-password' });
const { setTransportFactory } = await import('../api/_smtp.js');
setTransportFactory(() => ({ async sendMail(m) { console.log('[fake smtp]', m.to, m.subject); return { messageId: `<dev-${Date.now()}@local>`, response: '250 fake' }; }, close() {} }));
const { setImapFactory } = await import('../api/_imap.js');
setImapFactory(() => ({ async connect() {}, async logout() {}, async getMailboxLock() { return { release() {} }; }, async search() { return []; }, async *fetch() {}, async fetchOne() { return null; } }));

if (process.env.DEV_SEED) { const { seed } = await import('./seed-sample.mjs'); console.log('seeded', await seed()); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice(5).replace(/\/$/, '');
    const file = join(root, 'api', `${name}.js`);
    if (name.startsWith('_') || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    let body = '';
    for await (const c of req) body += c;
    const r = { query: Object.fromEntries(url.searchParams), method: req.method, headers: req.headers,
      body: /json/.test(req.headers['content-type'] || '') && body ? JSON.parse(body) : body };
    res.status = (c) => { res.statusCode = c; return res; };
    try { await (await import(file)).default(r, res); } catch (e) { console.error(e); res.statusCode = 500; res.end(String(e)); }
    return;
  }
  const p = join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!p.startsWith(join(root, 'public')) || !existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
}).listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${PORT}  (admin password: ${process.env.ADMIN_PASSWORD ? 'dev' : 'NOT SET'})`));
process.on('SIGINT', () => { redis.kill(); process.exit(0); });
process.on('SIGTERM', () => { redis.kill(); process.exit(0); });

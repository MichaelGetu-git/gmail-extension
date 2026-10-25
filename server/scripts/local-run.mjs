// The whole server on this machine: the dashboard and API on 127.0.0.1, and a
// tick every minute in place of cron-job.org. Real SMTP and IMAP with the app
// passwords from the env file; state in the local Redis (see _local.mjs).
//
//   node scripts/local-run.mjs [--port 3200] [--no-tick] [--env ../.env.production.local]
//
// Sending still follows the dashboard's settings: nothing goes out while the
// global pause is on. The admin password is ADMIN_PASSWORD from the env file.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { useLocal, root, arg, flag } from './_local.mjs';

// A long-running process on a laptop: a dropped connection somewhere (mail
// server, Redis) must not end it. Log it; the next tick carries on.
const stamp = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(11, 19);
process.on('uncaughtException', (e) => console.log(`${stamp()} EAT uncaught: ${e?.stack || e}`));
process.on('unhandledRejection', (e) => console.log(`${stamp()} EAT unhandled rejection: ${e?.stack || e}`));

await useLocal();
const { tick } = await import('../api/_engine.js');

const PORT = Number(arg('port', 3200));
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml' };
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
    try { await (await import(pathToFileURL(file).href)).default(r, res); } catch (e) { console.error(e); res.statusCode = 500; res.end(String(e)); }
    return;
  }
  const p = join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!p.startsWith(join(root, 'public')) || !existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
}).listen(PORT, '127.0.0.1', () => console.log(`dashboard http://127.0.0.1:${PORT}  (admin password: ADMIN_PASSWORD from the env file)`));

// One tick a minute, never two at once (the engine also holds a Redis lock).
const clock = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(11, 19);
let running = false;
async function once() {
  if (running) return;
  running = true;
  try {
    const out = await tick({ now: Date.now() });
    const parts = [out.busy ? 'busy' : out.paused ? 'paused' : 'ok', ...(out.notes || [])];
    for (const r of out.results || []) parts.push(`${r.account}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
    if (out.scan) parts.push(`scanned ${out.scan.account || ''}`.trim());
    console.log(`${clock()} EAT tick ${parts.join(' | ')}`);
  } catch (e) { console.log(`${clock()} EAT tick failed: ${e.message}`); }
  running = false;
}
if (!flag('no-tick')) { once(); setInterval(once, 60000); }

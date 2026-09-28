// GET|POST /api/tick — sends whatever is due. Hit it every minute or two
// during the sending hours from an external scheduler (see README).
//
// Protected by CRON_SECRET, sent as "Authorization: Bearer <CRON_SECRET>".
// Vercel Cron sends exactly that header by itself; QStash does with
// Upstash-Forward-Authorization; cron-job.org with a custom header.
// Without CRON_SECRET set it refuses everything.
//
// Safe to call as often as you like and concurrently: one tick runs at a time
// (Redis lock), each account sends at most one email per tick, and nothing is
// ever sent twice. While the global pause is on (the default) it sends nothing.
import { timingSafeEqual } from 'node:crypto';
import { configured } from './_store.js';
import { send } from './_auth.js';
import { tick } from './_engine.js';

function authorised(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const h = String(req.headers.authorization || '');
  const given = h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-cron-secret'] || '');
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (!configured) return send(res, 503, { error: 'no database connected' });
  if (!process.env.CRON_SECRET) return send(res, 503, { error: 'CRON_SECRET is not set' });
  if (!authorised(req)) return send(res, 401, { error: 'not authorised' });
  try {
    const out = await tick({ now: Date.now() });
    return send(res, 200, out);
  } catch (err) {
    return send(res, 500, { error: err.message || 'tick failed' });
  }
}

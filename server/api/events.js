// GET /api/events — every open and unsubscribe recorded, keyed by token.
//
// The extension pulls this and matches tokens to addresses locally. The
// response holds no names or addresses, but it is still the campaign's
// tracking data, so it needs a credential like the rest of the team API:
// the extension's built-in TEAM_KEY (x-team-key) or the admin password
// (x-admin-password). An old MAILER_KEY (x-mailer-key) still works if set.
// Anything else gets 401 and no data.
import { timingSafeEqual } from 'node:crypto';
import { command, configured, hashToObject, OPENS, UNSUB } from './_store.js';
import { isTeam, teamCors } from './_auth.js';

function same(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

export const canReadEvents = (req) =>
  isTeam(req) || same(req.headers['x-mailer-key'], process.env.MAILER_KEY);

export default async function handler(req, res) {
  teamCors(res);
  res.setHeader('access-control-allow-headers', 'content-type, x-team-key, x-admin-password, x-mailer-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');

  if (!canReadEvents(req)) {
    return res.status(401).end(JSON.stringify({ error: 'not authorised' }));
  }
  if (!configured) {
    return res.status(200).end(JSON.stringify({ configured: false, opens: {}, unsub: {} }));
  }

  try {
    const [opens, unsub] = await Promise.all([
      command('HGETALL', OPENS),
      command('HGETALL', UNSUB),
    ]);
    return res.status(200).end(JSON.stringify({
      configured: true,
      opens: hashToObject(opens),
      unsub: hashToObject(unsub, Number),
    }));
  } catch (err) {
    return res.status(500).end(JSON.stringify({ error: err.message || 'store error' }));
  }
}

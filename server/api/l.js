// GET /api/l?t=<token> — the footer logo, which is also the open tracker.
//
// A visible logo does the job a hidden 1px pixel used to: when the recipient's
// mail client loads it, that is the open. There is no invisible image in the
// email for a spam filter to flag.
//
// Always answers with the logo, even when the token is junk or the store is
// down: a missing logo is worse than a missed count.
//
// The logo goes out first and the open is written afterwards: waitUntil keeps
// the function alive until the store write settles, so the recipient never
// waits on the database. Keep this file's imports small — every one of them
// is paid for on a cold start, before the first byte of the logo.
import { waitUntil } from '@vercel/functions';
import { configured, isToken, noCache, recordOpen } from './_store.js';
import { LOGO_PNG } from './_logo.js';

// Never rejects: a failed write must not surface as an unhandled rejection.
const record = (t, ua) => Promise.resolve().then(() => recordOpen(t, ua)).catch(() => {});

export default function handler(req, res) {
  const t = String(req.query.t || '').toLowerCase();
  res.setHeader('content-type', 'image/png');
  res.setHeader('content-length', LOGO_PNG.length);
  noCache(res);
  res.status(200).end(LOGO_PNG);
  if (configured && isToken(t)) {
    waitUntil(record(t, req.headers['user-agent']));
  }
}

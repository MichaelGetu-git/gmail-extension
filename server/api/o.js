// GET /api/o?t=<token> — a 1px open-tracking image.
//
// Emails now carry the tracking in the logo (/api/l). This stays so mail
// already sent with the old pixel keeps reporting opens.
//
// Always answers with the GIF, even when the token is junk or the store is
// down: a broken image in someone's inbox is worse than a missed count.
import { configured, isToken, noCache, recordOpen } from './_store.js';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export default async function handler(req, res) {
  const t = String(req.query.t || '').toLowerCase();
  if (configured && isToken(t)) {
    try { await recordOpen(t, req.headers['user-agent']); } catch { /* serve the pixel regardless */ }
  }
  res.setHeader('content-type', 'image/gif');
  res.setHeader('content-length', GIF.length);
  noCache(res);
  res.status(200).end(GIF);
}

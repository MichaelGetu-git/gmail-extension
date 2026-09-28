// POST /api/report — the extension's latest campaign totals
// GET  /api/report — everyone's totals, summed, for the page at /
//
// Totals only: counts per day and per template, never a name or an address.
// The extension computes them from its own history, with the sender's own
// views already discounted, so this page shows the same numbers as the
// extension's dashboard.
//
// Each browser running the extension reports under its own random install id,
// so a team on several machines adds up instead of overwriting each other.
import { command, configured, cors } from './_store.js';

const REPORTS = 'mailer:reports';
const isInstall = (s) => /^[a-z0-9]{16,40}$/.test(String(s || ''));
const n = (v) => (Number.isFinite(+v) && +v >= 0 ? Math.min(Math.floor(+v), 1e7) : 0);
const SEGMENTS = ['callcenter', 'tech', 'va', 'other'];
const COUNTS = ['contacts', 'emails', 'tracked', 'opened', 'replied', 'bounced', 'unsubscribed'];

// Only known fields survive, as bounded integers, so nothing else can be
// smuggled onto a public page.
function clean(r) {
  // A timestamp, so not squeezed through n()'s cap like the counts are.
  const at = Math.floor(+r.at);
  const out = { at: Number.isFinite(at) && at > 0 ? at : 0 };
  for (const k of COUNTS) out[k] = n(r[k]);
  out.bySegment = {};
  for (const s of SEGMENTS) {
    const v = r.bySegment?.[s];
    if (v) out.bySegment[s] = { contacts: n(v.contacts), tracked: n(v.tracked), opened: n(v.opened), replied: n(v.replied) };
  }
  out.byDay = {};
  for (const [d, v] of Object.entries(r.byDay || {}).slice(-60)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out.byDay[d] = { sent: n(v.sent), opened: n(v.opened), replied: n(v.replied) };
  }
  out.via = {};
  for (const k of ['gmail', 'outlook', 'yahoo', 'other']) out.via[k] = n(r.via?.[k]);
  return out;
}

function sum(reports) {
  const t = clean({});
  for (const r of reports) {
    t.at = Math.max(t.at, r.at);
    for (const k of COUNTS) t[k] += r[k];
    for (const [s, v] of Object.entries(r.bySegment)) {
      const cur = (t.bySegment[s] ||= { contacts: 0, tracked: 0, opened: 0, replied: 0 });
      for (const k of Object.keys(cur)) cur[k] += v[k];
    }
    for (const [d, v] of Object.entries(r.byDay)) {
      const cur = (t.byDay[d] ||= { sent: 0, opened: 0, replied: 0 });
      for (const k of Object.keys(cur)) cur[k] += v[k];
    }
    for (const k of Object.keys(t.via)) t.via[k] += r.via[k];
  }
  return t;
}

export default async function handler(req, res) {
  cors(res);
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  if (!configured) return res.status(503).end(JSON.stringify({ error: 'no database connected' }));

  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (!isInstall(body.install)) return res.status(400).end(JSON.stringify({ error: 'bad install id' }));
      const r = clean({ ...body.report, at: Date.now() });
      await command('HSET', REPORTS, body.install, JSON.stringify(r));
      return res.status(200).end(JSON.stringify({ ok: true }));
    }
    // A browser that hasn't reported in two weeks has been uninstalled or
    // reset; its last totals would otherwise be counted forever.
    const fresh = Date.now() - 14 * 86400000;
    const flat = (await command('HGETALL', REPORTS)) || [];
    const reports = [];
    for (let i = 0; i < flat.length; i += 2) {
      try {
        const r = clean(JSON.parse(flat[i + 1]));
        if (r.at >= fresh) reports.push(r);
      } catch { /* skip a corrupt row */ }
    }
    return res.status(200).end(JSON.stringify({ ...sum(reports), sources: reports.length }));
  } catch (err) {
    return res.status(500).end(JSON.stringify({ error: err.message || 'store error' }));
  }
}

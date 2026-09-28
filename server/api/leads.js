// The shared queue of verified leads.
//
//   GET  /api/leads                    how many are waiting (team)
//   POST /api/leads  {upload: [...]}   the morning picker adds verified leads (team)
//   POST /api/leads  {claim: n, account}  a salesperson takes up to n (team)
//   POST /api/leads  {contacted: [...]}   the extension's history, for server-side suppression (team)
//   GET  /api/leads?contacted=1           addresses the server has emailed, for the extension (team)
//
// A claim pops leads off the queue in one Redis command, so two people clicking
// at the same moment can never get the same lead: the same business receiving
// the same pitch from two salespeople is worse than it receiving none.
//
// Claims are also counted per account per day and capped at the daily limit,
// so clicking again doesn't hand out more than the limit allows.
import { command, configured } from './_store.js';
import { body, isTeam, send, teamCors } from './_auth.js';
import { readConfig } from './config.js';

const QUEUE = 'mailer:leads:queue';
const CLAIMED = 'mailer:leads:claimed';   // email → {by, at}
const FIELDS = ['email', 'company', 'segment', 'vertical', 'business_type', 'pain', 'hours_gap',
  'city', 'country', 'website', 'phone'];

const today = () => new Date().toISOString().slice(0, 10);
const cleanLead = (l) => Object.fromEntries(FIELDS.map((f) => [f, String(l?.[f] ?? '').slice(0, 400)]));

export default async function handler(req, res) {
  teamCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!configured) return send(res, 503, { error: 'no database connected' });
  if (!isTeam(req)) return send(res, 401, { error: 'not authorised' });

  try {
    if (req.method === 'GET') {
      // The extension pulls who the server has emailed, so it never emails
      // them itself (see serverContacted in background.js/content.js).
      if (req.query?.contacted) {
        return send(res, 200, { contacted: (await command('HKEYS', 'mailer:srv:sent')) || [] });
      }
      return send(res, 200, { queued: Number(await command('LLEN', QUEUE)) || 0 });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const b = body(req);

    // The extension pushes every address in its history and do-not-email list,
    // so the server's sending never reaches anyone the extension already did.
    if (Array.isArray(b.contacted)) {
      const emails = [...new Set(b.contacted.map((e) => String(e || '').trim().toLowerCase())
        .filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e) && e.length <= 254))].slice(0, 20000);
      let added = 0;
      for (let i = 0; i < emails.length; i += 1000) {
        added += Number(await command('SADD', 'mailer:ext:contacted', ...emails.slice(i, i + 1000))) || 0;
      }
      return send(res, 200, { received: emails.length, added });
    }

    if (Array.isArray(b.upload)) {
      // Never queue someone who is already waiting or was handed out before.
      const already = new Set((await command('HKEYS', CLAIMED)) || []);
      const queued = ((await command('LRANGE', QUEUE, 0, -1)) || []).map((j) => { try { return JSON.parse(j).email; } catch { return ''; } });
      for (const e of queued) already.add(e);
      const fresh = b.upload.map(cleanLead)
        .filter((l) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(l.email) && !already.has(l.email.toLowerCase()))
        .slice(0, 500);
      if (fresh.length) await command('RPUSH', QUEUE, ...fresh.map((l) => JSON.stringify(l)));
      return send(res, 200, { added: fresh.length, skipped: b.upload.length - fresh.length });
    }

    if (b.claim !== undefined) {
      const account = String(b.account || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(account)) return send(res, 400, { error: 'which account is claiming?' });
      const config = await readConfig();
      const dayKey = `mailer:claims:${today()}`;
      const used = Number(await command('HGET', dayKey, account)) || 0;
      const want = Math.min(Math.max(0, Math.floor(Number(b.claim) || 0)), config.dailyLimit - used);
      if (want <= 0) return send(res, 200, { leads: [], used, limit: config.dailyLimit, message: 'daily limit reached' });

      const popped = (await command('LPOP', QUEUE, want)) || [];
      const leads = [].concat(popped).map((j) => { try { return JSON.parse(j); } catch { return null; } }).filter(Boolean);
      if (leads.length) {
        const at = Date.now();
        await command('HSET', CLAIMED, ...leads.flatMap((l) => [l.email.toLowerCase(), JSON.stringify({ by: account, at })]));
        await command('HINCRBY', dayKey, account, leads.length);
        await command('EXPIRE', dayKey, 3 * 86400);
      }
      return send(res, 200, { leads, used: used + leads.length, limit: config.dailyLimit });
    }

    return send(res, 400, { error: 'expected upload or claim' });
  } catch (err) {
    return send(res, 500, { error: err.message || 'store error' });
  }
}

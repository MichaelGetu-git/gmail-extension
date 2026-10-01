// Aggregates for the dashboard's charts, computed from what the server itself
// sent (mailer:srv:sent), the open/unsubscribe hashes and the send log.
// The extension's own campaign totals come from GET /api/report and are merged
// in the browser; this file never sees those.
//
// Only counts leave here: no addresses, names or bodies.
import { command } from './_store.js';
import { K, DAY, eatDate, addDays } from './_settings.js';
import { readConfig } from './config.js';
import { followUpsDue, accountsOf } from './_engine.js';

const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
// The extension reports these four offers; server template ids fold into them.
export const segmentOf = (t) => (t === 'callcenter-generic' ? 'callcenter' : ['callcenter', 'tech', 'va'].includes(t) ? t : 'other');

async function scanHash(key, count = 500) {
  const out = [];
  let cursor = '0';
  for (let guard = 0; guard < 400; guard++) {
    const [next, flat] = await command('HSCAN', key, cursor, 'COUNT', count);
    for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]);
    cursor = String(next);
    if (cursor === '0') break;
  }
  return out;
}

async function lookup(hash, fields, map) {
  for (let i = 0; i < fields.length; i += 300) {
    const chunk = fields.slice(i, i + 300);
    const vals = (await command('HMGET', hash, ...chunk)) || [];
    chunk.forEach((f, j) => { if (vals[j]) map.set(f, vals[j]); });
  }
  return map;
}

export async function analytics(now = Date.now(), { days = 30, logDays = 14 } = {}) {
  const config = await readConfig();
  const recs = (await scanHash(K.sent)).map(([, v]) => parse(v)).filter((r) => r && Array.isArray(r.touches) && r.touches.length);
  const tokens = recs.flatMap((r) => r.touches.map((t) => t.t)).filter(Boolean);
  const opensRaw = await lookup('mailer:opens', tokens, new Map());
  const unsubRaw = await lookup('mailer:unsub', tokens, new Map());
  const firstOpen = new Map();
  for (const [t, v] of opensRaw) {
    const list = parse(v, []);
    const at = Array.isArray(list) ? Math.min(...list.map((x) => Number(Array.isArray(x) ? x[0] : x)).filter(Number.isFinite)) : NaN;
    firstOpen.set(t, Number.isFinite(at) ? at : now);
  }

  const today = eatDate(now);
  const dayKeys = Array.from({ length: days }, (_, i) => addDays(today, i - days + 1));
  const inRange = new Set(dayKeys);
  const perDay = Object.fromEntries(dayKeys.map((d) => [d, { sent: 0, opened: 0, replied: 0, bounced: 0, unsubscribed: 0 }]));
  const onDay = (at, k) => { const d = eatDate(at); if (inRange.has(d)) perDay[d][k]++; };
  const byAccount = {}, bySegment = {}, accounts = {}, templates = {}, segments = {};
  // trackedContacts / trackedEmails leave out plain-text sends, which carry no
  // open pixel, so open rates are computed over mail that could register one.
  // autoReplied: out-of-office answers, kept out of the reply rate.
  const totals = { contacts: 0, emails: 0, opened: 0, openedContacts: 0, replied: 0, autoReplied: 0, bounced: 0, unsubscribed: 0, trackedContacts: 0, trackedEmails: 0, plainEmails: 0 };
  const pipe = { touch: {}, replied: 0, bounced: 0, unsubscribed: 0, finished: 0 };
  // Personalised (first email carried the contact's own subject/opening line)
  // vs standard, per contact. 'same period' = standard contacts first emailed
  // on or after the first personalised email, the fairer comparison.
  const pzBlank = () => ({ contacts: 0, emails: 0, tracked: 0, opened: 0, replied: 0, autoReplied: 0, bounced: 0 });
  const pz = { personal: pzBlank(), standard: pzBlank(), standardSamePeriod: pzBlank(), since: null };
  for (const r of recs) if (r.touches[0]?.personal) pz.since = Math.min(pz.since ?? Infinity, r.touches[0].at);
  const tplKey = (t, r) => `${t.template || r.template}|${t.v ?? ''}`;

  for (const r of recs) {
    totals.contacts++;
    const acc = (accounts[r.account] ||= { daily: {}, contacts: 0, sent: 0, opened: 0, replied: 0, bounced: 0, unsubscribed: 0 });
    acc.contacts++;
    const seg = segmentOf(r.template);
    const sg = (segments[seg] ||= { contacts: 0, sent: 0, opened: 0, replied: 0, bounced: 0 });
    sg.contacts++;
    let anyOpen = false, unsubAt = r.unsubscribedAt || null;
    if (r.touches.some((t) => !t.plain)) totals.trackedContacts++;
    for (const t of r.touches) {
      const d = eatDate(t.at);
      const opAt = firstOpen.get(t.t);
      totals.emails++; acc.sent++; sg.sent++;
      if (t.plain) totals.plainEmails++; else totals.trackedEmails++;
      if (opAt) { totals.opened++; anyOpen = true; onDay(opAt, 'opened'); }
      if (!unsubAt && unsubRaw.get(t.t)) unsubAt = Number(unsubRaw.get(t.t)) || now;
      if (inRange.has(d)) {
        perDay[d].sent++;
        bump((byAccount[d] ||= {}), r.account);
        bump((bySegment[d] ||= {}), t.template || r.template);
        bump(acc.daily, d);
      }
      const tp = (templates[tplKey(t, r)] ||= { template: t.template || r.template, version: t.v ?? null, sent: 0, tracked: 0, opened: 0, replied: 0, bounced: 0 });
      tp.sent++;
      if (!t.plain) tp.tracked++;
      if (opAt) tp.opened++;
    }
    // A reply or bounce belongs to the last email sent before it.
    const credit = (at, k) => {
      const before = r.touches.filter((t) => t.at <= at);
      const t = before[before.length - 1] || r.touches[0];
      templates[tplKey(t, r)][k]++;
    };
    if (anyOpen) { totals.openedContacts++; acc.opened++; sg.opened++; }
    const groups = r.touches[0]?.personal ? [pz.personal] : [pz.standard, ...(pz.since != null && r.touches[0].at >= pz.since ? [pz.standardSamePeriod] : [])];
    for (const g of groups) {
      g.contacts++; g.emails += r.touches.length;
      if (r.touches.some((t) => !t.plain)) g.tracked++;
      if (anyOpen) g.opened++;
      if (r.repliedAt) g.replied++; else if (r.autoReplyAt) g.autoReplied++;
      if (r.bouncedAt) g.bounced++;
    }
    if (r.repliedAt) { totals.replied++; acc.replied++; sg.replied++; credit(r.repliedAt, 'replied'); onDay(r.repliedAt, 'replied'); }
    else if (r.autoReplyAt) totals.autoReplied++;
    if (r.bouncedAt) { totals.bounced++; acc.bounced++; sg.bounced++; credit(r.bouncedAt, 'bounced'); onDay(r.bouncedAt, 'bounced'); }
    if (unsubAt) { totals.unsubscribed++; acc.unsubscribed++; onDay(unsubAt, 'unsubscribed'); }
    if (r.repliedAt) pipe.replied++;
    else if (r.bouncedAt) pipe.bounced++;
    else if (unsubAt) pipe.unsubscribed++;
    else if (r.touches.length >= config.maxTouches) pipe.finished++;
    else bump(pipe.touch, r.touches.length);
  }

  const due = await followUpsDue(now, 7);
  const dueByDay = {};
  for (const x of due) bump(dueByDay, x.sendDate || (x.dueDate < today ? today : x.dueDate));

  // Send-log activity by day and status.
  const logFrom = now - logDays * DAY;
  const logByDay = {};
  for (let start = 0; start < 3100; start += 500) {
    const chunk = (await command('LRANGE', K.log, start, start + 499)) || [];
    let older = false;
    for (const j of chunk) {
      const e = parse(j);
      if (!e?.at) continue;
      if (e.at < logFrom) { older = true; continue; }
      bump((logByDay[eatDate(e.at)] ||= {}), e.status || 'other');
    }
    if (older || chunk.length < 500) break;
  }

  const order = [...new Set([...accountsOf(config), ...Object.keys(accounts)])];
  return {
    now, today, days: dayKeys, configVersion: config.version || 0, maxTouches: config.maxTouches, followUpDays: config.followUpDays,
    totals, perDay, byAccount, bySegment, personalisation: pz,
    accounts: order.map((a) => ({ account: a, ...(accounts[a] || { daily: {}, contacts: 0, sent: 0, opened: 0, replied: 0, bounced: 0, unsubscribed: 0 }) })),
    segments,
    templates: Object.values(templates).sort((a, b) => a.template.localeCompare(b.template) || (b.version ?? -1) - (a.version ?? -1)),
    pipeline: { ...pipe, dueThisWeek: due.length, dueByDay },
    logByDay,
  };
}

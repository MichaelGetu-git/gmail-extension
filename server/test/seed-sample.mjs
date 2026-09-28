// Realistic sample data for the local dev server (DEV_SEED=1). Local only:
// writes to the throwaway redis the dev server starts, never to Upstash.
// Shapes mirror what the engine writes (recordSend, addLog, report.js).
import { command, pipeline } from '../api/_store.js';
import { K, DAY, eatDate, eatAt, eatWeekday, nextWeekday, patchAccountState } from '../api/_settings.js';
import { readConfig, cleanConfig, saveConfig } from '../api/config.js';
import { uploadContacts, ensurePlan, readPlan, setRandom } from '../api/_engine.js';

function mulberry(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry(20260925);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const tok = () => Array.from({ length: 16 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rnd() * 36)]).join('');
const SENDING = ['daniellzelalem@gmail.com', 'brookkdaniell@gmail.com', 'berryydaniel@gmail.com'];
const TEMPLATES = [['callcenter', 0.42], ['callcenter-generic', 0.12], ['tech', 0.22], ['va', 0.24]];
const tplPick = () => { let r = rnd(); for (const [t, p] of TEMPLATES) { if ((r -= p) < 0) return t; } return 'callcenter'; };
const OPEN_P = { callcenter: 0.52, 'callcenter-generic': 0.38, tech: 0.44, va: 0.47, followup: 0.33 };
const REPLY_P = { callcenter: 0.05, 'callcenter-generic': 0.02, tech: 0.035, va: 0.04, followup: 0.03 };
const COMPANIES = ['Harbour Dental', 'Northside Physio', 'Brightpath Legal', 'Keel Accounting', 'Oakline Estates', 'Pixel Forge', 'Summit Vets', 'Cedar Clinic', 'Riverbank Hotel', 'Lumen Studio', 'Atlas Plumbing', 'Nova Software'];
const FIRST = ['Amy', 'Ben', 'Chloe', 'Dan', 'Ella', 'Finn', 'Grace', 'Hugo', 'Isla', 'Jack', 'Kate', 'Liam', 'Maya', 'Noah', 'Olive', 'Paul'];

export async function seed(now = Date.now()) {
  setRandom(mulberry(7));
  const today = eatDate(now);
  // three saved template versions, so history and per-version stats exist
  let prev = await readConfig();
  const names = { 'daniellzelalem@gmail.com': 'Daniel', 'brookkdaniell@gmail.com': 'Brook', 'berryydaniel@gmail.com': 'Berry', 'noahadanial@gmail.com': 'Noah' };
  for (const [i, patch] of [{}, { tech: { subject: '{{company}}: senior devs, no recruiter fee?' } }, { callcenter: { subject: "{{company}}, who's picking up when you're {{hours_gap}}?" } }].entries()) {
    const templates = JSON.parse(JSON.stringify(prev.templates));
    for (const [k, v] of Object.entries(patch)) templates[k] = { ...templates[k], ...v };
    const next = cleanConfig({ ...prev, templates, senders: names }, prev);
    next.updatedAt = now - (20 - i * 8) * DAY;
    await saveConfig(next, prev);
    prev = next;
  }
  const versionAt = (at) => (at < now - 12 * DAY ? 1 : at < now - 4 * DAY ? 2 : 3);

  const sent = new Map(), log = [], opens = [], unsub = [];
  const touch = (rec, at, template, n) => {
    const t = tok();
    const personal = n === 1 && at > now - 9 * DAY && rnd() < 0.5;
    const tp = { at, n, t, template, followUp: n > 1, messageId: `<${t}@seed>`, logId: `${at.toString(36)}${t.slice(0, 6)}`, v: versionAt(at), ...(personal ? { personal: true } : {}) };
    rec.touches.push(tp); rec.lastSentAt = at;
    const subj = template === 'followup' ? `still thinking it over, ${rec.company}?` : personal ? `${rec.row.first_name}, loved the ${rec.company} story` : `${rec.company}: a quick question`;
    log.push({ id: tp.logId, at, account: rec.account, to: rec.email, templateId: template, subject: subj, status: 'sent', messageId: tp.messageId, ...(personal ? { personal: true } : {}),
      response: '250 2.0.0 OK (sample)', touch: n, followUp: n > 1, token: t, configVersion: tp.v,
      body: { subject: subj, text: `Hi ${rec.company} team,\n\n(sample body)\n\nDaniel\nZemenay`, html: `<p>Hi ${rec.company} team,</p><p>(sample body)</p><p>Daniel<br>Zemenay</p>`, from: rec.account } });
    if (rnd() < OPEN_P[template] && at < now - 3600000) opens.push([t, Math.min(now - 60000, at + Math.floor(rnd() * 30 * 3600000))]);
    return tp;
  };
  // history: the last 26 days (weekdays), before today
  let seq = 0;
  for (let back = 26; back >= 1; back--) {
    const d = eatDate(now - back * DAY);
    if (![1, 2, 3, 4, 5].includes(eatWeekday(d))) continue;
    const ramp = Math.min(1, (27 - back) / 14);
    for (const account of SENDING) {
      const n = Math.round((6 + rnd() * 9) * ramp);
      let at = eatAt(d, 9 * 60 + Math.floor(rnd() * 150));
      for (let i = 0; i < n; i++) {
        const template = tplPick(), company = `${pick(COMPANIES)} ${++seq}`;
        const email = `${pick(FIRST).toLowerCase()}.${seq}@${company.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`;
        const rec = { email, account, company, row: { email, company, first_name: pick(FIRST) }, template, firstSentAt: at, touches: [], repliedAt: null, bouncedAt: null, unsubscribedAt: null };
        touch(rec, at, template, 1);
        sent.set(email, rec);
        at += (3 + Math.floor(rnd() * 6)) * 60000;
      }
    }
  }
  // outcomes and follow-ups
  for (const rec of sent.values()) {
    const first = rec.touches[0];
    if (rnd() < 0.022) { rec.bouncedAt = first.at + 4 * 60000; rec.bounceReason = '550 5.1.1 The email account that you tried to reach does not exist'; log.push({ id: `b${first.logId}`, at: rec.bouncedAt, account: rec.account, to: rec.email, status: 'bounced', error: rec.bounceReason, templateId: rec.template }); continue; }
    for (let n = 2; n <= 3; n++) {
      const last = rec.touches[rec.touches.length - 1];
      if (rnd() < REPLY_P[last.template] * 1.2) { rec.repliedAt = Math.min(now - 60000, last.at + Math.floor((0.5 + rnd() * 2.5) * DAY)); break; }
      const due = last.at + 7 * DAY;
      if (due > now - 2 * 3600000 || eatDate(due) === today) break;
      const d = eatDate(due);
      const at = eatAt([6, 0].includes(eatWeekday(d)) ? nextWeekday(d, [1, 2, 3, 4, 5]) : d, 9 * 60 + Math.floor(rnd() * 180));
      if (at > now - 3600000 || eatDate(at) === today) break;
      touch(rec, at, 'followup', n);
    }
    if (rec.repliedAt) log.push({ id: `r${first.logId}`, at: rec.repliedAt, account: rec.account, to: rec.email, status: 'replied', subject: `Re: ${rec.company}`, templateId: rec.template });
    else if (rnd() < 0.012) { const t = rec.touches[rec.touches.length - 1]; rec.unsubscribedAt = t.at + DAY / 2; unsub.push([t.t, rec.unsubscribedAt]); }
  }
  // a few skips and deferrals for the log
  for (let i = 0; i < 9; i++) {
    const at = now - Math.floor(rnd() * 12) * DAY - 3 * 3600000;
    log.push({ id: `s${i}${tok().slice(0, 5)}`, at, account: pick(SENDING), to: `someone${i}@sample.example`, templateId: tplPick(),
      status: i % 3 ? 'skipped' : 'deferred', reason: i % 3 ? 'contacted before (bundled list)' : 'daily cap reached' });
  }

  // write it all
  const cmds = [];
  for (const rec of sent.values()) {
    cmds.push(['HSET', K.sent, rec.email, JSON.stringify(rec)], ['ZADD', K.byAcct(rec.account), rec.lastSentAt, rec.email]);
    for (const t of rec.touches) cmds.push(['HSET', K.tokens, t.t, rec.email]);
    if (!rec.repliedAt && !rec.bouncedAt && !rec.unsubscribedAt && rec.touches.length < 3) cmds.push(['ZADD', K.fu, rec.lastSentAt, rec.email]);
    if (rec.unsubscribedAt) cmds.push(['SADD', K.optout, rec.email]);
  }
  for (const a of SENDING) {
    const recent = [...sent.values()].filter((r) => r.account === a).sort((x, y) => y.lastSentAt - x.lastSentAt).slice(0, 50).map((r) => r.email);
    if (recent.length) cmds.push(['RPUSH', K.recent(a), ...recent]);
    cmds.push(['SET', K.last(a), String(Math.max(...[...sent.values()].filter((r) => r.account === a).map((r) => r.lastSentAt)))]);
  }
  // the replies feed behind the "new replies" badge: the last two days' replies
  const feed = [...sent.values()].filter((r) => r.repliedAt > now - 2 * DAY).sort((x, y) => x.repliedAt - y.repliedAt)
    .map((r) => JSON.stringify({ email: r.email, at: r.repliedAt, account: r.account, subject: `Re: ${r.company}` }));
  if (feed.length) cmds.push(['LPUSH', K.replies, ...feed]);
  const newest = Math.max(0, ...[...sent.values()].map((r) => r.repliedAt || 0));
  if (newest) cmds.push(['SET', K.lastReply, String(newest)]);
  for (const [t, at] of opens) cmds.push(['HSET', 'mailer:opens', t, JSON.stringify([[at, pick(['gmail', 'gmail', 'outlook', 'other'])]])]);
  for (const [t, at] of unsub) cmds.push(['HSET', 'mailer:unsub', t, String(at)]);
  log.sort((a, b) => a.at - b.at);
  for (const e of log) {
    const { body, ...entry } = e;
    cmds.push(['LPUSH', K.log, JSON.stringify(entry)]);
    if (body) cmds.push(['HSET', K.logBody, entry.id, JSON.stringify(body)]);
  }
  for (let i = 0; i < cmds.length; i += 400) await pipeline(cmds.slice(i, i + 400));
  await command('SET', K.unsubSeen, String(unsub.length));

  // new contacts, then today's plan (built as of 08:00) and the next sending day's
  const HOOKS = ['Loved reading how {c} started as a family business and still answers every call personally.', 'Saw that {c} has been part of the neighbourhood for over 20 years; that kind of loyalty is rare.',
    'The client stories on the {c} site make it clear people come back to you for the personal touch.', 'Congrats on {c} opening a second location this year.'];
  const csv = ['email,company,first_name,vertical,hours_gap,email_status,subject_line,opening_line',
    ...Array.from({ length: 110 }, (_, i) => {
      const company = `${COMPANIES[i % 12]} Q${i}`, first = FIRST[i % 16];
      const pz = i % 4 !== 3 ? `"${first}, a question about ${company}","${HOOKS[i % 4].replace('{c}', company)}"` : ',';
      return `${first.toLowerCase()}.q${i}@queue${i}.example,${company},${first},${['dental', 'software agency', 'accounting', 'property', 'hotel', 'physiotherapy'][i % 6]},${i % 4 ? 'closed weekends' : ''},valid,${pz}`;
    }),
    'info@rolebox.example,Role Box,,dental,,valid,,'].join('\n');
  await uploadContacts(csv, { now: now - 2 * DAY });
  const todayIsWeekday = [1, 2, 3, 4, 5].includes(eatWeekday(today));
  let sentToday = {};
  if (todayIsWeekday) {
    await ensurePlan(today, { now: eatAt(today, 8 * 60) });
    const plan = await readPlan(today);
    const upd = [];
    for (const it of plan.items) {
      if (it.at > now) continue;
      if (!SENDING.includes(it.account)) { upd.push(['HSET', K.plan(today), it.id, JSON.stringify({ ...it, status: 'deferred', reason: 'no app password (GMAIL_APP_PASSWORD_NOAHADANIAL)' })]); continue; }
      const failed = rnd() < 0.05;
      upd.push(['HSET', K.plan(today), it.id, JSON.stringify({ ...it, status: failed ? 'skipped' : 'sent', reason: failed ? 'contacted before (extension history)' : undefined, attemptedAt: it.at })]);
      if (failed) continue;
      sentToday[it.account] = (sentToday[it.account] || 0) + 1;
      const t = tok();
      const existing = sent.get(it.email);
      const tp = { at: it.at, n: it.touch || 1, t, template: it.template, followUp: Boolean(it.followUp), messageId: `<${t}@seed>`, logId: `${it.at.toString(36)}${t.slice(0, 6)}`, v: 3 };
      const rec = existing
        ? { ...existing, touches: [...existing.touches, tp], lastSentAt: it.at }
        : { email: it.email, account: it.account, company: it.company, row: { email: it.email, company: it.company }, template: it.template, firstSentAt: it.at,
          touches: [tp], lastSentAt: it.at, repliedAt: null, bouncedAt: null, unsubscribedAt: null };
      upd.push(['HSET', K.sent, it.email, JSON.stringify(rec)], ['ZADD', K.byAcct(it.account), it.at, it.email], rec.touches.length < 3 ? ['ZADD', K.fu, it.at, it.email] : ['ZREM', K.fu, it.email], ['HSET', K.tokens, t, it.email],
        ['LPUSH', K.log, JSON.stringify({ id: tp.logId, at: it.at, account: it.account, to: it.email, templateId: it.template, subject: `${it.company}: a quick question`, status: 'sent', messageId: `<${t}@seed>`, response: '250 2.0.0 OK (sample)', touch: tp.n, followUp: tp.followUp, token: t, configVersion: 3 })],
        ['HSET', K.logBody, tp.logId, JSON.stringify({ subject: `${it.company}: a quick question`, text: `Hi ${it.company} team,\n\n(sample body)`, html: `<p>Hi ${it.company} team,</p><p>(sample body)</p>`, from: it.account })]);
      if (rnd() < 0.3) upd.push(['HSET', 'mailer:opens', t, JSON.stringify([[Math.min(now - 60000, it.at + 40 * 60000), 'gmail']])]);
    }
    if (upd.length) await pipeline(upd);
    for (const [a, n] of Object.entries(sentToday)) await command('HSET', K.count(today), a, n);
  }
  await ensurePlan(nextWeekday(today, [1, 2, 3, 4, 5]), { now });

  // the extension's own totals (what /api/report shows)
  const byDay = {};
  let emails = 0, opened = 0, replied = 0;
  for (let back = 29; back >= 0; back--) {
    const d = eatDate(now - back * DAY);
    if (![1, 2, 3, 4, 5].includes(eatWeekday(d)) || back > 22) continue;
    const s = Math.floor(rnd() * 5), o = Math.round(s * (0.3 + rnd() * 0.4)), r = rnd() < 0.15 ? 1 : 0;
    byDay[d] = { sent: s, opened: o, replied: Math.min(r, s) }; emails += s; opened += o; replied += Math.min(r, s);
  }
  await command('HSET', 'mailer:reports', 'sampleinstall0000001', JSON.stringify({ at: now, contacts: emails, emails, tracked: emails, opened, replied, bounced: 1, unsubscribed: 1,
    bySegment: { callcenter: { contacts: Math.round(emails * 0.5), tracked: Math.round(emails * 0.5), opened: Math.round(opened * 0.55), replied: Math.ceil(replied / 2) },
      tech: { contacts: Math.round(emails * 0.2), tracked: Math.round(emails * 0.2), opened: Math.round(opened * 0.2), replied: 0 },
      va: { contacts: emails - Math.round(emails * 0.5) - Math.round(emails * 0.2), tracked: emails - Math.round(emails * 0.5) - Math.round(emails * 0.2), opened: opened - Math.round(opened * 0.55) - Math.round(opened * 0.2), replied: Math.floor(replied / 2) } },
    byDay, via: { gmail: opened, outlook: 0, yahoo: 0, other: 0 } }));

  // account and server state
  for (const a of SENDING) await patchAccountState(a, { lastImapAt: now - 9 * 60000, lastImapOkAt: now - 9 * 60000, lastImapError: null });
  await command('SET', K.lastTick, String(now - 60000));
  await command('SADD', K.extContacted, ...Array.from({ length: 40 }, (_, i) => `ext${i}@history.example`));
  await command('SADD', K.suppEmails, ...Array.from({ length: 12 }, (_, i) => `imported${i}@list.example`));
  return { contacts: sent.size + Object.values(sentToday).reduce((a, b) => a + b, 0), log: log.length, opens: opens.length };
}

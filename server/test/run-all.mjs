// End-to-end tests for server-side sending, against a real redis-server behind
// an Upstash-compatible REST shim, with a fake SMTP transport (nodemailer's
// streamTransport, so real MIME is built) and a fake IMAP client. Nothing
// leaves this machine.
//
//   cd server && npm test        (needs redis-server on PATH)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';
import { startShim } from './upstash-shim.mjs';

const REDIS_PORT = 6390 + Math.floor(Math.random() * 500);
const redis = spawn('redis-server', ['--port', String(REDIS_PORT), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));
const shim = await startShim({ redisPort: REDIS_PORT, token: 'test-token' });

const FAKE_PW = { DANIELLZELALEM: 'fakepw-aaaa-1111', BROOKKDANIELL: 'fakepw-bbbb-2222', BERRYYDANIEL: 'fakepw-cccc-3333', NOAHADANIAL: 'fakepw-dddd-4444' };
Object.assign(process.env, {
  KV_REST_API_URL: `http://127.0.0.1:${shim.port}`, KV_REST_API_TOKEN: 'test-token',
  ADMIN_PASSWORD: 'admin-test-pw', TEAM_KEY: 'team-test-key', CRON_SECRET: 'cron-test-secret',
  ...Object.fromEntries(Object.entries(FAKE_PW).map(([k, v]) => [`GMAIL_APP_PASSWORD_${k}`, v])),
});

const { command } = await import('../api/_store.js');
const S = await import('../api/_settings.js');
const E = await import('../api/_engine.js');
const R = await import('../api/_render.js');
const SUP = await import('../api/_suppress.js');
const { setTransportFactory } = await import('../api/_smtp.js');
const { setImapFactory } = await import('../api/_imap.js');
const { SEED_EMAILS, SEED_DOMAINS } = await import('../api/_seed.js');
const { DEFAULT_TEMPLATES } = await import('../api/_defaults.js');
const handlers = {
  admin: (await import('../api/admin.js')).default, tick: (await import('../api/tick.js')).default,
  config: (await import('../api/config.js')).default, u: (await import('../api/u.js')).default,
  l: (await import('../api/l.js')).default, events: (await import('../api/events.js')).default,
  leads: (await import('../api/leads.js')).default,
};

// ------------------------------------------------------------ harness
let failures = 0, passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
};
const section = (t) => console.log(`\n${t}`);
function mulberry(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function res() { return { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, end(b) { this.body = b; return this; } }; }
async function call(h, { method = 'GET', headers = {}, query = {}, body } = {}) {
  const r = res();
  await h({ method, headers, query, body }, r);
  let json = null; try { json = JSON.parse(r.body); } catch { /* not json */ }
  return { status: r.statusCode, json, raw: r.body, headers: r.headers };
}
const admin = (action, extra = {}) => call(handlers.admin, { method: 'POST', headers: { 'x-admin-password': 'admin-test-pw' }, body: { action, ...extra } });

// Fake SMTP: real nodemailer message build, nothing sent.
const sim = { now: Date.now(), sent: [], behaviour: {} };
setTransportFactory((account) => {
  const inner = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  return {
    async sendMail(mail) {
      const b = sim.behaviour[account];
      if (b === 'auth') throw Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' });
      if (typeof b === 'function') { const r = b(mail); if (r) throw r; }
      const info = await inner.sendMail(mail);
      await new Promise((r) => setTimeout(r, 5));
      sim.sent.push({ account, to: mail.to, subject: mail.subject, at: sim.now, raw: info.message.toString(), mail });
      return { messageId: info.messageId, response: '250 2.0.0 OK (fake)', accepted: [mail.to], rejected: [] };
    },
    close() {},
  };
});

const ACCOUNTS = ['daniellzelalem@gmail.com', 'brookkdaniell@gmail.com', 'berryydaniel@gmail.com', 'noahadanial@gmail.com'];
const EAT = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+03:00`);
const clockOf = (ms) => S.eatClock(ms);
async function reset() {
  await shim.flush();
  sim.sent = []; sim.behaviour = {};
  // Every category on, so the sections below count sends as they always have;
  // the "categories switched off" section covers the default (Virtual assistants off).
  await command('SET', S.K.settings, JSON.stringify({ ...S.DEFAULT_SETTINGS, skipTemplates: [] }));
}
async function saveSettings(patch) {
  const r = await admin('settings.save', { settings: patch });
  if (r.status !== 200) throw new Error(`settings.save ${r.status} ${r.raw}`);
  return r.json.settings;
}
function makeCsv(n, { prefix = 'p', verticals = ['dental', 'software agency', 'accounting', 'plumbing', 'hotel', ''] } = {}) {
  const lines = ['email,company,first_name,last_name,vertical,hours_gap,email_status'];
  for (let i = 0; i < n; i++) {
    const v = verticals[i % verticals.length];
    lines.push(`${prefix}person${i}.smith@${prefix}co${i}.example,"${prefix.toUpperCase()} Co ${i}",Pat${i},Smith,${v},closed weekends,valid`);
  }
  return lines.join('\n');
}

// ============================================================ 1. parity with content.js
section('1. rendering is identical to the extension (content.js)');
{
  const src = readFileSync(new URL('../../content.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const SEGMENTS = ['), src.indexOf('// -------------------------------------------------------------------- Panel'));
  const footer = src.slice(src.indexOf('const TRACKER = '), src.indexOf('// Inserting through execCommand'));
  const esc = src.slice(src.indexOf('function escapeHtml'), src.indexOf('function setBody('));
  const fill = src.slice(src.indexOf('function fillTemplate'), src.indexOf('// ------------------------------------------------------------------ segments'));
  const parseCsvSrc = src.slice(src.indexOf('function parseCsv'), src.indexOf('function fillTemplate'));
  const ext = new Function('chrome', 'detectAccount', `${esc}\n${fill}\n${parseCsvSrc}\n${footer}\n${block}
    return { SEGMENTS, routeContact, withWording, fillTemplate, buildBodyHtml, renderFooter, parseCsv, DEFAULT_FOOTER, preflight };`)(
    { storage: { local: { get: (k, cb) => cb({}), set: (d, cb) => cb && cb() } } }, () => '');

  const extTemplates = Object.fromEntries(ext.SEGMENTS.map((s) => [s.id, { subject: s.subject, body: s.body }]));
  check('server default templates == content.js SEGMENTS', JSON.stringify(extTemplates) === JSON.stringify(DEFAULT_TEMPLATES));
  check('footer text identical', ext.DEFAULT_FOOTER === R.DEFAULT_FOOTER);
  check('segment matchers identical', ext.SEGMENTS.every((s, i) => String(s.match) === String(R.SEGMENTS[i].match) && s.id === R.SEGMENTS[i].id && s.label === R.SEGMENTS[i].label));

  const csvText = readFileSync(new URL('../../test-contacts.csv', import.meta.url), 'utf8') + '\n' + [
    'x@a.example,"Acme, <Ltd> & Sons",,,property & real estate,closed by 5pm,valid',
    'y@b.example,Beta Dev,,,software,,valid',
    'z@c.example,Gamma,,,hotel,open late,valid',
    'w@d.example,Delta,,,,,valid',
  ].map((l) => { const p = l.split(','); return l; }).join('\n');
  const extRows = ext.parseCsv(csvText).rows, srvRows = R.parseCsv(csvText).rows;
  check('parseCsv identical', JSON.stringify(extRows) === JSON.stringify(srvRows));
  const rows = [...srvRows,
    { email: 'a@x.example', company: 'Q&A <Clinic>', vertical: 'dental', hours_gap: 'closed Sundays', pain: 'Custom pain.' },
    { email: 'b@x.example', company: 'Techy', eng_roles: '3', vertical: 'legal' },
    { email: 'c@x.example', company: 'Help', support_roles: '1' },
    { email: 'd@x.example', company: 'Seg', segment: 'Virtual assistants' },
    { email: 'e@x.example', company: 'Gen', segment: 'callcenter-generic', business_type: 'a salon' },
    { email: 'f@x.example', company: 'Weird', vertical: 'zzz' },
  ];
  let same = 0;
  for (const row of rows) {
    const seg = ext.routeContact(row);
    const c = { ...row, _segment: seg };
    const tpl = extTemplates[seg];
    const worded = ext.withWording({ ...c, sender_name: 'Dawit' });
    const token = 'tok' + Math.random().toString(36).slice(2, 14);
    const e = { subject: ext.fillTemplate(tpl.subject, worded), body: ext.fillTemplate(tpl.body, worded) };
    e.html = ext.buildBodyHtml(e.body, c, token);
    const s = R.renderEmail({ contact: c, templates: DEFAULT_TEMPLATES, senderName: 'Dawit', token });
    if (seg === s.templateId && e.subject === s.subject && e.body === s.bodyText && e.html === s.html) same++;
    else console.log('    mismatch', row.email, seg, s.templateId);
  }
  check(`subject, body and HTML (logo token + unsubscribe) identical for ${rows.length} rows`, same === rows.length);
  // follow-up rendering, as the extension's follow-up queue builds its rows
  const fuRow = { email: 'f@x.example', company: 'Fu Co', name: '', vertical: 'dental', segment: 'followup', _segment: 'followup' };
  const w = ext.withWording({ ...fuRow, sender_name: '' });
  const fe = ext.fillTemplate(extTemplates.followup.body, w);
  const fs = R.renderEmail({ contact: { ...fuRow }, templates: DEFAULT_TEMPLATES, templateId: 'followup', senderName: '', token: 'abcabcabcabc' });
  check('follow-up body identical (unsigned -> "The Zemenay team")', fe === fs.bodyText && fs.bodyText.includes('The Zemenay team'));
  // {{nick_name}}: the nickname when set, else the name it signs with
  const nickTpl = { ...DEFAULT_TEMPLATES, tech: { subject: 'hi from {{nick_name}}', body: 'Hey, this is {{nick_name}}.\n\n{{sender_name}}' } };
  const nr = { email: 'n@x.example', company: 'Nick Co', segment: 'tech', _segment: 'tech' };
  const nickOf = (sender, nick) => ext.fillTemplate(nickTpl.tech.body, ext.withWording({ ...nr, sender_name: sender, nick_name: nick }));
  const srvNick = (senderName, nickName) => R.renderEmail({ contact: { ...nr }, templates: nickTpl, templateId: 'tech', senderName, nickName, token: 'nicknick00000001' }).bodyText;
  check('{{nick_name}} identical: the nickname, else the name, else "The Zemenay team"; {{sender_name}} is the name exactly as set', nickOf('Dawit @ ZemenayTech', 'Mike') === srvNick('Dawit @ ZemenayTech', 'Mike')
    && srvNick('Dawit @ ZemenayTech', 'Mike') === 'Hey, this is Mike.\n\nDawit @ ZemenayTech' && nickOf('Berry', '') === srvNick('Berry', '') && srvNick('Berry', '') === 'Hey, this is Berry.\n\nBerry'
    && nickOf('', '') === srvNick('', '') && srvNick('', '').startsWith('Hey, this is The Zemenay team.'));
  const tok = R.newToken();
  check('tokens match the tracker format', /^[a-z0-9]{16}$/.test(tok) && tok !== R.newToken());
}

// ============================================================ 2. routing
section('2. routing picks the right template (README rules)');
{
  const t = (row, want, name) => check(name, R.routeContact(row) === want, `got ${R.routeContact(row)}`);
  t({ vertical: 'property & real estate' }, 'callcenter', 'property -> callcenter');
  t({ vertical: 'dental' }, 'callcenter', 'dental -> callcenter');
  t({ vertical: 'finance & accounting' }, 'va', 'accounting -> va');
  t({ vertical: 'hospitality & travel' }, 'va', 'hotel -> va');
  t({ vertical: 'software agency' }, 'tech', 'software -> tech');
  t({ vertical: 'legal', eng_roles: '4' }, 'tech', 'eng_roles beat vertical');
  t({ vertical: 'other', support_roles: '2' }, 'va', 'support_roles -> va');
  t({ vertical: 'legal', segment: 'tech' }, 'tech', 'explicit segment column wins');
  t({ segment: 'callcenter-generic' }, 'callcenter-generic', 'explicit callcenter-generic');
  t({ vertical: 'zzz nonsense' }, 'callcenter', 'fallback callcenter');
  // content.js behaviour: no descriptive columns at all -> the /^$/ matcher of callcenter-generic
  t({}, 'callcenter-generic', 'row with no descriptive columns -> callcenter-generic (as content.js)');
}

// ============================================================ 3. suppression
section('3. suppression blocks contacted / unsubscribed / claimed addresses');
await reset();
{
  await command('SADD', 'mailer:srv:optout', 'optout.person@clean.example');
  await command('SADD', 'mailer:ext:contacted', 'ext.person@clean.example');
  await command('HSET', 'mailer:leads:claimed', 'claimed.person@clean.example', '{"by":"x"}');
  await command('HSET', 'leaddesk:state', 'desk.person@clean.example', '{"s":"taken"}');
  await command('SADD', 'mailer:srv:supp:emails', 'imported.person@clean.example');
  await command('SADD', 'mailer:srv:supp:domains', 'importeddomain.example');
  const nonFree = SEED_DOMAINS.find((d) => !SUP.FREEMAIL.has(d));
  const csv = ['email,company,first_name,email_status',
    `${SEED_EMAILS[0]},Seed,Ann,valid`,
    `jane.doe@${nonFree},SeedDomain,Jane,valid`,
    'info@clean.example,Role,,valid',
    'optout.person@clean.example,Opt,Olga,valid',
    'ext.person@clean.example,Ext,Ed,valid',
    'claimed.person@clean.example,Claimed,Cy,valid',
    'desk.person@clean.example,Desk,Di,valid',
    'imported.person@clean.example,Imp,Ivy,valid',
    'someone@importeddomain.example,ImpD,Sam,valid',
    'unverified.person@clean.example,Unv,Uma,unknown',
    'good.person@clean.example,Good,Gil,valid',
    'GOOD.person@clean.example,Dupe,Gil,valid',
    'new.gmailer@gmail.com,Free,Fay,valid',
    'not-an-email,Bad,,valid',
  ].join('\n');
  const r = await admin('contacts.upload', { csv });
  const sk = r.json.skipped;
  check('upload accepted only the 2 clean named addresses', r.json.added === 2, JSON.stringify(r.json));
  check('contacted-emails list (bundled seed) blocks', sk['on the contacted-emails list'] === 1);
  check('contacted-domains list (bundled seed) blocks', sk['domain on the contacted-domains list'] === 1);
  check('freemail domain (gmail.com is on the domains list) does not block a new gmail address', !sk['domain on the contacted-domains list'] || sk['domain on the contacted-domains list'] === 1);
  check('role address blocked', sk['role address, not a named person'] === 1);
  check('opt-out / unsubscribe blocks', sk['opted out / unsubscribed'] === 1);
  check('extension history blocks', sk['in the extension history'] === 1);
  check('extension-claimed lead blocks', sk['claimed through the extension'] === 1);
  check('Lead Desk state blocks', sk['taken on the Lead Desk'] === 1);
  check('imported list + imported domain block', sk['on the imported contacted list'] === 1 && sk['domain on the imported domains list'] === 1);
  check('email_status != valid skipped by default', sk['email_status is not "valid"'] === 1);
  check('duplicate in file skipped', sk['duplicate in this file'] === 1);
  check('invalid address skipped', sk['invalid address'] === 1);
  const again = await admin('contacts.upload', { csv: 'email,company,email_status\ngood.person@clean.example,Good,valid' });
  check('re-upload of a queued contact is refused', again.json.added === 0);
  const chk = await admin('supp.check', { email: SEED_EMAILS[1] });
  check('supp.check explains the reason', chk.json.firstEmail === 'on the contacted-emails list');
  const imp = await admin('supp.import', { emails: 'a1@x.example, a2@x.example', domains: ['zz.example'], optout: ['o@x.example'] });
  check('supp.import adds to Redis', imp.json.emails === 2 && imp.json.domains === 1 && imp.json.optout === 1);
}

// ============================================================ 4. schedule
section('4. schedule: random start 09:00-11:30 EAT, 3-8 min gaps, cap, weekdays only');
await reset();
{
  let ok = true, gapsOk = true, capOk = true, balanced = true, startMin = 1e9, startMax = 0, gMin = 1e9, gMax = 0;
  await admin('contacts.upload', { csv: makeCsv(3000, { prefix: 's' }) });
  const dates = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
  for (let k = 0; k < 40; k++) {
    E.setRandom(mulberry(1000 + k));
    const date = dates[k % dates.length];
    await command('DEL', S.K.plan(date));
    await command('SREM', S.K.plans, date);
    const cap = [15, 15, 40, 7][k % 4];
    await S.writeSettings(S.cleanSettings({ perAccountCap: cap }, await S.readSettings()));
    const plan = await E.buildPlan(date, EAT(date, '06:00'), await S.readSettings());
    const byA = {};
    for (const it of plan.items) (byA[it.account] ||= []).push(it);
    const sizes = Object.values(byA).map((l) => l.length);
    if (Math.max(...sizes) - Math.min(...sizes) > 1 || sizes.length !== 4) balanced = false;
    for (const list of Object.values(byA)) {
      list.sort((a, b) => a.at - b.at);
      if (list.length > cap) capOk = false;
      const st = list[0].at;
      startMin = Math.min(startMin, st - EAT(date, '00:00')); startMax = Math.max(startMax, st - EAT(date, '00:00'));
      if (st < EAT(date, '09:00') || st > EAT(date, '11:30')) ok = false;
      for (let i = 1; i < list.length; i++) {
        const g = (list[i].at - list[i - 1].at) / 60000;
        gMin = Math.min(gMin, g); gMax = Math.max(gMax, g);
        if (g < 3 || g > 8) gapsOk = false;
      }
    }
    // hand the contacts back so the next plan has a full queue
    await E.invalidatePlans(EAT(date, '06:00') - 86400000 * 3, { includeUntouchedToday: true });
  }
  const hm = (ms) => `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}`;
  check(`every account start within 09:00-11:30 EAT (observed ${hm(startMin)}-${hm(startMax)} over 40 plans)`, ok);
  check(`every gap within 3-8 min (observed ${gMin.toFixed(2)}-${gMax.toFixed(2)})`, gapsOk);
  check('never more than the per-account cap planned (caps 7/15/40)', capOk);
  check('new contacts balanced across the 4 accounts (max-min <= 1)', balanced);
  const sat = await E.buildPlan('2026-10-03', EAT('2026-10-03', '06:00'), await S.readSettings());
  check('Saturday gets no sends', sat.items.length === 0 && sat.meta.offDay === true);
  const capped = S.cleanSettings({ perAccountCap: 500, minGapMin: 9, maxGapMin: 2, windowStart: '11:00', windowEnd: '10:00' });
  check('settings are bounded (cap<=40, gaps ordered, window ordered)', capped.perAccountCap === 40 && capped.maxGapMin >= capped.minGapMin && S.toMin(capped.windowEnd) >= S.toMin(capped.windowStart));
  check('paused defaults to TRUE', S.DEFAULT_SETTINGS.paused === true && (await S.readSettings()).paused === true);
}

// ============================================================ 5. pause
section('5. pause blocks every send');
await reset();
{
  E.setRandom(mulberry(7));
  await admin('contacts.upload', { csv: makeCsv(80, { prefix: 'q' }) });
  const date = '2026-09-28';
  for (let t = EAT(date, '08:55'); t <= EAT(date, '18:00'); t += 60000) { sim.now = t; await E.tick({ now: t, scan: false }); }
  check('default (paused): zero emails across a whole simulated weekday', sim.sent.length === 0, `sent ${sim.sent.length}`);
  const t1 = await call(handlers.tick, { headers: { authorization: 'Bearer cron-test-secret' } });
  check('tick endpoint answers paused:true', t1.status === 200 && t1.json.paused === true);
  const ts = await admin('test.send', { account: ACCOUNTS[0], to: 'me@example.com', templateId: 'tech', dryRun: true });
  check('test send (dry-run) renders while paused, subject marked [TEST]', ts.status === 200 && ts.json.subject.startsWith('[TEST] '), ts.raw);
}

// ============================================================ 6. full day + cap + never twice
section('6. a real weekday: cap enforced, gaps kept, nobody twice');
await reset();
{
  E.setRandom(mulberry(42));
  const up = await admin('contacts.upload', { csv: makeCsv(200, { prefix: 'r' }) });
  await saveSettings({ paused: false, perAccountCap: 15 });
  const date = '2026-09-28';
  for (let t = EAT(date, '08:55'); t <= EAT(date, '18:00'); t += 60000) { sim.now = t; await E.tick({ now: t, scan: false }); }
  const per = {};
  for (const s of sim.sent) (per[s.account] ||= []).push(s);
  check(`60 emails sent (4 accounts x 15) of ${up.json.added} queued`, sim.sent.length === 60, `sent ${sim.sent.length}`);
  check('no account over its cap of 15', Object.values(per).every((l) => l.length <= 15));
  const tos = sim.sent.map((s) => s.to);
  check('no recipient emailed twice', new Set(tos).size === tos.length);
  let firstOk = true, gapOk = true, gmin = 99, gmax = 0;
  for (const l of Object.values(per)) {
    l.sort((a, b) => a.at - b.at);
    if (l[0].at < EAT(date, '09:00') || l[0].at > EAT(date, '11:31')) firstOk = false;
    for (let i = 1; i < l.length; i++) { const g = (l[i].at - l[i - 1].at) / 60000; gmin = Math.min(gmin, g); gmax = Math.max(gmax, g); if (g < 3 || g > 9) gapOk = false; }
  }
  check('each account started between 09:00 and 11:30 EAT (+1 min tick granularity)', firstOk);
  check(`actual gaps 3-8 min plus <1 min tick rounding (observed ${gmin}-${gmax})`, gapOk);
  const decode = (r) => r.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  const mimeBad = sim.sent.filter((m) => { const raw = decode(m.raw);
    return !(/api\/l\?t=[a-z0-9]{16}/.test(raw) && /api\/u\?t=[a-z0-9]{16}/.test(raw) && /List-Unsubscribe:\s*<https:\/\/mailer-tracker\.vercel\.app\/api\/u\?t=[a-z0-9]{16}>/.test(m.raw)); });
  if (mimeBad.length) (await import('node:fs')).writeFileSync('/tmp/bad.eml', mimeBad[0].raw);
  check(`real MIME of all ${sim.sent.length}: tracked logo, unsubscribe link, List-Unsubscribe header`, mimeBad.length === 0, `${mimeBad.length} bad`);
  const log = await admin('log.list', { status: 'sent', limit: 200 });
  check('every send is in the log with message id and template', log.json.items.length === 60 && log.json.items.every((e) => e.messageId && e.templateId && e.subject));
  const body = await admin('log.get', { id: log.json.items[0].id });
  check('full rendered email viewable from the log', body.json.body && body.json.body.html.includes('<img') && body.json.body.text.length > 100);
  const search = await admin('log.list', { q: sim.sent[3].to });
  check('log search by recipient', search.json.items.length === 1 && search.json.items[0].to === sim.sent[3].to);
  const tok = /api\/u\?t=([a-z0-9]{16})/.exec(sim.sent[5].raw)[1];
  check('token maps back to recipient (opens/unsubscribes register in mailer: keys)', (await command('HGET', S.K.tokens, tok)) === sim.sent[5].to);

  // hard cap even if the plan has more than the cap (cap lowered mid-day without replanning)
  const date2 = '2026-09-29';
  await E.ensurePlan(date2, { now: EAT(date2, '06:00') });
  await S.writeSettings({ ...(await S.readSettings()), perAccountCap: 2 });
  const before = sim.sent.length;
  for (let t = EAT(date2, '08:55'); t <= EAT(date2, '18:00'); t += 60000) { sim.now = t; await E.tick({ now: t, scan: false }); }
  const day2 = sim.sent.slice(before);
  const per2 = {}; for (const s of day2) per2[s.account] = (per2[s.account] || 0) + 1;
  check(`hard cap: plan had 15/account, cap lowered to 2 -> ${day2.length} sent (max 2 each)`, day2.length === 8 && Object.values(per2).every((n) => n <= 2));
  const plan2 = await E.readPlan(date2);
  check('over-cap items deferred with reason', plan2.items.filter((i) => i.reason === 'daily cap reached').length > 0);
  // next day those deferred contacts go back to the front of the queue
  await S.writeSettings({ ...(await S.readSettings()), perAccountCap: 15 });
  await E.ensurePlan('2026-09-30', { now: EAT('2026-09-30', '06:00') });
  const p3 = await E.readPlan('2026-09-30');
  const deferredEmails = new Set(plan2.items.filter((i) => i.status === 'deferred').map((i) => i.email));
  check('deferred contacts are replanned the next day', p3.items.filter((i) => deferredEmails.has(i.email)).length === Math.min(deferredEmails.size, 60));
}

// ============================================================ 7. concurrency
section('7. concurrent ticks never double-send');
await reset();
{
  E.setRandom(mulberry(99));
  await admin('contacts.upload', { csv: makeCsv(40, { prefix: 'c' }) });
  await saveSettings({ paused: false });
  const date = '2026-09-28';
  const plan = await E.ensurePlan(date, { now: EAT(date, '06:00') });
  // make every item due now
  const t = EAT(date, '12:00');
  for (const it of plan.items) { it.at = t - 60000; }
  await command('HSET', S.K.plan(date), ...plan.items.flatMap((it) => [it.id, JSON.stringify(it)]));
  sim.now = t;
  const results = await Promise.all(Array.from({ length: 25 }, () => E.tick({ now: t, scan: false })));
  const busy = results.filter((r) => r.busy).length;
  check(`25 simultaneous ticks: 1 ran, ${busy} bounced off the lock`, busy === 24, `busy=${busy}`);
  check('that tick sent at most one email per account', sim.sent.length <= 4 && new Set(sim.sent.map((s) => s.account)).size === sim.sent.length);
  // bypass the lock entirely: 10 parallel sendItem calls for the same item
  const item = (await E.readPlan(date)).items.find((i) => i.status === 'planned');
  const n0 = sim.sent.length;
  const rs = await Promise.all(Array.from({ length: 10 }, () => E.sendItem({ ...item }, { now: t + 1000, today: date })));
  const sentNow = sim.sent.slice(n0).filter((s) => s.to === item.email).length;
  check(`10 parallel sends of one item (no lock): exactly 1 email (${rs.map((r) => r.status).join(',')})`, sentNow === 1);
  const cnt = Number(await command('HGET', S.K.count(date), item.account));
  const acctSent = sim.sent.filter((s) => s.account === item.account).length;
  check('cap counter stays exact after the race', cnt === acctSent, `counter ${cnt} vs sent ${acctSent}`);
  // simulate a crash mid-send: item left "sending" is never retried
  const it2 = (await E.readPlan(date)).items.find((i) => i.status === 'planned' && i.account !== item.account);
  await command('HSET', S.K.plan(date), it2.id, JSON.stringify({ ...it2, status: 'sending' }));
  const n1 = sim.sent.length;
  for (let k = 0; k < 20; k++) { sim.now = t + 600000 * (k + 1); await E.tick({ now: t + 600000 * (k + 1), scan: false }); }
  check('an item interrupted mid-send is never retried', !sim.sent.slice(n1).some((s) => s.to === it2.email));
}

// ============================================================ 8. dry run
section('8. dry-run mode');
await reset();
{
  E.setRandom(mulberry(5));
  for (const k of Object.keys(FAKE_PW)) delete process.env[`GMAIL_APP_PASSWORD_${k}`];
  await admin('contacts.upload', { csv: makeCsv(20, { prefix: 'd' }) });
  await saveSettings({ paused: false, dryRun: true, perAccountCap: 3 });
  const date = '2026-09-28';
  for (let t = EAT(date, '08:55'); t <= EAT(date, '18:00'); t += 60000) { sim.now = t; await E.tick({ now: t, scan: false }); }
  const log = await admin('log.list', { status: 'dry-run', limit: 100 });
  check('dry-run renders and logs 12 emails without any SMTP transport or passwords', sim.sent.length === 0 && log.json.items.length === 12, `${sim.sent.length} / ${log.json.items.length}`);
  check('dry-run leaves no sent records or never-twice claims', Number(await command('HLEN', S.K.sent)) === 0 && Number(await command('HLEN', S.K.touch)) === 0);
  await E.ensurePlan('2026-09-29', { now: EAT('2026-09-29', '06:00') });
  check('dry-run contacts return to the queue for real sending later', Number(await command('LLEN', S.K.queue)) === 20 - 12 || (await E.readPlan('2026-09-29')).items.length === 12);
  Object.assign(process.env, Object.fromEntries(Object.entries(FAKE_PW).map(([k, v]) => [`GMAIL_APP_PASSWORD_${k}`, v])));
}

// ============================================================ 9. auto-pause
section('9. auto-pause on SMTP auth errors and bounce rate > 5%');
await reset();
{
  E.setRandom(mulberry(11));
  await admin('contacts.upload', { csv: makeCsv(60, { prefix: 'a' }) });
  await saveSettings({ paused: false, perAccountCap: 10 });
  sim.behaviour[ACCOUNTS[0]] = 'auth';
  let rcpt = 0;
  sim.behaviour[ACCOUNTS[1]] = () => (rcpt++ === 1 ? Object.assign(new Error('550 5.1.1 no such user'), { responseCode: 550, command: 'RCPT TO', response: '550 5.1.1 The email account that you tried to reach does not exist' }) : null);
  const date = '2026-09-28';
  for (let t = EAT(date, '08:55'); t <= EAT(date, '18:00'); t += 60000) { sim.now = t; await E.tick({ now: t, scan: false }); }
  const st = await S.readAccountStates();
  check('SMTP auth failure auto-pauses that account', st[ACCOUNTS[0]]?.paused && st[ACCOUNTS[0]]?.auto && /SMTP login failed/.test(st[ACCOUNTS[0]].reason));
  check('nothing was sent from the auth-failed account', !sim.sent.some((s) => s.account === ACCOUNTS[0]));
  check('its contact was not burnt (claim released)', Number(await command('HLEN', S.K.touch)) === sim.sent.length + 1);
  check('RCPT rejection recorded as bounce and auto-pauses at 1 of 2 (50% > 5%)', st[ACCOUNTS[1]]?.paused && /bounce rate/.test(st[ACCOUNTS[1]].reason), JSON.stringify(st[ACCOUNTS[1]]));
  check('other accounts carried on', sim.sent.filter((s) => s.account === ACCOUNTS[2]).length === 10);
  const ov = await admin('overview');
  const h = ov.json.accounts.find((a) => a.account === ACCOUNTS[1]);
  check('health shows sends, bounces and auto-pause reason', h.sent7d === 2 && h.bounced7d === 1 && h.autoPaused);
  const resume = await admin('account.resume', { account: ACCOUNTS[0] });
  check('admin can resume an auto-paused account', resume.json.state.paused === false);
}

// ============================================================ 10. follow-ups, replies, bounces, unsubscribes
section('10. follow-ups skip replies, bounces and unsubscribes; count toward the cap');
await reset();
{
  E.setRandom(mulberry(21));
  await admin('contacts.upload', { csv: makeCsv(8, { prefix: 'f' }) });
  await saveSettings({ paused: false, perAccountCap: 2 });
  const d1 = '2026-09-28';
  for (let t = EAT(d1, '08:55'); t <= EAT(d1, '18:00'); t += 60000) { sim.now = t; await E.tick({ now: t, scan: false }); }
  check('day 1: 8 first emails', sim.sent.length === 8);
  const first = [...sim.sent];
  const byAcct = {}; for (const s of first) (byAcct[s.account] ||= []).push(s);
  const replier = byAcct[ACCOUNTS[0]][0].to;
  const bouncer = byAcct[ACCOUNTS[0]][1].to;
  const unsubber = byAcct[ACCOUNTS[1]][0];
  // unsubscribe through the real endpoint with the token from the email
  const tok = /api\/u\?t=([a-z0-9]{16})/.exec(unsubber.raw)[1];
  const u = await call(handlers.u, { method: 'POST', query: { t: tok } });
  check('unsubscribe page records it (same mailer:unsub key)', u.status === 200 && (await command('HEXISTS', 'mailer:unsub', tok)) === 1);
  // IMAP: a reply and a bounce in the first account's inbox
  setImapFactory(() => ({
    async connect() {}, async logout() {},
    async getMailboxLock() { return { release() {} }; },
    async search() { return [1, 2]; },
    async *fetch() {
      yield { uid: 1, envelope: { from: [{ address: replier }], subject: 'Re: hi' }, internalDate: new Date(EAT('2026-09-29', '10:00')) };
      yield { uid: 2, envelope: { from: [{ address: 'mailer-daemon@googlemail.com', name: 'Mail Delivery Subsystem' }], subject: 'Delivery Status Notification (Failure)' }, internalDate: new Date(EAT('2026-09-29', '10:05')) };
    },
    async fetchOne() { return { source: Buffer.from(`X-Failed-Recipients: ${bouncer}\r\nSubject: fail\r\n\r\n550 5.1.1 The email account that you tried to reach does not exist.\r\n`) }; },
  }));
  const quiet = () => ({ async connect() {}, async logout() {}, async getMailboxLock() { return { release() {} }; }, async search() { return []; }, async *fetch() {}, async fetchOne() { return null; } });
  const scan = await E.scanAccount(ACCOUNTS[0], EAT('2026-10-05', '08:00'));
  check('IMAP scan finds the reply and the bounce', scan.replies === 1 && scan.bounces === 1, JSON.stringify(scan));
  setImapFactory(quiet);
  for (const a of ACCOUNTS.slice(1)) await E.scanAccount(a, EAT('2026-10-05', '08:00'));
  await S.writeSettings({ ...(await S.readSettings()) }); // keep
  await command('HDEL', S.K.acct, ACCOUNTS[0]);            // un-pause (the bounce paused it) but keep a fresh scan time
  await S.patchAccountState(ACCOUNTS[0], { lastImapOkAt: EAT('2026-10-05', '08:00'), lastImapAt: EAT('2026-10-05', '08:00') });
  await admin('contacts.upload', { csv: makeCsv(20, { prefix: 'g' }) });
  const d8 = '2026-10-05';
  const n0 = sim.sent.length;
  for (let t = EAT(d8, '08:55'); t <= EAT(d8, '18:00'); t += 60000) { sim.now = t; await E.tick({ now: t, scan: false }); }
  const day8 = sim.sent.slice(n0);
  const fus = day8.filter((s) => /still thinking it over/.test(s.subject));
  check('follow-ups go only to the 5 who did not reply, bounce or unsubscribe', fus.length === 5 && !fus.some((s) => [replier, bouncer, unsubber.to].includes(s.to)), fus.map((s) => s.to).join(' '));
  check('each follow-up comes from the account that sent the first email', fus.every((f) => first.find((x) => x.to === f.to).account === f.account));
  const per = {}; for (const s of day8) per[s.account] = (per[s.account] || 0) + 1;
  check('follow-ups count toward the cap (2 per account, 8 total)', day8.length === 8 && Object.values(per).every((n) => n === 2), JSON.stringify(per));
  // stale reply check holds follow-ups back
  const d15 = '2026-10-12';
  await S.patchAccountState(ACCOUNTS[2], { lastImapOkAt: EAT('2026-10-05', '08:00') });
  const n1 = sim.sent.length;
  for (let t = EAT(d15, '08:55'); t <= EAT(d15, '18:00'); t += 60000) { sim.now = t; await E.tick({ now: t, scan: false }); }
  check('no follow-up from an account whose inbox was not checked in the last 24h', !sim.sent.slice(n1).some((s) => s.account === ACCOUNTS[2] && /still thinking/.test(s.subject)));
  const all = sim.sent.map((s) => `${s.to}|${s.subject}`);
  check('no identical email twice to anyone', new Set(all).size === all.length);
}

// ============================================================ 11. config, history, extension contract
section('11. /api/config stays compatible; versions and rollback');
await reset();
{
  const g0 = await call(handlers.config, { headers: { 'x-team-key': 'team-test-key' } });
  const keys = ['version', 'dailyLimit', 'followUpDays', 'maxTouches', 'templates', 'senders'];
  check('GET /api/config (team key) has every field syncConfig/applyRemoteConfig use', g0.status === 200 && keys.every((k) => k in g0.json) && Object.keys(g0.json.templates).length === 5);
  check('GET without key is refused', (await call(handlers.config)).status === 401);
  const tpl = { ...g0.json.templates, tech: { subject: 'NEW {{company}}', body: 'Body {{company}}\n{{sender_name}}' } };
  const p1 = await call(handlers.config, { method: 'PUT', headers: { 'x-admin-password': 'admin-test-pw' }, body: { ...g0.json, templates: tpl } });
  check('PUT with admin password bumps version (the extension applies newer versions)', p1.status === 200 && p1.json.version === 1);
  const p2 = await call(handlers.config, { method: 'PUT', headers: { 'x-admin-password': 'admin-test-pw' }, body: { ...p1.json, templates: { ...tpl, tech: { subject: 'V2', body: 'V2 body' } } } });
  const hist = await admin('config.history');
  check('version history kept (2 entries)', hist.json.items.length === 2 && hist.json.items[0].templates.tech.subject === 'NEW {{company}}');
  const rb = await admin('config.rollback', { index: 0 });
  check('rollback restores old templates as a NEW version', rb.json.config.version === 3 && rb.json.config.templates.tech.subject === 'NEW {{company}}');
  check('PUT with a wrong password refused', (await call(handlers.config, { method: 'PUT', headers: { 'x-admin-password': 'nope' }, body: {} })).status === 401);
  for (let i = 0; i < 25; i++) await call(handlers.config, { method: 'PUT', headers: { 'x-admin-password': 'admin-test-pw' }, body: {} });
  check('history capped at 20 versions', (await admin('config.history')).json.items.length === 20);
  const pv = await admin('preview', { templateId: 'callcenter', template: { subject: 'Hi {{company}} {{nope}}', body: 'x {{hours_gap}}' } });
  check('live preview flags missing placeholders', pv.status === 200 && pv.json.problems.missing.includes('nope'));
  // extension contract for suppression sharing
  const push = await call(handlers.leads, { method: 'POST', headers: { 'x-team-key': 'team-test-key' }, body: { contacted: ['E1@x.example', 'bad', 'e2@x.example'] } });
  check('extension can push its history for suppression', push.status === 200 && push.json.added === 2);
  await command('HSET', S.K.sent, 'srv1@x.example', '{}');
  const pull = await call(handlers.leads, { headers: { 'x-team-key': 'team-test-key' }, query: { contacted: '1' } });
  check('extension can pull server-contacted addresses', pull.json.contacted.includes('srv1@x.example'));
}

// ============================================================ 13. tomorrow's queue is real
section("13. the next-day preview is what gets sent; unsent contacts go first next time");
await reset();
{
  E.setRandom(mulberry(77));
  await admin('contacts.upload', { csv: makeCsv(20, { prefix: 'm' }) });
  await saveSettings({ paused: false });
  const fri = '2026-09-25', mon = '2026-09-28';
  // Friday had its own plan and sent all of it: that must not reshuffle Monday's preview
  await command('HSET', S.K.plan(fri), 'meta', JSON.stringify({ date: fri, builtAt: EAT(fri, '08:00') }), `${fri}:x:0`, JSON.stringify({ id: `${fri}:x:0`, date: fri, email: 'old@x.example', status: 'sent', at: EAT(fri, '09:00') }));
  await command('SADD', S.K.plans, fri);
  const preview = await E.ensurePlan(mon, { now: EAT(fri, '17:00') });
  check('Friday 17:00 preview of Monday holds all 20 (today\'s window already closed)', preview.items.length === 20 && (await E.readPlan(fri)).items.length === 1);
  for (let t = EAT(mon, '08:55'); t <= EAT(mon, '18:00'); t += 60000) { sim.now = t; await E.tick({ now: t, scan: false }); }
  const planned = preview.items.map((i) => `${i.account}>${i.email}`).sort().join();
  const actual = sim.sent.map((x) => `${x.account}>${x.to}`).sort().join();
  check('Monday sent exactly the previewed recipients from the previewed accounts', planned === actual);
  const late = sim.sent.map((x) => x.at - preview.items.find((i) => i.email === x.to).at);
  check('each send went within a minute of its previewed time', late.every((d) => d >= 0 && d < 60000), late.join(','));

  await reset();
  await admin('contacts.upload', { csv: makeCsv(70, { prefix: 'n' }) });
  const wed = '2026-09-30', thu = '2026-10-01';
  await E.ensurePlan(thu, { now: EAT(wed, '10:00') });   // Wednesday's plan (60) is built first, Thursday gets 10
  const wedPlan = await E.readPlan(wed);
  check('preview during an open window builds today first (FIFO)', wedPlan.items.length === 60 && (await E.readPlan(thu)).items.length === 10);
  // paused all Wednesday: nothing sent; on Thursday those 60 come back first
  const thuPlan = await E.ensurePlan(thu, { now: EAT(thu, '08:00') });
  const wedEmails = new Set(wedPlan.items.map((i) => i.email));
  check('Thursday\'s untouched plan is rebuilt so Wednesday\'s unsent contacts go first', thuPlan.items.length === 60 && thuPlan.items.every((i) => wedEmails.has(i.email)));
  check('nothing lost: 60 planned + 10 waiting', Number(await command('LLEN', S.K.queue)) === 10);
}

// ============================================================ 12. endpoints + auth + secrets
section('12. existing endpoints, auth and secret hygiene');
{
  // /api/l answers first and records the open through waitUntil. Stand in for
  // Vercel's request context so the test sees what waitUntil was handed.
  const { LOGO_PNG } = await import('../api/_logo.js');
  const CTX = Symbol.for('@vercel/request-context');
  const savedCtx = globalThis[CTX], realFetch = globalThis.fetch;
  let waited = [];
  globalThis[CTX] = { get: () => ({ waitUntil: (p) => { waited.push(p); } }) };
  const isLogo = (r) => r.status === 200 && r.headers['content-type'] === 'image/png' && Buffer.isBuffer(r.raw) && r.raw.equals(LOGO_PNG)
    && r.headers['content-length'] === LOGO_PNG.length && /no-store/.test(r.headers['cache-control']);
  try {
    // the store is held up: the logo must already be out while the write waits
    let release; const gate = new Promise((r) => { release = r; });
    globalThis.fetch = (...a) => gate.then(() => realFetch(...a));
    const l = await call(handlers.l, { query: { t: 'abcdefghijkl1234' }, headers: { 'user-agent': 'GoogleImageProxy' } });
    check('/api/l sends the logo before the store write finishes', isLogo(l) && waited.length === 1);
    globalThis.fetch = realFetch; release();
    await Promise.all(waited);
    const hits = JSON.parse(await command('HGET', 'mailer:opens', 'abcdefghijkl1234') || '[]');
    check('/api/l records the open via waitUntil (after the response)', hits.length === 1 && hits[0][1] === 'gmail', JSON.stringify(hits));
    // junk token: logo, and nothing handed to waitUntil
    waited = [];
    const junk = await call(handlers.l, { query: { t: '../etc/passwd' } });
    check('/api/l serves the logo for a junk token and writes nothing', isLogo(junk) && waited.length === 0);
    // store down: logo still served, the write fails quietly
    globalThis.fetch = () => Promise.reject(new Error('store down'));
    const down = await call(handlers.l, { query: { t: 'storedown12345' } });
    const settled = await Promise.allSettled(waited);
    check('/api/l serves the logo when the store is down (write fails quietly)', isLogo(down) && settled.length === 1 && settled[0].status === 'fulfilled');
  } finally {
    globalThis.fetch = realFetch;
    if (savedCtx === undefined) delete globalThis[CTX]; else globalThis[CTX] = savedCtx;
  }
  check('/api/l serves the logo and records an open', (await command('HEXISTS', 'mailer:opens', 'abcdefghijkl1234')) === 1 && (await command('HEXISTS', 'mailer:opens', 'storedown12345')) === 0);
  // /api/events is tracking data: team key or admin password, nothing else
  const noAuth = await call(handlers.events);
  check('/api/events without auth -> 401 and no data', noAuth.status === 401 && !noAuth.json.opens && !noAuth.json.unsub && !/abcdefghijkl1234/.test(noAuth.raw));
  const badAuth = [
    { 'x-team-key': 'nope' }, { 'x-admin-password': 'nope' }, { 'x-team-key': '' }, { 'x-mailer-key': '' }, { 'x-mailer-key': 'anything' },
    { 'x-team-key': 'team-test-ke' }, { 'x-admin-password': 'admin-test-pw ' },
  ];
  const badRes = await Promise.all(badAuth.map((h) => call(handlers.events, { headers: h })));
  check('/api/events with a wrong/empty key -> 401 (MAILER_KEY unset opens nothing)', badRes.every((r) => r.status === 401 && !r.json.opens));
  const evAdmin = await call(handlers.events, { headers: { 'x-admin-password': 'admin-test-pw' } });
  check('/api/events with the admin password -> 200 with opens + unsub', evAdmin.status === 200 && evAdmin.json.opens.abcdefghijkl1234 && typeof evAdmin.json.unsub === 'object');
  const ev = await call(handlers.events, { headers: { 'x-team-key': 'team-test-key' } });
  check('/api/events with the extension TEAM_KEY -> 200 with opens + unsub', ev.status === 200 && ev.json.opens.abcdefghijkl1234 && typeof ev.json.unsub === 'object');
  process.env.MAILER_KEY = 'legacy-mailer-key';
  const evLegacy = await call(handlers.events, { headers: { 'x-mailer-key': 'legacy-mailer-key' } });
  delete process.env.MAILER_KEY;
  check('/api/events still honours a MAILER_KEY if one is set', evLegacy.status === 200 && evLegacy.json.opens.abcdefghijkl1234);
  const pre = await call(handlers.events, { method: 'OPTIONS' });
  check('/api/events CORS preflight allows the team/admin headers', pre.status === 204 && /x-team-key/.test(pre.headers['access-control-allow-headers']) && /x-admin-password/.test(pre.headers['access-control-allow-headers']));
  const savedTeam = process.env.TEAM_KEY; delete process.env.TEAM_KEY;
  check('/api/events with TEAM_KEY unset refuses an empty x-team-key', (await call(handlers.events, { headers: { 'x-team-key': '' } })).status === 401);
  process.env.TEAM_KEY = savedTeam;
  // the recipient-facing endpoints stay public
  const lPub = await call(handlers.l, { query: { t: 'nosuchtoken' } });
  check('/api/l and /api/u stay public', lPub.status === 200 && lPub.headers['content-type'] === 'image/png'
    && (await call(handlers.u, { query: { t: 'abcdefghijkl1234' } })).status === 200);
  check('/api/admin without password -> 401', (await call(handlers.admin, { method: 'POST', body: { action: 'overview' } })).status === 401);
  check('/api/tick without secret -> 401', (await call(handlers.tick)).status === 401);
  check('/api/tick with wrong secret -> 401', (await call(handlers.tick, { headers: { authorization: 'Bearer nope' } })).status === 401);
  const saved = process.env.CRON_SECRET; delete process.env.CRON_SECRET;
  check('/api/tick refuses everything when CRON_SECRET is unset', (await call(handlers.tick, { headers: { authorization: 'Bearer ' } })).status === 503);
  process.env.CRON_SECRET = saved;
  const ov = await admin('overview');
  const blob = JSON.stringify(ov.json);
  // dump every Redis value
  const keys = await command('KEYS', '*');
  let dump = '';
  for (const k of keys) {
    const type = await command('TYPE', k);
    if (type === 'string') dump += await command('GET', k);
    else if (type === 'hash') dump += JSON.stringify(await command('HGETALL', k));
    else if (type === 'list') dump += JSON.stringify(await command('LRANGE', k, 0, -1));
    else if (type === 'set') dump += JSON.stringify(await command('SMEMBERS', k));
    else if (type === 'zset') dump += JSON.stringify(await command('ZRANGE', k, 0, -1));
  }
  const leaked = Object.values(FAKE_PW).some((p) => blob.includes(p) || dump.includes(p));
  check('app passwords never appear in API output or anywhere in Redis', !leaked && ov.json.env.passwords[ACCOUNTS[0]].set === true);
}

// ============================================================ 14. dashboard: analytics + sign-in probe
section('14. dashboard analytics and the sign-in probe');
await reset();
{
  E.setRandom(mulberry(99));
  const cfgPut = await call(handlers.config, { method: 'PUT', headers: { 'x-admin-password': 'admin-test-pw' }, body: { templates: DEFAULT_TEMPLATES } });
  await admin('contacts.upload', { csv: makeCsv(12, { prefix: 'an' }) });
  await saveSettings({ paused: false, perAccountCap: 3 });
  const day = '2026-10-05';
  for (let t = EAT(day, '08:55'); t <= EAT(day, '14:00'); t += 60000) { sim.now = t; await E.tick({ now: t, scan: false }); }
  check('engine sent the day (12 contacts, cap 3 x 4 accounts)', sim.sent.length === 12, `${sim.sent.length}`);
  const recs = Object.values(Object.fromEntries(((await command('HGETALL', S.K.sent)) || []).reduce((a, v, i, arr) => (i % 2 ? a : [...a, [arr[i], JSON.parse(arr[i + 1])]]), [])));
  check('each touch records the template version it was sent with', recs.every((r) => r.touches.every((t) => t.v === cfgPut.json.version)));
  // one open (through the real tracker), one reply, one bounce
  const [r0, r1, r2] = recs;
  await call(handlers.l, { query: { t: r0.touches[0].t }, headers: { 'user-agent': 'GoogleImageProxy' } });
  await command('HSET', S.K.sent, r1.email, JSON.stringify({ ...r1, repliedAt: r1.firstSentAt + 3600000 }));
  await command('HSET', S.K.sent, r2.email, JSON.stringify({ ...r2, bouncedAt: r2.firstSentAt + 60000 }));
  const a = await admin('analytics', { days: 30 });
  const nowDay = S.eatDate(Date.now());
  check('analytics answers', a.status === 200 && Array.isArray(a.json.days) && a.json.days.length === 30 && a.json.days.at(-1) === nowDay);
  const T = a.json.totals;
  check('analytics totals match what was sent', T.contacts === 12 && T.emails === 12 && T.openedContacts === 1 && T.replied === 1 && T.bounced === 1, JSON.stringify(T));
  const perAcct = Object.fromEntries(a.json.accounts.map((x) => [x.account, x.sent]));
  check('per-account sends (3 each) in config order', a.json.accounts.map((x) => x.account).join() === ACCOUNTS.join() && ACCOUNTS.every((x) => perAcct[x] === 3), JSON.stringify(perAcct));
  const tv = a.json.templates.reduce((n, t) => n + t.sent, 0);
  check('per-template-version rows add up and carry the version', tv === 12 && a.json.templates.every((t) => t.version === cfgPut.json.version));
  check('replies and bounces credited to a template', a.json.templates.reduce((n, t) => n + t.replied, 0) === 1 && a.json.templates.reduce((n, t) => n + t.bounced, 0) === 1);
  check('pipeline: 10 still in rotation at touch 1, 1 replied, 1 bounced', a.json.pipeline.touch['1'] === 10 && a.json.pipeline.replied === 1 && a.json.pipeline.bounced === 1, JSON.stringify(a.json.pipeline));
  const logDays = Object.values(a.json.logByDay).reduce((n, d) => n + (d.sent || 0), 0);
  check('log activity is only counted inside its window (the sends are dated 2026-10-05)', logDays === 0 || Object.keys(a.json.logByDay).every((d) => d >= S.addDays(nowDay, -14)));
  const blob = JSON.stringify(a.json);
  check('analytics output holds counts only: no addresses or tokens', !recs.some((r) => blob.includes(r.email) || blob.includes(r.touches[0].t)));
  const g = await call(handlers.admin, { method: 'GET' });
  check('GET /api/admin (no password) only says whether sign-in can work', g.status === 200 && g.json.adminConfigured === true && g.json.database === true && Object.keys(g.json).length === 2);
  const savedPw = process.env.ADMIN_PASSWORD; delete process.env.ADMIN_PASSWORD;
  const g2 = await call(handlers.admin, { method: 'GET' });
  const p2 = await call(handlers.admin, { method: 'POST', headers: { 'x-admin-password': '' }, body: { action: 'overview' } });
  process.env.ADMIN_PASSWORD = savedPw;
  check('with ADMIN_PASSWORD unset the probe says so and every action stays locked', g2.json.adminConfigured === false && p2.status === 401);
  check('analytics needs the admin password', (await call(handlers.admin, { method: 'POST', body: { action: 'analytics' } })).status === 401);
  const st = await command('GET', S.K.settings);
  check('dashboard reads never change the pause setting', JSON.parse(st).paused === false);
}

// ============================================================ test batch
section('Send test batch now (flow.testNow): allowlist only, bypasses pause/window, respects caps');
{
  await shim.flush();
  sim.sent = []; sim.behaviour = {};
  const ALLOW = ['michaelgetu21@gmail.com', 'michaelgetu07@gmail.com', 'mickgetu@gmail.com'];
  const REAL = ['real.one@realco.example', 'real.two@gmail.com', 'real.three@othercorp.example'];
  const st0 = (await admin('overview')).json.settings;
  check('test recipients default to the three inboxes, and sending starts paused', JSON.stringify(st0.testRecipients) === JSON.stringify(ALLOW) && st0.paused === true);
  const saved = (await admin('settings.save', { settings: { testRecipients: ' MickGetu@gmail.com\nnot-an-email, michaelgetu21@gmail.com;mickgetu@gmail.com ' } })).json.settings;
  check('test recipients are cleaned on save (lowercase, valid, de-duplicated)', JSON.stringify(saved.testRecipients) === JSON.stringify(['mickgetu@gmail.com', 'michaelgetu21@gmail.com']) && saved.paused === true);
  await admin('settings.save', { settings: { testRecipients: ALLOW, weekdays: [], skipTemplates: [] } });   // no sending day at all: the window can never be open
  const csv = ['email,first_name,company,segment,hours_gap,email_status',
    `${REAL[0]},Rae,Real Co,tech,,valid`, `${ALLOW[0]},Michael,[TEST] Sample Dev Studio,tech,,valid`, `${REAL[1]},Rob,Real Dental,callcenter,closed weekends,valid`,
    `${ALLOW[1]},Michael,[TEST] Sample Dental Ltd,va,,valid`, `${ALLOW[2]},Michael,[TEST] Sample Clinic,callcenter-generic,closed on weekends,valid`,
    `${REAL[2]},Ria,Other Corp,va,,valid`].join('\n');
  const up = await admin('contacts.upload', { csv });
  check('mixed upload: 3 test + 3 real contacts queued', up.json.added === 6, JSON.stringify(up.json.skipped));
  const tk = await call(handlers.tick, { headers: { authorization: 'Bearer cron-test-secret' } });
  check('the normal tick sends nothing (paused)', tk.status === 200 && sim.sent.length === 0);

  check('flow.testNow needs the admin password', (await call(handlers.admin, { method: 'POST', body: { action: 'flow.testNow', confirm: ALLOW } })).status === 401);
  const pv = await admin('flow.testNow');
  const pvTo = pv.json.assign.map((x) => x.email).sort();
  check('preview lists exactly the allowlisted queued contacts, one account each, and sends nothing', pv.json.preview && JSON.stringify(pvTo) === JSON.stringify([...ALLOW].sort())
    && new Set(pv.json.assign.map((x) => x.account)).size === 3 && pv.json.otherQueuedUntouched === 3 && sim.sent.length === 0 && Number(await command('LLEN', S.K.queue)) === 6);
  check('preview maps each test row to its template', pv.json.assign.find((x) => x.email === ALLOW[0]).template === 'tech'
    && pv.json.assign.find((x) => x.email === ALLOW[1]).template === 'va' && pv.json.assign.find((x) => x.email === ALLOW[2]).template === 'callcenter-generic');

  // a confirm list that names real contacts still sends only to allowlisted ones
  const r1 = await admin('flow.testNow', { confirm: [...ALLOW, ...REAL] });
  const tos = sim.sent.map((m) => m.to);
  check('sends to the 3 allowlisted contacts while paused and outside any window', r1.status === 200 && r1.json.sent === 3 && sim.sent.length === 3 && tos.every((t) => ALLOW.includes(t)), JSON.stringify(r1.json.results));
  check('a non-allowlisted contact is never sent, even when named in the confirm list', !tos.some((t) => REAL.includes(t)));
  const q = (await command('LRANGE', S.K.queue, 0, -1)) || [];
  const realRecs = (await command('HMGET', S.K.contacts, ...REAL)).map((x) => JSON.parse(x));
  check('real contacts stay queued and untouched', JSON.stringify([...q].sort()) === JSON.stringify([...REAL].sort()) && realRecs.every((c) => c.status === 'queued'));
  check('one email per account per click', new Set(sim.sent.map((m) => m.account)).size === 3);
  const lg = (await admin('log.list')).json.items.filter((e) => e.status === 'sent');
  const sentRec = JSON.parse(await command('HGET', S.K.sent, ALLOW[0]));
  const m0 = sim.sent.find((m) => m.to === ALLOW[0]);
  check('the real pipeline ran: log entries (marked test batch), send records, follow-up rotation, tracked logo',
    lg.length === 3 && lg.every((e) => e.testBatch && e.token) && sentRec?.touches.length === 1 && Number(await command('ZSCORE', S.K.fu, ALLOW[0])) > 0
    && m0.mail.html.includes(`/api/l?t=${sentRec.touches[0].t}`) && (await command('HGET', S.K.tokens, sentRec.touches[0].t)) === ALLOW[0],
    JSON.stringify({ lg: lg.length }));
  check('counted against the daily cap and the 10/day test limit', (await admin('overview')).json.accounts.filter((a) => a.sentToday === 1).length === 3
    && Object.values(await command('HGETALL', `mailer:srv:tests:${S.eatDate(Date.now())}`)).length > 0);
  const st1 = (await admin('overview')).json.settings;
  check('the global pause is still on afterwards', st1.paused === true);
  const r2 = await admin('flow.testNow');
  check('with no allowlisted contacts left it does nothing and says so', r2.json.assign.length === 0 && /no queued contacts/.test(r2.json.note) && sim.sent.length === 3);
  const r2b = await admin('flow.testNow', { confirm: REAL });
  check('confirming only real contacts sends nothing', r2b.json.sent === 0 && sim.sent.length === 3);
  // sendItem refuses the bypass for anyone not on the list
  const direct = await E.sendItem({ id: 'x:1', date: S.eatDate(Date.now()), account: ACCOUNTS[3], email: REAL[0], template: 'tech', followUp: false, touch: 1, at: Date.now(), status: 'planned' }, { bypassPause: true });
  check('sendItem never bypasses the pause for a non-allowlisted address', direct.status === 'not on the test-recipient list' && sim.sent.length === 3);

  // caps: daily cap, test limit, paused/auto-paused accounts, one per account per click
  const T = Array.from({ length: 6 }, (_, i) => `tester${i}@testbox.example`);
  await admin('settings.save', { settings: { testRecipients: T, perAccountCap: 2 } });
  await admin('contacts.upload', { csv: ['email,first_name,company,segment,email_status', ...T.map((e, i) => `${e},T${i},[TEST] Co ${i},tech,valid`)].join('\n') });
  const today = S.eatDate(Date.now());
  await command('HSET', S.K.count(today), ACCOUNTS[0], 2);                      // at the daily cap
  await command('HSET', `mailer:srv:tests:${today}`, ACCOUNTS[1], 10);          // used its 10 test emails
  await S.patchAccountState(ACCOUNTS[2], { paused: true, auto: true, reason: 'bounce rate 6.0% (3 of 50)' });   // auto-paused
  const pv3 = (await admin('flow.testNow')).json;
  const blocked = Object.fromEntries(pv3.accounts.map((a) => [a.account, a.blocked]));
  check('daily cap, test limit and auto-pause block their accounts in the preview', /daily cap/.test(blocked[ACCOUNTS[0]]) && /10 test emails/.test(blocked[ACCOUNTS[1]])
    && /auto-paused/.test(blocked[ACCOUNTS[2]]) && !blocked[ACCOUNTS[3]] && pv3.assign.length === 1 && pv3.assign[0].account === ACCOUNTS[3] && pv3.waitingForNextClick.length === 5);
  const before3 = sim.sent.length;
  const r3 = await admin('flow.testNow', { confirm: T });
  check('only the one free account sends, one email, and the rest wait in the queue', r3.json.sent === 1 && sim.sent.length === before3 + 1 && sim.sent.at(-1).account === ACCOUNTS[3]
    && Number(await command('LLEN', S.K.queue)) === 3 + 5);
  // a bounce auto-pauses the account (5% rule), and the next click can't use it
  await S.patchAccountState(ACCOUNTS[2], { paused: false, auto: false, reason: '' });
  sim.behaviour[ACCOUNTS[2]] = () => Object.assign(new Error('550 5.1.1 no such user'), { responseCode: 550, command: 'RCPT TO', response: '550 5.1.1 no such user' });
  const r4 = (await admin('flow.testNow', { confirm: T })).json;
  const acc2 = (await S.readAccountStates())[ACCOUNTS[2]];
  check('a bounce on a test send auto-pauses the account like a real send', r4.results.some((x) => x.account === ACCOUNTS[2] && x.status === 'bounced') && acc2.paused && acc2.auto);
  const r5 = (await admin('flow.testNow')).json;
  check('the auto-paused account is not used on the next click', !r5.assign.some((x) => x.account === ACCOUNTS[2]));
  // the per-account test limit: 10 a day, then that account stops
  sim.behaviour = {};
  await S.patchAccountState(ACCOUNTS[2], { paused: false, auto: false, reason: '' });
  await command('HDEL', S.K.count(today), ACCOUNTS[0]);
  await admin('settings.save', { settings: { perAccountCap: 40 } });
  await command('HSET', `mailer:srv:tests:${today}`, ACCOUNTS[0], 9, ACCOUNTS[2], 10, ACCOUNTS[3], 10);
  await command('HSET', `mailer:srv:tests:${today}`, ACCOUNTS[1], 10);
  const r6 = (await admin('flow.testNow', { confirm: T })).json;
  const r7 = (await admin('flow.testNow', { confirm: T })).json;
  check('10 test emails per account per day: the 10th goes, the 11th does not', r6.sent === 1 && r6.results[0].account === ACCOUNTS[0] && r7.sent === 0 && /no account/.test(r7.note)
    && Number(await command('HGET', `mailer:srv:tests:${today}`, ACCOUNTS[0])) === 10);
  check('real contacts were never sent through the test batch', !sim.sent.some((m) => REAL.includes(m.to)));
  sim.behaviour = {};
}

// ============================================================ test follow-up
section('Send test follow-up now (flow.testFollowUp): next touch now, allowlist only, real stop rules');
{
  await reset();
  const ALLOW = ['michaelgetu21@gmail.com', 'michaelgetu07@gmail.com', 'mickgetu@gmail.com'];
  const REAL = 'real.person@realco.example';
  let imapReplies = [], imapFail = new Set();
  setImapFactory((account) => ({
    async connect() { if (imapFail.has(account)) throw new Error('IMAP login failed (test)'); }, async logout() {},
    async getMailboxLock() { return { release() {} }; },
    async search() { return imapReplies.map((_, i) => i + 1); },
    async *fetch() { let i = 0; for (const from of imapReplies) yield { uid: ++i, envelope: { from: [{ address: from }], subject: 'Re: your note' }, internalDate: new Date(Date.now()) }; },
    async fetchOne() { return null; },
  }));
  // first emails: the three test inboxes plus one real contact (sent while it was briefly allowlisted)
  await admin('settings.save', { settings: { testRecipients: [...ALLOW, REAL], weekdays: [] } });
  await admin('contacts.upload', { csv: ['email,first_name,company,segment,hours_gap,email_status',
    `${ALLOW[0]},Michael,[TEST] Sample Dev Studio,tech,,valid`, `${ALLOW[1]},Michael,[TEST] Sample Dental Ltd,va,,valid`,
    `${ALLOW[2]},Michael,[TEST] Sample Clinic,callcenter-generic,closed on weekends,valid`, `${REAL},Rae,Real Co,tech,,valid`].join('\n') });
  const b = await admin('flow.testNow', { confirm: [...ALLOW, REAL] });
  await admin('settings.save', { settings: { testRecipients: ALLOW } });
  const firstAcct = Object.fromEntries(b.json.results.map((x) => [x.email, x.account]));
  check('setup: 4 first emails from 4 accounts', b.json.sent === 4 && new Set(Object.values(firstAcct)).size === 4);
  const realBefore = await command('HGET', S.K.sent, REAL);
  const fuPlanNormal = (await admin('followups')).json.items;
  check('no follow-up is due for 7 days by the normal rules', !fuPlanNormal.some((x) => x.dueDate === S.eatDate(Date.now())));

  check('flow.testFollowUp needs the admin password', (await call(handlers.admin, { method: 'POST', body: { action: 'flow.testFollowUp', confirm: ALLOW } })).status === 401);
  const pv = (await admin('flow.testFollowUp')).json;
  check('preview: the 3 test contacts, same account as their first email, touch 2; the real contact is not listed',
    pv.preview && pv.assign.length === 3 && pv.assign.every((x) => ALLOW.includes(x.email) && x.account === firstAcct[x.email] && x.touch === 2)
    && !JSON.stringify(pv).includes(REAL) && sim.sent.length === 4);

  // the user replies from the second inbox before clicking
  imapReplies = [ALLOW[1]];
  const n0 = sim.sent.length;
  const r1 = (await admin('flow.testFollowUp', { confirm: [...ALLOW, REAL] })).json;
  const fu1 = sim.sent.slice(n0);
  const fuSubject = (e) => R.renderEmail({ contact: { company: e === ALLOW[0] ? '[TEST] Sample Dev Studio' : '[TEST] Sample Clinic', email: e, _segment: 'followup' },
    templates: DEFAULT_TEMPLATES, templateId: 'followup', senderName: '', token: 'x0000000000000' }).subject;
  check('the inbox is checked first and the contact who replied is skipped with the reason', r1.scans.length === 3 && r1.results.some((x) => x.email === ALLOW[1] && x.status === 'skipped' && /replied/.test(x.reason)));
  check('follow-ups go now, skipping the wait, while paused, to the other two only', r1.sent === 2 && fu1.length === 2 && fu1.every((m) => [ALLOW[0], ALLOW[2]].includes(m.to))
    && (await admin('overview')).json.settings.paused === true);
  check('same account as the previous email, follow-up template, like a real follow-up (no Re:, not threaded)',
    fu1.every((m) => m.account === firstAcct[m.to] && m.subject === fuSubject(m.to) && !/^re:/i.test(m.subject) && !m.mail.headers?.['In-Reply-To']));
  const rec0 = JSON.parse(await command('HGET', S.K.sent, ALLOW[0]));
  const lg = (await admin('log.list')).json.items.filter((e) => e.status === 'sent' && e.followUp);
  check('touch count goes up and it is logged as a follow-up (test batch)', rec0.touches.length === 2 && rec0.touches[1].followUp && rec0.touches[1].template === 'followup'
    && lg.length === 2 && lg.every((e) => e.touch === 2 && e.testBatch));
  check('the non-allowlisted contact is untouched (no email, record unchanged)', !sim.sent.slice(4).some((m) => m.to === REAL) && (await command('HGET', S.K.sent, REAL)) === realBefore);

  // wait skipped only for allowlisted addresses: a real follow-up for the real contact is still "not due yet"
  await S.writeSettings({ ...(await S.readSettings()), paused: false });
  const direct = await E.sendItem({ id: 'x:fu', date: S.eatDate(Date.now()), account: firstAcct[REAL], email: REAL, template: 'followup', followUp: true, touch: 2, at: Date.now(), status: 'planned' }, { skipWait: true });
  const direct2 = await E.sendItem({ id: 'x:fu2', date: S.eatDate(Date.now()), account: firstAcct[REAL], email: REAL, template: 'followup', followUp: true, touch: 2, at: Date.now(), status: 'planned' }, { bypassPause: true, skipWait: true });
  await S.writeSettings({ ...(await S.readSettings()), paused: true });
  check('the wait is only skipped for allowlisted contacts', direct.status === 'deferred' && direct.reason === 'not due yet' && direct2.status === 'not on the test-recipient list' && !sim.sent.slice(4).some((m) => m.to === REAL), JSON.stringify({ direct, direct2 }));

  // next click: one account's inbox check fails, so its contact is held; the other gets touch 3
  imapReplies = []; imapFail = new Set([firstAcct[ALLOW[2]]]);
  const n1 = sim.sent.length;
  const r2 = (await admin('flow.testFollowUp', { confirm: ALLOW })).json;
  check('a failed inbox check holds that contact back (click Check inbox)', r2.results.some((x) => x.email === ALLOW[2] && x.status === 'deferred' && /Check inbox/.test(x.reason))
    && sim.sent.slice(n1).length === 1 && sim.sent.at(-1).to === ALLOW[0] && JSON.parse(await command('HGET', S.K.sent, ALLOW[0])).touches.length === 3);
  imapFail = new Set();
  const r3 = (await admin('flow.testFollowUp', { confirm: ALLOW })).json;
  check('stops at maxTouches (3): the finished contact is skipped with the reason', r3.sent === 1 && sim.sent.at(-1).to === ALLOW[2]
    && r3.results.find((x) => x.email === ALLOW[2]).touch === 3 && (await admin('flow.testFollowUp')).json.skipped.some((x) => x.email === ALLOW[0] && /max touches \(3 of 3\)/.test(x.reason)));
  const r4 = (await admin('flow.testFollowUp', { confirm: ALLOW })).json;
  check('after the last touch nothing more is sent', r4.sent === 0 && /nobody can get a follow-up/.test(r4.note) && !Number(await command('ZSCORE', S.K.fu, ALLOW[0])));

  // caps and settings
  await command('DEL', S.K.touch); await command('HDEL', S.K.sent, ALLOW[0]);   // make ALLOW[0] due again from scratch
  await admin('contacts.upload', { csv: `email,first_name,company,segment,email_status\n${ALLOW[0]},Michael,[TEST] Sample Dev Studio,tech,valid`, includeUnverified: true });
  await command('HDEL', S.K.contacts, ALLOW[0]);
  const today = S.eatDate(Date.now());
  const acctOf0 = firstAcct[ALLOW[0]];
  await command('HSET', S.K.sent, ALLOW[0], JSON.stringify({ email: ALLOW[0], account: acctOf0, company: '[TEST] Sample Dev Studio', row: { email: ALLOW[0], company: '[TEST] Sample Dev Studio' },
    template: 'tech', firstSentAt: Date.now() - 60000, lastSentAt: Date.now() - 60000, touches: [{ at: Date.now() - 60000, n: 1, t: 'tok0000000000001', template: 'tech' }], repliedAt: null, bouncedAt: null, unsubscribedAt: null }));
  await command('HSET', `mailer:srv:tests:${today}`, acctOf0, 10);
  const pv5 = (await admin('flow.testFollowUp')).json;
  check('the shared 10 test emails per account per day applies', pv5.assign.length === 0 && pv5.skipped.some((x) => x.email === ALLOW[0] && /10 test emails/.test(x.reason)));
  await command('HSET', `mailer:srv:tests:${today}`, acctOf0, 0);
  await admin('settings.save', { settings: { followUps: false } });
  const r6 = (await admin('flow.testFollowUp', { confirm: ALLOW })).json;
  check('with follow-ups turned off in settings it sends nothing and says so', r6.sent === 0 && /turned off/.test(r6.note));
  await admin('settings.save', { settings: { followUps: true } });
  check('real contact never emailed by the follow-up button', !sim.sent.some((m) => m.to === REAL && m !== sim.sent.find((x) => x.to === REAL)) && sim.sent.filter((m) => m.to === REAL).length === 1);
  setImapFactory(() => ({ async connect() {}, async logout() {}, async getMailboxLock() { return { release() {} }; }, async search() { return []; }, async *fetch() {}, async fetchOne() { return null; } }));
}

// ============================================================ data.reset
section('data.reset: empty the sending data, keep settings and suppression');
{
  // some of everything, on top of what the earlier sections left behind
  await admin('contacts.upload', { csv: makeCsv(5, { prefix: 'rst' }) });
  const tokens = (await command('HKEYS', 'mailer:srv:tokens')) || [];
  const serverTok = tokens[0] || 'servertoken0001';
  if (!tokens.length) await command('HSET', 'mailer:srv:tokens', serverTok, 'someone@x.example');
  await command('HSET', 'mailer:opens', serverTok, JSON.stringify([[1, 'gmail']]), 'zzjunkzzprobe1', JSON.stringify([[2, 'other']]), 'extensiontoken01', JSON.stringify([[3, 'gmail']]));
  await command('HSET', 'mailer:unsub', 'extensionunsub01', '12345');
  await command('HSET', 'mailer:srv:tests:2026-09-25', 'daniellzelalem@gmail.com', 3);
  await command('HSET', 'mailer:reports', 'someinstall00000001', JSON.stringify({ at: Date.now(), emails: 3 }));
  await command('SADD', 'mailer:srv:supp:emails', 'keep.me@list.example');
  await command('SADD', 'mailer:srv:optout', 'optedout@x.example');
  await command('SADD', 'mailer:ext:contacted', 'ext.person@x.example');
  await command('SET', 'mailer:unknownthing', 'x');
  await admin('settings.save', { settings: { paused: true, listUnsubscribe: false, footer: 'Sig line\n{{unsubscribe}}' } });
  const snap = async () => ({
    settings: await command('GET', 'mailer:srv:settings'), config: await command('GET', 'mailer:config'),
    history: await command('LLEN', 'mailer:config:history'), acct: await command('HGETALL', 'mailer:srv:acct'),
    supp: await Promise.all(['mailer:srv:supp:emails', 'mailer:srv:supp:domains', 'mailer:srv:optout', 'mailer:ext:contacted'].map((k) => command('SCARD', k))),
    unsub: await command('HGETALL', 'mailer:unsub'), reports: await command('HGETALL', 'mailer:reports'),
    unknown: await command('GET', 'mailer:unknownthing'), counts: (await admin('supp.counts')).json,
  });
  const before = await snap();
  const logBefore = Number(await command('LLEN', 'mailer:srv:log'));
  check('reset setup has data to wipe', Number(await command('HLEN', 'mailer:srv:contacts')) > 0 && logBefore > 0 && Number(await command('LLEN', 'mailer:srv:queue')) > 0);

  check('data.reset needs the admin password', (await call(handlers.admin, { method: 'POST', body: { action: 'data.reset', confirm: 'RESET' } })).status === 401);
  const dry = await admin('data.reset');
  check('data.reset without confirm is a dry run that deletes nothing', dry.status === 200 && dry.json.dryRun === true
    && dry.json.wipe.includes('mailer:srv:contacts') && dry.json.wipe.includes('mailer:srv:log')
    && Number(await command('LLEN', 'mailer:srv:log')) === logBefore && Number(await command('HLEN', 'mailer:srv:contacts')) > 0);
  check('dry run classifies keep / unknown keys and open records', !dry.json.wipe.includes('mailer:srv:settings') && dry.json.unknown.includes('mailer:unknownthing')
    && dry.json.opens.keep >= 1 && dry.json.opens.removeBy['junk probe'] === 1);
  const wrong = await admin('data.reset', { confirm: 'yes' });
  check('any confirm other than "RESET" is still a dry run', wrong.json.dryRun === true && Number(await command('LLEN', 'mailer:srv:log')) === logBefore);

  const r = await admin('data.reset', { confirm: 'RESET' });
  check('data.reset runs and names its backup key', r.status === 200 && r.json.ok && /^mailer:backup:reset:/.test(r.json.backupKey), JSON.stringify(r.json).slice(0, 200));
  const bk = r.json.backupKey;
  const bContacts = JSON.parse(await command('HGET', bk, 'mailer:srv:contacts') || 'null');
  const bLog = JSON.parse(await command('HGET', bk, 'mailer:srv:log') || 'null');
  check('backup holds everything removed (contacts, log, removed open fields)', bContacts?.type === 'hash' && bContacts.data.length > 0 && bLog?.data.length === logBefore
    && JSON.parse(await command('HGET', bk, 'mailer:opens (removed fields)')).data.includes('zzjunkzzprobe1') && Number(await command('TTL', bk)) > 0);
  const gone = ['mailer:srv:contacts', 'mailer:srv:queue', 'mailer:srv:sent', 'mailer:srv:tokens', 'mailer:srv:touch', 'mailer:srv:fu',
    'mailer:srv:plans', 'mailer:srv:log', 'mailer:srv:logbody', 'mailer:srv:tests:2026-09-25'];
  const left = [];
  for (const k of gone) if (Number(await command('EXISTS', k))) left.push(k);
  for (const pat of ['mailer:srv:plan:*', 'mailer:srv:count:*', 'mailer:srv:byacct:*', 'mailer:srv:recent:*', 'mailer:srv:last:*']) left.push(...((await command('KEYS', pat)) || []));
  check('contacts, queue, plans, log, send records, guard, follow-ups and counters are gone', left.length === 0, left.join(', '));
  check('server-mail and junk opens removed, the extension\'s opens kept',
    !Number(await command('HEXISTS', 'mailer:opens', serverTok)) && !Number(await command('HEXISTS', 'mailer:opens', 'zzjunkzzprobe1')) && Number(await command('HEXISTS', 'mailer:opens', 'extensiontoken01')) === 1);
  const after = await snap();
  check('settings (pause, List-Unsubscribe, footer), templates and history unchanged', after.settings === before.settings && after.config === before.config && after.history === before.history
    && JSON.parse(after.settings).paused === true && JSON.parse(after.settings).listUnsubscribe === false);
  check('accounts, suppression lists, unsubscribes, reports and unknown keys unchanged', JSON.stringify(after.acct) === JSON.stringify(before.acct)
    && JSON.stringify(after.supp) === JSON.stringify(before.supp) && JSON.stringify(after.counts) === JSON.stringify(before.counts)
    && JSON.stringify(after.unsub) === JSON.stringify(before.unsub) && JSON.stringify(after.reports) === JSON.stringify(before.reports) && after.unknown === 'x');
  const ov2 = (await admin('overview')).json;
  const lg = (await admin('log.list')).json;
  check('overview after reset: zero sends, empty queue, empty log', ov2.queue.queued === 0 && ov2.queue.contacts === 0 && ov2.queue.followUpCandidates === 0
    && ov2.accounts.every((a) => a.sentToday === 0 && a.sent7d === 0 && a.attemptsToday === 0) && lg.items.length === 0);
  const an2 = (await admin('analytics')).json;
  check('analytics after reset are empty', an2.totals.emails === 0 && an2.totals.contacts === 0 && Object.values(an2.logByDay).every((d) => !Object.keys(d).length), JSON.stringify(an2.totals));
  // uploads work straight after, and a later dry run sees them
  const up = await admin('contacts.upload', { csv: makeCsv(3, { prefix: 'post' }) });
  const dry2 = await admin('data.reset');
  check('uploads after the reset queue normally and are only listed by a later dry run', up.json.added === 3 && dry2.json.dryRun
    && Number(await command('LLEN', 'mailer:srv:queue')) === 3);
  await command('DEL', 'mailer:unknownthing');
}


// ============================================================ lanes
section('Lanes (Regular / Work / Hot): migration, isolation, no fallback, plain text, dedupe, caps, templates, follow-ups, tests');
await reset();
{
  const WORK = 'rafael.work@zemenay-work.example', HOT = 'rafael.hot@gmail.com';
  process.env.GMAIL_APP_PASSWORD_RAFAEL_WORK = 'fakepw-work-5555';
  process.env.GMAIL_APP_PASSWORD_RAFAEL_HOT = 'fakepw-hot-6666';
  const decode = (r) => r.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  const day = async (date) => { for (let t = EAT(date, '08:55'); t <= EAT(date, '18:00'); t += 60000) { sim.now = t; await E.tick({ now: t, scan: false }); } };
  const leads = (prefix, n, extra = '') => ['email,company,first_name,last_name,vertical,hours_gap,email_status',
    ...Array.from({ length: n }, (_, i) => `${prefix}lead${i}.jones@${prefix}firm${i}.example,${prefix.toUpperCase()} Firm ${i},Lee${i},Jones,dental,closed weekends,valid`), extra].filter(Boolean).join('\n');

  // --- migration: settings and contacts saved before lanes existed
  const oldSettings = { ...S.DEFAULT_SETTINGS, perAccountCap: 5, skipTemplates: [] };   // every category on, as in reset()
  delete oldSettings.lanes; delete oldSettings.accountLanes;
  await command('SET', S.K.settings, JSON.stringify(oldSettings));
  await command('HSET', S.K.contacts, 'old.contact@legacy.example', JSON.stringify({ email: 'old.contact@legacy.example', row: { email: 'old.contact@legacy.example', company: 'Legacy', vertical: 'dental', hours_gap: 'closed weekends' }, template: 'callcenter', addedAt: 1, status: 'queued' }));
  await command('RPUSH', S.K.queue, 'old.contact@legacy.example');
  const mig = await S.readSettings();
  check('migration: old settings read with lane defaults (Regular plain OFF, Work/Hot plain ON, no footer opt-out line)',
    mig.lanes.regular.plainText === false && mig.lanes.work.plainText === true && mig.lanes.hot.plainText === true
    && !mig.lanes.work.optOutLine && mig.perAccountCap === 5 && mig.paused === true, JSON.stringify(mig.lanes));
  check('migration: every existing account is Regular', ACCOUNTS.every((a) => S.laneOf(mig, a) === 'regular') && Object.keys(mig.accountLanes).length === 0);
  const ovm = (await admin('overview')).json;
  check('migration: overview lists the 4 accounts under Regular, none under Work/Hot', ovm.lanes.regular.accounts.length === 4
    && ovm.lanes.work.accounts.length === 0 && ovm.lanes.hot.accounts.length === 0 && ovm.lanes.regular.queued === 1, JSON.stringify(ovm.lanes));
  const qm = (await admin('queue.list')).json;
  check('migration: an old contact (no lane field) is in the Regular queue', qm.total === 1 && qm.items[0].email === 'old.contact@legacy.example');

  // --- no account assigned: Work leads wait, never go out from Regular accounts
  E.setRandom(mulberry(314));
  await admin('contacts.upload', { csv: makeCsv(12, { prefix: 'rg' }) });
  const wu = await admin('contacts.upload', { csv: leads('wk', 6), lane: 'work' });
  check('Work upload queues into the Work lane only', wu.json.added === 6 && wu.json.lane === 'work' && Number(await command('LLEN', S.K.queueOf('work'))) === 6
    && Number(await command('LLEN', S.K.queue)) === 13);
  const tnw = (await admin('flow.testNow', { lane: 'work' })).json;
  check('test batch for a lane with no account says "no account assigned"', tnw.accounts.length === 0 && /no account assigned to the Work lane/.test(tnw.note) && tnw.assign.length === 0, tnw.note);
  await saveSettings({ paused: false });
  await day('2026-09-28');
  const workLeadsSent = sim.sent.filter((m) => /wklead/.test(m.to));
  check('no fallback: 0 Work leads sent from Regular accounts over a whole day', workLeadsSent.length === 0 && Number(await command('LLEN', S.K.queueOf('work'))) === 6, `${workLeadsSent.length}`);
  check('Regular carried on as before (all 13 queued Regular contacts sent from Regular accounts, HTML)', sim.sent.length === 13 && sim.sent.every((m) => ACCOUNTS.includes(m.account) && m.mail.html));
  const pmeta = (await E.readPlan('2026-09-28')).meta;
  check('plan records the Work lane as "no account"', pmeta.lanes.work.noAccount === true && pmeta.lanes.work.accounts.length === 0 && pmeta.lanes.regular.accounts.length === 4);

  // --- adding accounts into lanes never touches the pause
  await saveSettings({ paused: true });
  const add1 = await admin('account.add', { account: WORK, name: 'Rafael', lane: 'work' });
  const add2 = await admin('account.add', { account: HOT.toUpperCase(), name: 'Rafael M', lane: 'hot' });
  const st1 = await S.readSettings();
  check('account.add puts the work email in Work and the hot email in Hot', add1.json.lane === 'work' && add2.json.lane === 'hot' && add2.json.account === HOT
    && S.laneOf(st1, WORK) === 'work' && S.laneOf(st1, HOT) === 'hot' && add1.json.passwordVar === 'GMAIL_APP_PASSWORD_RAFAEL_WORK');
  const cfg1 = (await call(handlers.config, { headers: { 'x-team-key': 'team-test-key' } })).json;
  check('new accounts join the sender list (config keeps 5 templates for the extension)', cfg1.senders[WORK] === 'Rafael' && cfg1.senders[HOT] === 'Rafael M' && Object.keys(cfg1.templates).length === 5);
  const lsv = await admin('lanes.save', { lanes: { work: { cap: 3, template: 'tech' }, hot: { cap: 2, template: 'custom', custom: { subject: 'Quick one for {{company}}', body: 'Hi {{first_name}},\n\nShort note, plain and simple.\n\n{{sender_name}}' },
    followupTemplate: 'custom', followupCustom: { subject: 'Re: quick one for {{company}}', body: 'Hi {{first_name}}, just bumping this.\n\n{{sender_name}}' } } } });
  const al = await admin('account.lane', { account: ACCOUNTS[3], lane: 'regular' });
  const st2 = await S.readSettings();
  check('account.add / account.lane / lanes.save leave the global pause ON', st2.paused === true && lsv.status === 200 && al.json.lane === 'regular');
  check('lane.save rejects unknown lanes, bad caps and bad template ids', (await admin('account.lane', { account: WORK, lane: 'vip' })).status === 400
    && S.cleanLanes({ work: { cap: 999, template: 'nope' } }, st2.lanes).work.cap === 40 && S.cleanLanes({ work: { template: 'nope' } }, st2.lanes).work.template === 'tech');
  const n0 = sim.sent.length;
  await day('2026-09-29');
  check('paused: lane accounts send nothing either', sim.sent.length === n0);

  // --- a day with all three lanes
  await admin('contacts.upload', { csv: makeCsv(30, { prefix: 'rh' }) });
  const hu = await admin('contacts.upload', { csv: leads('ht', 4), lane: 'hot' });
  check('Hot upload queues 4 into the Hot lane', hu.json.added === 4 && Number(await command('LLEN', S.K.queueOf('hot'))) === 4);
  await saveSettings({ paused: false });
  const d1 = '2026-09-30', n1 = sim.sent.length;
  await day(d1);
  const today1 = sim.sent.slice(n1);
  const fromReg = today1.filter((m) => ACCOUNTS.includes(m.account)), fromWork = today1.filter((m) => m.account === WORK), fromHot = today1.filter((m) => m.account === HOT);
  check(`isolation: Work account sent only Work leads (${fromWork.length}), Hot only Hot leads (${fromHot.length})`,
    fromWork.length > 0 && fromHot.length > 0 && fromWork.every((m) => /wklead/.test(m.to)) && fromHot.every((m) => /htlead/.test(m.to)));
  check('isolation: Regular accounts never sent a Work or Hot lead', fromReg.length > 0 && !fromReg.some((m) => /wklead|htlead/.test(m.to)));
  check('per-lane caps: Work cap 3, Hot cap 2, Regular cap 5 per account', fromWork.length === 3 && fromHot.length === 2
    && ACCOUNTS.every((a) => fromReg.filter((m) => m.account === a).length <= 5) && fromReg.length === 20, `${fromWork.length}/${fromHot.length}/${fromReg.length}`);
  const plainBad = [...fromWork, ...fromHot].filter((m) => { const raw = decode(m.raw);
    return !/Content-Type: text\/plain/i.test(raw) || /text\/html|multipart/i.test(raw) || /<img|<div|<br/i.test(raw) || /api\/l\?t=|api\/u\?t=|mailer-tracker/i.test(raw)
      || /List-Unsubscribe/i.test(raw) || /Zemenay Tech|Unsubscribe/i.test(raw) || m.mail.html !== undefined; });
  if (plainBad.length) (await import('node:fs')).writeFileSync('/tmp/bad-plain.eml', plainBad[0].raw);
  check(`plain-text MIME for all ${fromWork.length + fromHot.length} Work/Hot sends: text/plain only, no HTML part, no pixel/logo, no tracked or unsubscribe link, no List-Unsubscribe, no footer`, plainBad.length === 0, `${plainBad.length} bad`);
  const regBad = fromReg.filter((m) => { const raw = decode(m.raw);
    return !(/text\/html/.test(raw) && /api\/l\?t=[a-z0-9]{16}/.test(raw) && /api\/u\?t=[a-z0-9]{16}/.test(raw) && /List-Unsubscribe:/.test(m.raw) && /Zemenay Tech/.test(raw)); });
  check('Regular unchanged in the same run: HTML, tracked logo, unsubscribe link, List-Unsubscribe, footer', regBad.length === 0, `${regBad.length} bad`);
  const techSubj = R.fillTemplate(DEFAULT_TEMPLATES.tech.subject, R.withWording({ company: 'WK Firm 0', _segment: 'tech' }));
  check('per-lane templates: Work uses the Tech template, Hot its own template (plain body = template only)',
    fromWork.every((m) => m.subject === R.fillTemplate(DEFAULT_TEMPLATES.tech.subject, R.withWording({ ...R.parseCsv(leads('wk', 6)).rows.find((r) => r.email === m.to), _segment: 'tech' })))
    && fromHot.every((m) => /^Quick one for HT Firm \d$/.test(m.subject) && /^Hi Lee\d,\n\nShort note, plain and simple\.\n\nRafael M\n?$/.test(m.mail.text)), `${fromWork[0]?.subject} | ${techSubj} | ${JSON.stringify(fromHot[0]?.mail.text)}`);
  const lg = (await admin('log.list', { account: HOT, status: 'sent' })).json.items;
  const lb = (await admin('log.get', { id: lg[0].id })).json.body;
  check('log marks Hot sends lane:hot, plain, template "hot", body has no HTML', lg.length === 2 && lg.every((e) => e.lane === 'hot' && e.plain && e.templateId === 'hot') && lb.plain && lb.html === '');
  const recW = JSON.parse(await command('HGET', S.K.sent, fromWork[0].to));
  check('send record keeps the lane and marks touches plain (no open possible)', recW.lane === 'work' && recW.touches[0].plain === true && recW.account === WORK);
  const an = (await admin('analytics')).json;
  check('analytics: plain sends counted as untracked for open rates', an.totals.plainEmails === 5 && an.totals.trackedContacts === an.totals.contacts - 5, JSON.stringify(an.totals));
  const hl = (await admin('overview')).json.accounts;
  check('account health shows lane, plain flag and the lane cap', hl.find((a) => a.account === WORK).lane === 'work' && hl.find((a) => a.account === WORK).plainText && hl.find((a) => a.account === WORK).cap === 3
    && hl.find((a) => a.account === ACCOUNTS[0]).lane === 'regular' && hl.find((a) => a.account === ACCOUNTS[0]).cap === 5);

  // --- opt-out line (separate toggle, off by default)
  await admin('lanes.save', { lanes: { hot: { optOutLine: true } } });
  await admin('contacts.upload', { csv: leads('ho', 1), lane: 'hot' });
  const pvh = (await admin('lane.preview', { lane: 'hot' })).json;
  check('opt-out toggle adds one plain sentence (no link), still no HTML', pvh.plain && pvh.html === '' && pvh.text.endsWith(S.DEFAULT_OPTOUT) && !/https?:/.test(pvh.text));
  const pvw = (await admin('lane.preview', { lane: 'work', which: 'followup' })).json;
  check('lane.preview renders the Work follow-up as plain text', pvw.plain && pvw.templateId === 'followup' && !pvw.text.includes('Unsubscribe'));

  // --- cross-lane dedupe and shared suppression
  await admin('supp.import', { optout: ['optedout.person@nowhere.example'] });
  const rq = (await admin('queue.list')).json.items[0].email;
  const wq = (await admin('queue.list', { lane: 'work' })).json.items[0].email;
  const hx = await admin('contacts.upload', { lane: 'hot', csv: ['email,company,first_name,email_status', `${rq},X,Y,valid`, `${wq},X,Y,valid`, `${fromReg[0].to},X,Y,valid`, 'optedout.person@nowhere.example,X,Y,valid', 'info@rolebox.example,X,Y,valid'].join('\n') });
  const sk = hx.json.skipped;
  check('Hot upload skips someone queued in Regular / Work with a lane reason', sk['already in the Regular lane (queued)'] === 1 && sk['already in the Work lane (queued)'] === 1, JSON.stringify(sk));
  check('suppression and opt-outs apply to lanes (already emailed, opted out, role address)', hx.json.added === 0 && sk['already in the Regular lane (sent)'] === 1
    && sk['opted out / unsubscribed'] === 1 && sk['role address, not a named person'] === 1, JSON.stringify(sk));
  const hq = (await admin('queue.list', { lane: 'hot' })).json.items[0]?.email;
  const rx = await admin('contacts.upload', { csv: `email,company,email_status\n${hq},X,valid` });
  check('Regular upload skips a Hot lead ("already in the Hot lane")', rx.json.skipped['already in the Hot lane (queued)'] === 1 && rx.json.added === 0, JSON.stringify(rx.json.skipped));
  check('contacts.upload refuses an unknown lane', (await admin('contacts.upload', { csv: leads('zz', 1), lane: 'vip' })).status === 400);

  // --- moving the Work account out: its lane waits, nobody else picks it up
  await admin('account.lane', { account: WORK, lane: 'regular' });
  const wLeft = Number(await command('LLEN', S.K.queueOf('work')));
  const n2 = sim.sent.length;
  await day('2026-10-01');
  const d2 = sim.sent.slice(n2);
  check('Work lane with its account moved away: Work leads stay queued, none sent by anyone', wLeft === 3 && !d2.some((m) => /wklead/.test(m.to)) && Number(await command('LLEN', S.K.queueOf('work'))) === 3);
  check('the moved account now sends Regular contacts as HTML', d2.filter((m) => m.account === WORK).length > 0 && d2.filter((m) => m.account === WORK).every((m) => /rh|rg/.test(m.to) && m.mail.html));
  const stray = await E.sendItem({ id: 'x:1', date: '2026-10-01', account: ACCOUNTS[0], email: wq, template: 'tech', followUp: false, touch: 1, lane: 'work', at: EAT('2026-10-01', '12:00'), status: 'planned' }, { now: EAT('2026-10-01', '12:00'), today: '2026-10-01' });
  check('sendItem refuses a Work item on a Regular account (deferred, nothing sent)', stray.status === 'deferred' && /Regular lane/.test(stray.reason) && !sim.sent.some((m) => m.to === wq));
  await command('HDEL', S.K.plan('2026-10-01'), 'x:1');   // the hand-made item above, not a real plan entry
  await admin('account.lane', { account: WORK, lane: 'work' });

  // --- follow-ups a week later: same account, same lane, lane template, reply stops them
  const replier = fromWork[0].to;
  setImapFactory((account) => ({
    async connect() {}, async logout() {}, async getMailboxLock() { return { release() {} }; },
    async search() { return account === WORK ? [1] : []; },
    async *fetch() { if (account === WORK) yield { uid: 1, envelope: { from: [{ address: replier }], subject: 'Re: plain' }, internalDate: new Date(EAT('2026-10-02', '10:00')) }; },
    async fetchOne() { return null; },
  }));
  const scanW = await E.scanAccount(WORK, EAT('2026-10-07', '08:00'));
  check('IMAP finds a reply to a plain-text email (no token needed)', scanW.replies === 1, JSON.stringify(scanW));
  for (const a of [...ACCOUNTS, HOT]) await S.patchAccountState(a, { lastImapOkAt: EAT('2026-10-07', '08:00'), lastImapAt: EAT('2026-10-07', '08:00') });
  await admin('lanes.save', { lanes: { work: { cap: 10 }, hot: { cap: 10, optOutLine: false } } });
  const n3 = sim.sent.length;
  await day('2026-10-07');
  const d3 = sim.sent.slice(n3);
  const fuW = d3.filter((m) => fromWork.some((f) => f.to === m.to)), fuH = d3.filter((m) => fromHot.some((f) => f.to === m.to));
  check('Work follow-ups: from the Work account, not to the one who replied', fuW.length === 2 && fuW.every((m) => m.account === WORK) && !fuW.some((m) => m.to === replier), fuW.map((m) => m.to).join(' '));
  check('Hot follow-ups: from the Hot account with the Hot follow-up template, plain text', fuH.length === 2 && fuH.every((m) => m.account === HOT && /^Re: quick one for HT Firm/.test(m.subject) && !m.mail.html));
  const regFu = d3.filter((m) => fromReg.some((f) => f.to === m.to));
  check('Regular follow-ups unchanged: same account, shared follow-up template, HTML', regFu.length > 0 && regFu.every((m) => fromReg.find((f) => f.to === m.to).account === m.account && m.mail.html && /api\/l\?t=/.test(decode(m.raw))));
  const earlier = sim.sent.slice(0, n3);
  const fuAll = d3.filter((m) => earlier.some((x) => x.to === m.to));
  check(`every follow-up that day (${fuAll.length}) came from the account (and so the lane) of the first email`, fuAll.length >= 4
    && fuAll.every((m) => earlier.find((x) => x.to === m.to).account === m.account));

  // --- test buttons per lane (allowlist only)
  E.setRandom(mulberry(2718));
  const TA = ['michaelgetu21@gmail.com', 'michaelgetu07@gmail.com'];
  await saveSettings({ paused: true, testRecipients: TA });
  await admin('contacts.upload', { lane: 'hot', includeUnverified: true, csv: `email,company,first_name,email_status\n${TA[0]},[TEST] Hot Co,Michael,valid\n${TA[1]},[TEST] Hot Co 2,Mike,valid` });
  const tbr = (await admin('flow.testNow')).json;
  check('Regular test batch ignores Hot leads (even allowlisted ones)', tbr.lane === 'regular' && !tbr.assign.some((x) => TA.includes(x.email)));
  const tbh = (await admin('flow.testNow', { lane: 'hot' })).json;
  check('Hot test batch: allowlisted Hot leads, from the Hot account only', tbh.lane === 'hot' && tbh.plainText && tbh.assign.length === 1 && tbh.assign[0].account === HOT && TA.includes(tbh.assign[0].email) && tbh.waitingForNextClick.length === 1);
  const n4 = sim.sent.length;
  const tbs = (await admin('flow.testNow', { lane: 'hot', confirm: TA })).json;
  const sentT = sim.sent.slice(n4);
  check('Hot test batch sends 1 plain email from the Hot account while paused, nobody else', tbs.sent === 1 && sentT.length === 1 && sentT[0].account === HOT && TA.includes(sentT[0].to) && !sentT[0].mail.html && (await S.readSettings()).paused === true);
  const tfr = (await admin('flow.testFollowUp')).json;
  const tfh = (await admin('flow.testFollowUp', { lane: 'hot' })).json;
  check('test follow-up is per lane (Regular sees no Hot contact; Hot offers touch 2 from the Hot account)', !tfr.assign.some((x) => TA.includes(x.email))
    && tfh.assign.length === 1 && tfh.assign[0].account === HOT && tfh.assign[0].touch === 2, JSON.stringify(tfh.assign));
  setImapFactory(() => ({ async connect() {}, async logout() {}, async getMailboxLock() { return { release() {} }; }, async search() { return []; }, async *fetch() {}, async fetchOne() { return null; } }));
  const n5 = sim.sent.length;
  const tfs = (await admin('flow.testFollowUp', { lane: 'hot', confirm: TA })).json;
  const sentF = sim.sent.slice(n5);
  check('Hot test follow-up: Hot follow-up template, plain, from the Hot account', tfs.sent === 1 && sentF[0].account === HOT && /^Re: quick one for/.test(sentF[0].subject) && !sentF[0].mail.html);
  const tsw = await admin('test.send', { account: WORK, to: 'me@example.com', templateId: 'lane', dryRun: true });
  check('Test send from a Work account renders plain with the lane template', tsw.status === 200 && tsw.json.plain === true && tsw.json.lane === 'work', tsw.raw);

  // --- clearing one lane leaves the others, data.reset knows the lane queues
  const hBefore = Number(await command('LLEN', S.K.queueOf('hot'))), rBefore = Number(await command('LLEN', S.K.queue));
  const clr = (await admin('queue.clear', { lane: 'work' })).json;
  check('queue.clear for Work empties only the Work queue', clr.lane === 'work' && Number(await command('LLEN', S.K.queueOf('work'))) === 0
    && Number(await command('LLEN', S.K.queueOf('hot'))) === hBefore && Number(await command('LLEN', S.K.queue)) >= rBefore);
  const { classify } = await import('../api/_reset.js');
  check('data.reset treats the Work/Hot queues like the Regular queue (wiped, backed up)', classify('mailer:srv:queue:work') === 'wipe' && classify('mailer:srv:queue:hot') === 'wipe' && classify(S.K.settings) === 'keep');
  delete process.env.GMAIL_APP_PASSWORD_RAFAEL_WORK; delete process.env.GMAIL_APP_PASSWORD_RAFAEL_HOT;
}

// ============================================================ upload preview (dry run)
section('Upload preview: dryRun / contacts.preview use the real checks, write nothing, and match a real import');
await reset();
{
  // Every key and value in the database, to prove a dry run writes nothing.
  const snapshot = async () => {
    const keys = ((await command('KEYS', '*')) || []).sort();
    const out = {};
    for (const k of keys) {
      const t = await command('TYPE', k);
      out[k] = t === 'string' ? await command('GET', k) : t === 'hash' ? await command('HGETALL', k) : t === 'list' ? await command('LRANGE', k, 0, -1)
        : t === 'set' ? ((await command('SMEMBERS', k)) || []).sort() : t === 'zset' ? await command('ZRANGE', k, 0, -1, 'WITHSCORES') : t;
    }
    return JSON.stringify(out);
  };
  const sortObj = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));
  await saveSettings({ paused: true });
  await command('SADD', 'mailer:srv:optout', 'optout.person@clean.example');
  await command('SADD', 'mailer:ext:contacted', 'ext.person@clean.example');
  await command('HSET', 'leaddesk:state', 'desk.person@clean.example', '{"s":"taken"}');
  await command('HSET', S.K.sent, 'sent.before@clean.example', JSON.stringify({ email: 'sent.before@clean.example', firstSentAt: 1 }));
  await admin('contacts.upload', { csv: 'email,company,first_name,email_status\nqueued.already@clean.example,Q,Quinn,valid' });
  await admin('contacts.upload', { lane: 'work', csv: 'email,company,first_name,email_status\nwork.lead@clean.example,W,Wes,valid' });
  const csv = ['email,company,first_name,segment,vertical,email_status',
    'ann.tech@newco.example,New Tech,Ann,tech,,valid',
    'bob.dent@newdental.example,Bob Dental,Bob,,dental,valid',
    'cy.va@newva.example,Cy VA,Cy,Virtual assistants,,valid',
    'not-an-email,Bad,,,,valid',
    ',NoEmail,,,,valid',
    'ANN.tech@newco.example,Dupe,Ann,tech,,valid',
    'queued.already@clean.example,Q,Quinn,,,valid',
    'work.lead@clean.example,W,Wes,,,valid',
    'sent.before@clean.example,S,Sid,,,valid',
    'ext.person@clean.example,E,Ed,,,valid',
    'optout.person@clean.example,O,Olga,,,valid',
    `${SEED_EMAILS[0]},Seed,Sue,,,valid`,
    'desk.person@clean.example,D,Di,,,valid',
    'info@roleco.example,Role,,,,valid',
    'unverified.person@clean.example,U,Uma,,,unknown',
  ].join('\n');
  const before = await snapshot();
  const dry = await admin('contacts.upload', { csv, dryRun: true });
  const pv = await admin('contacts.preview', { csv });
  const after = await snapshot();
  check('dryRun and contacts.preview return 200', dry.status === 200 && pv.status === 200 && dry.json.dryRun === true && pv.json.dryRun === true, dry.raw);
  check('a dry run writes nothing (every key and value unchanged, pause still on)', before === after && (await S.readSettings()).paused === true);
  const d = dry.json;
  check('dry run counts: 3 would be added of 15 rows', d.added === 3 && d.rows === 15 && d.ok === true, JSON.stringify(d.skipped));
  check('dry run buckets: invalid 2, duplicate 1, existing 4, suppressed 3, role 1, unverified 1', d.byCategory.invalid === 2 && d.byCategory.duplicate === 1
    && d.byCategory.existing === 4 && d.byCategory.suppressed === 3 && d.byCategory.role === 1 && d.byCategory.unverified === 1, JSON.stringify(d.byCategory));
  check('dry run keeps the exact reasons (lane, sent before, seed list, Lead Desk)', d.skipped['already uploaded (queued)'] === 1 && d.skipped['already in the Work lane (queued)'] === 1
    && d.skipped['already emailed by the server'] === 1 && d.skipped['on the contacted-emails list'] === 1 && d.skipped['taken on the Lead Desk'] === 1, JSON.stringify(d.skipped));
  check('dry run per-segment counts (tech, callcenter, va) and lane', d.bySegment.tech === 1 && d.bySegment.callcenter === 1 && d.bySegment.va === 1
    && d.lane === 'regular' && d.laneLabel === 'Regular' && d.laneAccounts === 4 && d.paused === true, JSON.stringify(d.bySegment));
  check('dry run preview rows: first 10, each with its outcome', d.previewRows.length === 10 && d.previewRows[0].add === true && d.previewRows[0].segment === 'tech'
    && d.previewRows[3].category === 'invalid' && d.previewRows[5].category === 'duplicate' && d.previewRows[7].reason === 'already in the Work lane (queued)', JSON.stringify(d.previewRows.slice(0, 8).map((r) => r.reason || r.segment)));
  check('contacts.preview gives the same counts as dryRun', pv.json.added === d.added && sortObj(pv.json.skipped) === sortObj(d.skipped));
  const nBefore = Number(await command('HLEN', S.K.contacts));
  const real = await admin('contacts.upload', { csv });
  check('real import matches the dry run exactly (added, every skip reason, templates, placeholder warnings)', real.status === 200 && real.json.added === d.added
    && sortObj(real.json.skipped) === sortObj(d.skipped) && sortObj(real.json.byTemplate) === sortObj(d.byTemplate)
    && sortObj(real.json.placeholderWarnings) === sortObj(d.placeholderWarnings) && real.json.rows === d.rows, `${real.raw} vs ${JSON.stringify(d.skipped)}`);
  check('real import response keeps its old shape (no dry-run fields)', real.json.dryRun === undefined && real.json.previewRows === undefined && Array.isArray(real.json.samples));
  check('real import wrote the 3 contacts', Number(await command('HLEN', S.K.contacts)) === nBefore + 3 && Number(await command('LLEN', S.K.queue)) === 4);
  const dry2 = (await admin('contacts.preview', { csv })).json;
  check('a dry run after the import sees them as already uploaded', dry2.added === 0 && dry2.skipped['already uploaded (queued)'] === 4, JSON.stringify(dry2.skipped));

  // lanes: preview for Hot says Hot and flags people in other lanes
  const hot = (await admin('contacts.preview', { csv, lane: 'hot' })).json;
  check('Hot-lane dry run reports the Hot lane and skips Regular/Work contacts with the lane reason', hot.lane === 'hot' && hot.added === 0
    && hot.skipped['already in the Regular lane (queued)'] === 4 && hot.skipped['already in the Work lane (queued)'] === 1 && hot.laneAccounts === 0, JSON.stringify(hot.skipped));
  check('dry run refuses an unknown lane like the real upload', (await admin('contacts.preview', { csv, lane: 'vip' })).status === 400);

  // a lane whose template is empty is flagged in the preview
  await admin('lanes.save', { lanes: { hot: { template: 'custom', custom: { subject: '', body: '' } } } });
  const hot2 = (await admin('contacts.preview', { csv: 'email,company,first_name\nnew.hot@hotco.example,Hot Co,Hana', lane: 'hot' })).json;
  check('dry run warns when the matching template is empty', hot2.added === 1 && hot2.emptyTemplates.includes('hot') && hot2.byTemplate.hot === 1, JSON.stringify(hot2));

  // column mapping
  const odd = 'Email Address,First Name,Company Name,Hours Gap\nmapped.person@mapco.example,Mia,Map Co,closed Sundays\nsecond.person@mapco2.example,Max,Map Co 2,late nights';
  const noMap = (await admin('contacts.preview', { csv: odd })).json;
  check('dry run without an email column explains instead of failing, with a suggested mapping', noMap.ok === false && noMap.error === 'no email column'
    && noMap.suggestedMapping.email === 'email address' && noMap.suggestedMapping.first_name === 'first name' && noMap.suggestedMapping.company === 'company name'
    && noMap.suggestedMapping.hours_gap === 'hours gap', JSON.stringify(noMap.suggestedMapping));
  check('a real upload without an email column is still refused (400, unchanged)', (await admin('contacts.upload', { csv: odd })).status === 400);
  const auto = (await admin('contacts.preview', { csv: odd, mapping: 'auto' })).json;
  check('mapping "auto" applies the suggestion in a dry run', auto.ok === true && auto.added === 2 && auto.mappedHeaders.includes('email') && auto.previewRows[0].row.first_name === 'Mia', JSON.stringify(auto));
  const mapped = await admin('contacts.upload', { csv: odd, mapping: auto.mapping });
  const stored = JSON.parse(await command('HGET', S.K.contacts, 'mapped.person@mapco.example'));
  check('real upload with the same mapping adds the same rows, with renamed columns (and name filled)', mapped.json.added === auto.added
    && stored.row.first_name === 'Mia' && stored.row.company === 'Map Co' && stored.row.hours_gap === 'closed Sundays' && stored.row.name === 'Mia', JSON.stringify(stored));
  const pick = (await admin('contacts.preview', { csv: 'contact,who\npicked.person@pickco.example,Pia', mapping: { email: 'contact', first_name: 'who' } })).json;
  check('an explicit mapping picks any column as email', pick.ok === true && pick.added === 1 && pick.previewRows[0].row.first_name === 'Pia', JSON.stringify(pick));
  const two = (await admin('contacts.preview', { csv: 'Work Email,Company Name\nshared.col@twoco.example,Two Co', mapping: { email: 'work email', company: 'company name', name: 'company name' } })).json;
  check('one CSV column can feed two fields (company and name)', two.ok === true && two.added === 1 && two.previewRows[0].row.company === 'Two Co' && two.previewRows[0].row.name === 'Two Co'
    && two.mappedHeaders.includes('email') && two.mappedHeaders.includes('name'), JSON.stringify(two.mappedHeaders));

  // empty files, the lock, and the format description
  const emptyR = (await admin('contacts.preview', { csv: 'email,company\n' })).json;
  check('dry run of a header-only file reports it as empty', emptyR.ok === false && emptyR.error === 'empty' && emptyR.rows === 0, JSON.stringify(emptyR));
  const lockId = await E.acquireLock(30000);
  const locked = await admin('contacts.preview', { csv: 'email\nwhile.locked@lockco.example' });
  await E.releaseLock(lockId);
  check('a dry run does not wait for a running send (no lock needed, nothing written)', locked.status === 200 && locked.json.added === 1);
  const fmtR = (await admin('contacts.format')).json;
  check('contacts.format lists email as required and the real segments per lane', fmtR.columns[0].id === 'email' && fmtR.columns[0].required
    && fmtR.segments.map((s) => s.id).join() === 'callcenter,callcenter-generic,tech,va' && fmtR.segments[0].lanes.regular.template === 'callcenter'
    && fmtR.segments[0].lanes.hot.template === 'hot' && fmtR.segments[0].lanes.hot.ok === false && fmtR.maxRows === 5000, JSON.stringify(fmtR.segments[0]));
  check('contacts.format lists extra columns the templates use (e.g. hours_gap)', fmtR.templateColumns.includes('hours_gap'), JSON.stringify(fmtR.templateColumns));
  check('pause is still on after all of it', (await S.readSettings()).paused === true);
}

// ============================================================ replies + data.purge
section('Replies: All Mail, thread matches, auto-replies apart, the replies feed; data.purge deletes only named addresses');
await reset();
{
  E.setRandom(mulberry(77));
  const TESTERS = ['tess.one@ztest.example', 'tom.two@ztest.example', 'tia.three@ztest.example', 'ted.four@ztest.example'];
  const HEAD = 'email,company,first_name,last_name,vertical,hours_gap,email_status';
  const testerRow = (e, i) => `${e},Zemenay Tech,T${i},Tester,software agency,closed weekends,valid`;
  await admin('contacts.upload', { csv: `${makeCsv(6, { prefix: 'rp' })}\n${TESTERS.slice(0, 2).map(testerRow).join('\n')}` });
  await saveSettings({ paused: false, perAccountCap: 3 });
  const d1 = '2026-10-19';
  for (let t = EAT(d1, '08:55'); t <= EAT(d1, '18:00'); t += 60000) { sim.now = t; await E.tick({ now: t, scan: false }); }
  check('day 1: 6 prospects and 2 testers emailed', sim.sent.length === 8, String(sim.sent.length));
  const rec = async (e) => JSON.parse(await command('HGET', S.K.sent, e));
  const prospects = sim.sent.filter((m) => /rpperson/.test(m.to)).map((m) => m.to);
  const [A, B, C, D, Z] = prospects;
  const rA = await rec(A), rB = await rec(B), rC = await rec(C), rD = await rec(D), rT1 = await rec(TESTERS[0]);
  const inbox = {};
  const put = (account, m) => { const list = (inbox[account] ||= []); list.push({ uid: list.length + 1, ...m }); };
  const at = (hhmm) => new Date(EAT('2026-10-20', hhmm));
  const colleague = `colleague@${B.split('@')[1]}`;
  // A read and archived their reply's thread: it is only in All Mail.
  put(rA.account, { envelope: { from: [{ address: A }], subject: 'Re: quick question' }, internalDate: at('09:10') });
  put(rB.account, { envelope: { from: [{ address: colleague }], subject: 'Re: your note', inReplyTo: rB.touches[0].messageId }, internalDate: at('09:20') });
  put(rC.account, { envelope: { from: [{ address: C }], subject: 'Automatic reply: your note' }, headers: Buffer.from('Auto-Submitted: auto-replied\r\nX-Autoreply: yes\r\n\r\n'), internalDate: at('09:30') });
  put(rD.account, { envelope: { from: [{ address: D }], subject: 'Re: Out of office cover for us?' }, internalDate: at('09:40') });
  put(rT1.account, { envelope: { from: [{ address: TESTERS[0] }], subject: 'Re: test' }, internalDate: at('09:50') });
  // our own copy in the thread, and someone else's thread
  put(rB.account, { envelope: { from: [{ address: rB.account }], subject: 'Re: your note' }, headers: Buffer.from(`References: ${rB.touches[0].messageId}\r\n\r\n`), internalDate: at('10:00') });
  put(rB.account, { envelope: { from: [{ address: 'news@letter.example' }], subject: 'Weekly' }, headers: Buffer.from('References: <nothing-of-ours@x.example>\r\n\r\n'), internalDate: at('10:05') });
  const ALL = '[Gmail]/All Mail';
  const boxes = [], searches = [], queries = [];
  setImapFactory((account) => {
    let box = null;
    return {
      async connect() {}, async logout() {},
      async list() { return [{ path: 'INBOX', specialUse: '\\Inbox' }, { path: ALL, specialUse: '\\All' }, { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' }]; },
      async getMailboxLock(path) { box = path; boxes.push(path); return { release() {} }; },
      async search(q) { searches.push({ account, q }); return box === ALL ? (inbox[account] || []).map((m) => m.uid) : []; },
      async *fetch(uids, q) { queries.push(q); for (const m of inbox[account] || []) if (uids.includes(m.uid)) yield m; },
      async fetchOne() { return null; },
    };
  });
  const sc = (await admin('scan.all')).json;
  check('"Check inboxes now" scans every account: 4 replies and 1 auto-reply', sc.results.length === 4 && sc.replies === 4 && sc.autoReplies === 1 && sc.failed === 0, JSON.stringify(sc));
  check('it reads All Mail (found by its \\All flag), so archived replies count', boxes.length === 4 && boxes.every((b) => b === ALL));
  check('the search leaves out the account\'s own mail; reply headers come with the envelope', searches.every((x) => x.q.not?.from === x.account && x.q.since instanceof Date)
    && queries.every((q) => q.envelope && q.headers.includes('in-reply-to') && q.headers.includes('auto-submitted') && !q.source));
  const nA = await rec(A), nB = await rec(B), nC = await rec(C), nD = await rec(D);
  check('a reply from the recipient is recorded with its time and subject', nA.repliedAt === +at('09:10') && nA.replySubject === 'Re: quick question');
  check('a reply from another address in the thread (In-Reply-To) counts for the recipient', nB.repliedAt === +at('09:20') && nB.replyFrom === colleague);
  check('a person\'s reply that mentions "out of office" is still a reply', nD.repliedAt === +at('09:40') && !nD.autoReplyAt);
  check('an out-of-office is kept apart: not a reply, follow-up still due', !nC.repliedAt && nC.autoReplyAt === +at('09:30')
    && (await command('ZSCORE', S.K.fu, C)) !== null && (await command('ZSCORE', S.K.fu, A)) === null);
  check('our own copy and unrelated threads are not replies', !(await rec(Z)).repliedAt);
  const an = (await admin('analytics')).json;
  check('analytics: 4 replied, 1 auto-reply outside the reply rate', an.totals.replied === 4 && an.totals.autoReplied === 1, JSON.stringify(an.totals));
  const rl = (await admin('replies.list')).json;
  check('replies.list: who, when, account, template, touch, subject; newest first', rl.items.length === 4 && rl.total === 4
    && rl.items.map((x) => x.email).join() === [TESTERS[0], D, B, A].join()
    && rl.items.every((x) => x.at && x.account && x.template && x.touch === 1 && x.sentAt && x.subject && x.company && !x.auto)
    && rl.items.find((x) => x.email === B).from === colleague, JSON.stringify(rl.items[0]));
  const auto = (await admin('replies.list', { kind: 'auto' })).json;
  check('replies.list kind "auto" lists the out-of-office', auto.items.length === 1 && auto.items[0].email === C && auto.items[0].auto === true);
  check('replies.list search', (await admin('replies.list', { q: 'colleague' })).json.items.map((x) => x.email).join() === B);
  const lt = (await admin('replies.latest')).json;
  const ov = (await admin('overview')).json;
  check('replies.latest and overview carry the newest reply time (the "new replies" badge)', lt.lastReplyAt === +at('09:50') && ov.lastReplyAt === +at('09:50') && lt.items.length === 5);
  const logAll = (await admin('log.list', { limit: 200 })).json.items;
  check('the send log has each reply and the auto-reply', logAll.filter((e) => e.status === 'replied').length === 4 && logAll.filter((e) => e.status === 'auto-reply').length === 1);
  const again = (await admin('scan.all')).json;
  check('scanning again records nothing twice', again.replies === 0 && again.autoReplies === 0);
  for (const a of ACCOUNTS) await S.patchAccountState(a, { lastImapAt: 0 });
  const tk = await E.tick({ now: EAT('2026-10-20', '19:00') });
  check('one tick checks every inbox that is due, not just one', tk.scans?.length === 4 && tk.scan === tk.scans[0], JSON.stringify(tk.notes));
  const rdry = (await admin('data.reset')).json;
  check('data.reset knows the replies feed and badge keys', rdry.wipe.includes('mailer:srv:replies') && rdry.wipe.includes('mailer:srv:lastReplyAt') && !rdry.unknown.length, JSON.stringify(rdry.unknown));

  // --- a test dataset: testers sent, replied, opened, unsubscribed, test-sent, planned and queued
  const [T1, T2, T3, T4] = TESTERS;
  const t2 = await rec(T2);
  await command('HSET', 'mailer:opens', rT1.touches[0].t, JSON.stringify([[+at('09:00'), 'gmail']]), rA.touches[0].t, JSON.stringify([[+at('09:01'), 'gmail']]));
  await command('HSET', 'mailer:unsub', t2.touches[0].t, String(+at('09:05')));
  await SUP.syncUnsubscribes();
  const ts = await admin('test.send', { account: ACCOUNTS[0], to: T2 });
  const testTok = (await admin('log.list', { q: T2 })).json.items.find((e) => e.status === 'test')?.token;
  await command('HSET', 'mailer:opens', testTok, JSON.stringify([[+at('11:00'), 'gmail']]));
  // T3 into the Regular lane (planned below); T4 into Work, which has no account here, so it stays queued.
  await admin('contacts.upload', { csv: `${HEAD}\n${testerRow(T3, 3)}` });
  await admin('contacts.upload', { csv: `${HEAD}\n${testerRow(T4, 4)}`, lane: 'work' });
  await E.ensurePlan('2026-10-21', { now: EAT('2026-10-20', '20:00') });
  const planned = await E.readPlan('2026-10-21');
  check('purge setup: testers sent, replied, unsubscribed, test-sent, planned and queued', ts.status === 200 && Boolean(testTok)
    && planned.items.some((i) => i.email === T3) && (await command('LRANGE', S.K.queueOf('work'), 0, -1)).includes(T4)
    && Number(await command('SISMEMBER', S.K.optout, T2)) === 1, JSON.stringify({ ts: ts.status, testTok, planned: planned.items.map((i) => i.email) }));

  const dumpAll = async () => {
    const out = {};
    for (const k of ((await command('KEYS', 'mailer:*')) || []).sort()) {
      const type = await command('TYPE', k);
      const pairs = (flat) => { const o = []; for (let i = 0; i < (flat || []).length; i += 2) o.push([flat[i], flat[i + 1]]); return o.sort((x, y) => (x[0] < y[0] ? -1 : 1)); };
      out[k] = type === 'hash' ? pairs(await command('HGETALL', k)) : type === 'list' ? await command('LRANGE', k, 0, -1)
        : type === 'set' ? ((await command('SMEMBERS', k)) || []).sort() : type === 'zset' ? await command('ZRANGE', k, 0, -1, 'WITHSCORES') : await command('GET', k);
    }
    return out;
  };
  const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  check('data.purge needs the admin password', (await call(handlers.admin, { method: 'POST', body: { action: 'data.purge', emails: [T1], confirm: 'DELETE' } })).status === 401);
  check('data.purge refuses a bad address and more than 100', (await admin('data.purge', { emails: ['not-an-email'] })).status === 400
    && (await admin('data.purge', { emails: Array.from({ length: 101 }, (_, i) => `x${i}@y.example`) })).status === 400);
  const before = await dumpAll();
  const dry = (await admin('data.purge', { emails: `${TESTERS.join('\n')}\nnobody@nowhere.example` })).json;
  const wrong = (await admin('data.purge', { emails: TESTERS, confirm: 'yes' })).json;
  const diff = changed(before, await dumpAll());
  check('without confirm "DELETE" data.purge is a dry run that changes nothing', dry.dryRun === true && wrong.dryRun === true && !diff.length, diff.join(', '));
  const row = (e) => dry.rows.find((r) => r.email === e);
  check('the dry run says what it found per address', dry.totals.found === 4 && !row('nobody@nowhere.example').found
    && row(T1).sent?.repliedAt && row(T1).replies === 1 && row(T1).opens === 1 && row(T2).optout === true && row(T2).logEntries >= 2 && row(T2).opens === 1 && row(T2).unsubscribes === 1
    && row(T3).planned === 1 && row(T4).queued === 1 && row(T4).contact?.status === 'queued' && row(T4).contact?.lane === 'work', JSON.stringify(dry.rows));

  const openA = await command('HGET', 'mailer:opens', rA.touches[0].t);
  const logOthers = (await command('LRANGE', S.K.log, 0, -1)).filter((j) => !TESTERS.includes(JSON.parse(j).to));
  const p = (await admin('data.purge', { emails: TESTERS, confirm: 'DELETE' })).json;
  check('data.purge runs and names its backup', p.ok && /^mailer:backup:purge:/.test(p.backupKey) && p.deleted.length === 4, JSON.stringify(p).slice(0, 300));
  const bk = JSON.parse(await command('HGET', p.backupKey, T1));
  check('the backup holds each address\'s records, read back before deleting', JSON.parse(bk.sent).repliedAt && bk.log.length >= 1 && Object.keys(bk.opens).length === 1
    && Number(await command('TTL', p.backupKey)) > 0 && JSON.parse(await command('HGET', p.backupKey, '_meta')).addresses.length === 4);
  const leftovers = [];
  const has = (label, cond) => { if (cond) leftovers.push(label); };
  for (const e of TESTERS) {
    has(`${e} contact`, await command('HGET', S.K.contacts, e));
    has(`${e} sent`, await command('HGET', S.K.sent, e));
    has(`${e} fu`, (await command('ZSCORE', S.K.fu, e)) !== null);
    for (const k of (await command('KEYS', 'mailer:srv:byacct:*')) || []) has(`${e} ${k}`, (await command('ZSCORE', k, e)) !== null);
    for (const k of (await command('KEYS', 'mailer:srv:recent:*')) || []) has(`${e} ${k}`, ((await command('LRANGE', k, 0, -1)) || []).includes(e));
    for (const l of ['mailer:srv:queue', 'mailer:srv:queue:work', 'mailer:srv:queue:hot']) has(`${e} ${l}`, ((await command('LRANGE', l, 0, -1)) || []).includes(e));
    for (const k of (await command('KEYS', 'mailer:srv:plan:*')) || []) has(`${e} ${k}`, ((await command('HVALS', k)) || []).some((v) => v.includes(`"${e}"`)));
    has(`${e} guard`, ((await command('HKEYS', S.K.touch)) || []).some((f) => f.startsWith(`${e}#`)));
    has(`${e} token`, ((await command('HVALS', S.K.tokens)) || []).includes(e));
    has(`${e} log`, ((await command('LRANGE', S.K.log, 0, -1)) || []).some((j) => JSON.parse(j).to === e));
    has(`${e} feed`, ((await command('LRANGE', S.K.replies, 0, -1)) || []).some((j) => JSON.parse(j).email === e));
  }
  for (const t of [rT1.touches[0].t, testTok]) has(`open ${t}`, Number(await command('HEXISTS', 'mailer:opens', t)));
  has('unsub', Number(await command('HEXISTS', 'mailer:unsub', t2.touches[0].t)));
  check('no trace of the test addresses is left', leftovers.length === 0, leftovers.join(', '));
  const logAfter = await command('LRANGE', S.K.log, 0, -1);
  check('everyone else is untouched: records, replies, opens, log', (await rec(A)).repliedAt === +at('09:10') && Boolean(await rec(Z))
    && openA === (await command('HGET', 'mailer:opens', rA.touches[0].t)) && JSON.stringify(logAfter) === JSON.stringify(logOthers));
  const an2 = (await admin('analytics')).json;
  const rl2 = (await admin('replies.list')).json;
  check('the rates now cover the real prospects only', an2.totals.contacts === 6 && an2.totals.replied === 3 && an2.totals.autoReplied === 1 && rl2.items.length === 3
    && !rl2.items.some((x) => TESTERS.includes(x.email)), JSON.stringify(an2.totals));
  check('an unsubscribed tester stays on the opt-out list by default', Number(await command('SISMEMBER', S.K.optout, T2)) === 1 && (await command('GET', S.K.unsubSeen)) === null);
  const again2 = (await admin('data.purge', { emails: [T2], confirm: 'DELETE', alsoOptout: true })).json;
  check('alsoOptout takes a tester off the opt-out list', again2.deleted.join() === T2 && Number(await command('SISMEMBER', S.K.optout, T2)) === 0);
  const re = (await admin('contacts.upload', { csv: `${HEAD}\n${TESTERS.map(testerRow).join('\n')}` })).json;
  check('purged test addresses can be uploaded again', re.added === 4, JSON.stringify(re).slice(0, 200));
  await SUP.syncUnsubscribes();
  check('the unsubscribe re-map after a purge adds nobody back', Number(await command('SISMEMBER', S.K.optout, T2)) === 0);
  setImapFactory(() => ({ async connect() {}, async logout() {}, async getMailboxLock() { return { release() {} }; }, async search() { return []; }, async *fetch() {}, async fetchOne() { return null; } }));
  await saveSettings({ paused: true });
}

// ============================================================ per-contact lines + updating queued contacts
section('Per-contact subject_line / opening_line, and re-uploads that update queued contacts');
await reset();
{
  E.setRandom(mulberry(91));
  await saveSettings({ personalLines: true });
  const HEAD = 'email,company,first_name,last_name,vertical,hours_gap,email_status';
  const base = [
    'ana.one@pcone.example,PC One,Ana,One,software agency,closed weekends,valid',
    'ben.two@pctwo.example,PC Two,Ben,Two,dental,closed weekends,valid',
    'cal.three@pcthree.example,PC Three,Cal,Three,dental,closed weekends,valid',
  ];
  await admin('contacts.upload', { csv: `${HEAD}\n${base.join('\n')}` });
  // Cal was already emailed by the server: never updated.
  await command('HSET', S.K.sent, 'cal.three@pcthree.example', JSON.stringify({ email: 'cal.three@pcthree.example', account: ACCOUNTS[0], touches: [{ at: 1, n: 1, t: 'caltoken000000001' }], firstSentAt: 1 }));
  const HEAD2 = 'email,subject_line,opening_line,hours_gap';
  const upd = [
    'ana.one@pcone.example,"Ana, the PC One origin story","Loved the story on your About page about starting PC One in a garage.",',
    'ben.two@pctwo.example,"Ben, 40 years of smiles",,',
    'cal.three@pcthree.example,"Cal, hello",Opener,',
  ].join('\n');
  const queueBefore = await command('LRANGE', S.K.queue, 0, -1);
  const contactsBefore = await command('HGETALL', S.K.contacts);
  const plain = (await admin('contacts.preview', { csv: `${HEAD2}\n${upd}` })).json;
  check('without updateExisting a re-upload still skips them as already uploaded', plain.added === 0 && plain.updated === undefined
    && plain.skipped['already uploaded (queued)'] === 3, JSON.stringify(plain.skipped));
  const dry = (await admin('contacts.preview', { csv: `${HEAD2}\n${upd}`, updateExisting: true })).json;
  check('updateExisting dry run: 2 to update, the emailed one left alone, nothing written', dry.updated === 2 && dry.added === 0
    && dry.skipped['already emailed, not updated'] === 1 && dry.updatedColumns.join() === 'opening_line,subject_line'
    && dry.previewRows[0].update === true && JSON.stringify(await command('HGETALL', S.K.contacts)) === JSON.stringify(contactsBefore), JSON.stringify(dry).slice(0, 400));
  const real = (await admin('contacts.upload', { csv: `${HEAD2}\n${upd}`, updateExisting: true })).json;
  const ana = JSON.parse(await command('HGET', S.K.contacts, 'ana.one@pcone.example'));
  const ben = JSON.parse(await command('HGET', S.K.contacts, 'ben.two@pctwo.example'));
  check('the update merges the new columns into the queued contacts and keeps the rest', real.updated === 2 && ana.status === 'queued'
    && ana.row.subject_line === 'Ana, the PC One origin story' && ana.row.company === 'PC One' && ana.row.hours_gap === 'closed weekends'
    && ben.row.subject_line === 'Ben, 40 years of smiles' && ben.row.opening_line === undefined, JSON.stringify({ ana, ben }).slice(0, 400));
  check('the queue is unchanged (no duplicates) and a blank cell never erases', JSON.stringify(await command('LRANGE', S.K.queue, 0, -1)) === JSON.stringify(queueBefore)
    && ana.row.hours_gap === 'closed weekends');
  const again = (await admin('contacts.preview', { csv: `${HEAD2}\n${upd}`, updateExisting: true })).json;
  check('re-running the same update finds nothing new', again.updated === 0 && again.skipped['already uploaded, nothing new in this file'] === 2);

  // A send uses them.
  await saveSettings({ paused: false, perAccountCap: 3 });
  const d = '2026-10-26';
  for (let t = EAT(d, '08:55'); t <= EAT(d, '18:00'); t += 60000) { sim.now = t; await E.tick({ now: t, scan: false }); }
  const toAna = sim.sent.find((m) => m.to === 'ana.one@pcone.example'), toBen = sim.sent.find((m) => m.to === 'ben.two@pctwo.example');
  check('subject_line replaces the template subject on the first email', toAna?.subject === 'Ana, the PC One origin story' && toBen?.subject === 'Ben, 40 years of smiles', `${toAna?.subject} | ${toBen?.subject}`);
  check('opening_line goes right after the greeting; no opener, no gap', /^Hi PC One team,\n\nLoved the story on your About page about starting PC One in a garage\.\n\n\S/.test(toAna?.mail.text || '')
    && /^Hi PC Two team,\n\n[^\n]/.test(toBen?.mail.text || '') && toAna.mail.html.includes('Loved the story on your About page'), (toAna?.mail.text || '').slice(0, 160));
  const r = R.personalise({ subject: 's {{company}}', body: 'Hi {{company}} team,\n\nX' }, { subject_line: 'S', opening_line: 'O' }, 'followup');
  check('follow-ups keep their own subject and body', r.subject === 's {{company}}' && r.body === 'Hi {{company}} team,\n\nX');
  const t2 = { subject: 'x', body: 'Hi,\n\n{{opening_line}}\n\nRest' };
  check('{{opening_line}} in a template: filled where placed, removed cleanly when a contact has none',
    R.personalise(t2, { opening_line: 'O' }, 'tech').body === t2.body && R.personalise(t2, {}, 'tech').body === 'Hi,\n\nRest');
  await saveSettings({ paused: true });
}

// ============================================================ seeing personalisation and its impact
section('Personal lines in the queue, the plan and a per-contact preview; personalised vs standard impact');
await reset();
{
  E.setRandom(mulberry(93));
  await saveSettings({ personalLines: true });
  const HEAD = 'email,company,first_name,last_name,vertical,hours_gap,email_status,subject_line,opening_line';
  const rowsCsv = [
    'pa.one@pzone.example,PZ One,Pa,One,dental,closed weekends,valid,"Pa, 40 years of PZ One",Loved the story on your About page.',
    'pb.two@pztwo.example,PZ Two,Pb,Two,dental,closed weekends,valid,"Pb, a quick one",',
    'sc.three@stthree.example,ST Three,Sc,Three,dental,closed weekends,valid,,',
    'sd.four@stfour.example,ST Four,Sd,Four,dental,closed weekends,valid,,',
  ];
  await admin('contacts.upload', { csv: `${HEAD}\n${rowsCsv.join('\n')}` });
  const q = (await admin('queue.list')).json;
  check('queue.list counts personalised and standard contacts', q.total === 4 && q.personal === 2 && q.standard === 2 && q.matched === 4, JSON.stringify(q).slice(0, 200));
  const qa = q.items.find((x) => x.email === 'pa.one@pzone.example');
  check('queue items carry their subject and opening line', qa.subjectLine === 'Pa, 40 years of PZ One' && qa.openingLine === 'Loved the story on your About page.'
    && q.items.find((x) => x.email === 'sc.three@stthree.example').subjectLine === '' && qa.position >= 1);
  const qp = (await admin('queue.list', { filter: 'personal' })).json, qs = (await admin('queue.list', { filter: 'standard' })).json;
  check('the queue filters to personalised or standard only', qp.items.length === 2 && qp.items.every((x) => x.subjectLine) && qs.items.length === 2 && qs.items.every((x) => !x.subjectLine && !x.openingLine)
    && qp.total === 4 && qp.personal === 2);
  const pv = (await admin('contact.preview', { email: 'PA.ONE@pzone.example' })).json;
  check('contact.preview renders the exact first email: personal subject, opener after the greeting', pv.subject === 'Pa, 40 years of PZ One'
    && /^Hi PZ One team,\n\nLoved the story on your About page\.\n\n/.test(pv.text) && pv.personal?.subject && pv.personal?.opener && pv.html.includes('Loved the story')
    && pv.templateId && pv.account && pv.status === 'queued', JSON.stringify(pv).slice(0, 300));
  const pvs = (await admin('contact.preview', { email: 'sc.three@stthree.example' })).json;
  check('a standard contact previews with the template subject and no personal flag', !pvs.personal && !/Pa, 40/.test(pvs.subject) && pvs.subject.includes('ST Three'));
  check('contact.preview of an unknown address is a 404 and needs the password', (await admin('contact.preview', { email: 'nobody@x.example' })).status === 404
    && (await call(handlers.admin, { method: 'POST', body: { action: 'contact.preview', email: 'pa.one@pzone.example' } })).status === 401);
  const logBefore = await command('LLEN', S.K.log);
  const opensBefore = await command('HLEN', 'mailer:opens');
  check('a preview records nothing (no log entry, no token, no open)', (await command('LLEN', S.K.log)) === logBefore && (await command('HLEN', 'mailer:opens')) === opensBefore
    && !(await command('HEXISTS', S.K.tokens, 'preview0000000')));

  // plan: the lines show on planned items, and a planned contact previews on its planned account and time
  const d = '2026-11-02';
  await saveSettings({ paused: false, perAccountCap: 2 });
  const plan = await E.ensurePlan(d, { now: EAT('2026-11-01', '20:00') });
  const pg = (await admin('plan.get', { date: d })).json.plan;
  const pa = pg.items.find((i) => i.email === 'pa.one@pzone.example');
  check('plan.get shows each first email\'s personal lines', pa?.subjectLine === 'Pa, 40 years of PZ One' && pg.items.find((i) => i.email === 'sd.four@stfour.example')?.subjectLine === '', JSON.stringify(pg.items).slice(0, 300));
  const pvp = (await admin('contact.preview', { email: 'pa.one@pzone.example' })).json;
  check('a planned contact previews on the account and time it is planned for', pvp.account === pa.account && pvp.at === pa.at && plan.items.length === 4);

  // send the day: personalised emails are flagged on the send record and in the log
  for (let t = EAT(d, '08:55'); t <= EAT(d, '18:00'); t += 60000) { sim.now = t; await E.tick({ now: t, scan: false }); }
  const rec = async (e) => JSON.parse(await command('HGET', S.K.sent, e));
  const ra = await rec('pa.one@pzone.example'), rb = await rec('pb.two@pztwo.example'), rc = await rec('sc.three@stthree.example');
  check('the send record marks personalised first emails', ra.touches[0].personal === true && rb.touches[0].personal === true && !rc.touches[0].personal);
  const logs = (await admin('log.list', { limit: 50 })).json.items.filter((x) => x.status === 'sent');
  check('the send log marks personalised emails', logs.find((x) => x.to === 'pa.one@pzone.example')?.personal === true && !logs.find((x) => x.to === 'sc.three@stthree.example')?.personal);

  // impact: open for pa and sc, reply from pa
  await command('HSET', 'mailer:opens', ra.touches[0].t, JSON.stringify([[EAT(d, '15:00'), 'gmail']]), rc.touches[0].t, JSON.stringify([[EAT(d, '16:00'), 'gmail']]));
  const acct = ra.account;
  setImapFactory(() => ({ async connect() {}, async logout() {}, async getMailboxLock() { return { release() {} }; },
    async search() { return [1]; }, async *fetch() { yield { uid: 1, envelope: { from: [{ address: 'pa.one@pzone.example' }], subject: 'Re: yes please' }, internalDate: new Date(EAT('2026-11-03', '10:00')) }; },
    async fetchOne() { return null; } }));
  await E.scanAccount(acct, EAT('2026-11-03', '12:00'));
  setImapFactory(() => ({ async connect() {}, async logout() {}, async getMailboxLock() { return { release() {} }; }, async search() { return []; }, async *fetch() {}, async fetchOne() { return null; } }));
  const an = (await admin('analytics')).json;
  const P = an.personalisation;
  check('analytics splits personalised vs standard contacts', P.personal.contacts === 2 && P.standard.contacts === 2 && P.personal.opened === 1 && P.standard.opened === 1
    && P.personal.replied === 1 && P.standard.replied === 0 && P.personal.tracked === 2 && P.since === Math.min(ra.touches[0].at, rb.touches[0].at), JSON.stringify(P));
  const rd = await rec('sd.four@stfour.example');
  check('the same-period standard group counts standard contacts emailed since the first personalised email',
    P.standardSamePeriod.contacts === [rc, rd].filter((x) => x.touches[0].at >= P.since).length, JSON.stringify(P.standardSamePeriod));
  const rl = (await admin('replies.list')).json.items;
  check('replies say whether the email they answered was personalised', rl.find((x) => x.email === 'pa.one@pzone.example')?.personal === true);
  await saveSettings({ paused: true });
}

// ============================================================ personal lines off (the default)
section('The CSV\'s own subject/opening lines are off by default: first emails use the category template');
await reset();
{
  E.setRandom(mulberry(95));
  check('personal lines are off by default', (await S.readSettings()).personalLines === false);
  const NAMES = { [ACCOUNTS[0]]: 'Daniel', [ACCOUNTS[1]]: 'Brook', [ACCOUNTS[2]]: 'Berry', [ACCOUNTS[3]]: 'Noah' };
  await call(handlers.config, { method: 'PUT', headers: { 'x-admin-password': 'admin-test-pw' }, body: { senders: NAMES } });
  const HEAD = 'email,company,first_name,last_name,vertical,hours_gap,email_status,subject_line,opening_line';
  await admin('contacts.upload', { csv: `${HEAD}\npo.one@poone.example,PO One,Po,One,dental,closed weekends,valid,"Po, a special subject",A special opener.` });
  const TPL_SUBJECT = "who's answering when PO One is closed weekends?";
  const q = (await admin('queue.list')).json;
  check('switch off: the queue counts nobody as personalised and shows no personal lines', q.personal === 0 && q.standard === 1 && q.personalLinesOn === false
    && q.items[0].subjectLine === '' && q.items[0].openingLine === '', JSON.stringify(q).slice(0, 300));
  const pv = (await admin('contact.preview', { email: 'po.one@poone.example' })).json;
  check('switch off: the preview is the category template', !pv.personal && pv.templateId === 'callcenter' && pv.subject === TPL_SUBJECT
    && !pv.text.includes('special opener') && pv.text.includes(`\n${NAMES[pv.account]}\nZemenay`), JSON.stringify(pv).slice(0, 300));
  await saveSettings({ personalLines: true });
  const on = (await admin('contact.preview', { email: 'po.one@poone.example' })).json;
  check('switch on: the same contact previews with its own lines again', on.subject === 'Po, a special subject' && on.text.includes('A special opener.'));
  await saveSettings({ personalLines: false });

  await saveSettings({ paused: false, perAccountCap: 2 });
  const d = '2026-11-09';
  for (let t = EAT(d, '08:55'); t <= EAT(d, '18:00'); t += 60000) { sim.now = t; await E.tick({ now: t, scan: false }); }
  const sent = sim.sent.find((m) => m.to === 'po.one@poone.example');
  check('switch off: the send uses the category template with no opener, from and signed by the account\'s own name',
    sent?.subject === TPL_SUBJECT && !/special opener/.test(sent?.mail.text || '') && sent?.mail.from?.name === NAMES[sent?.account]
    && sent?.mail.text.includes(`\n${NAMES[sent?.account]}\nZemenay`), `${JSON.stringify(sent?.mail.from)} ${sent?.subject}`);
  const rec = JSON.parse(await command('HGET', S.K.sent, 'po.one@poone.example'));
  const stored = JSON.parse(await command('HGET', S.K.contacts, 'po.one@poone.example'));
  check('switch off: the send is not marked personalised; the stored row keeps its lines', !rec.touches[0].personal && stored.row.subject_line === 'Po, a special subject');
  await saveSettings({ paused: true });

  // Sender names: used exactly as set, company and all.
  check('fromHeader: the name exactly as set (trimmed); no name, just the address',
    JSON.stringify(E.fromHeader(' Dawit @ ZemenayTech ', 'b@x.example')) === JSON.stringify({ name: 'Dawit @ ZemenayTech', address: 'b@x.example' })
    && E.fromHeader('Noah', 'n@x.example').name === 'Noah' && E.fromHeader('', 'b@x.example') === 'b@x.example' && E.fromHeader('  ', 'b@x.example') === 'b@x.example');
  await call(handlers.config, { method: 'PUT', headers: { 'x-admin-password': 'admin-test-pw' }, body: { senders: { ...NAMES, [ACCOUNTS[2]]: 'Dawit @ ZemenayTech' } } });
  const n0 = sim.sent.length;
  const ts = await admin('test.send', { account: ACCOUNTS[2], to: 'michaelgetu21@gmail.com', templateId: 'callcenter' });
  const tm = sim.sent[n0];
  check('a name saved as "Dawit @ ZemenayTech" stays exactly that: From name and {{sender_name}}', ts.status === 200 && tm?.mail.from?.name === 'Dawit @ ZemenayTech'
    && /^From: "Dawit @ ZemenayTech" <berryydaniel@gmail\.com>$/m.test(tm?.raw || '') && tm?.mail.text.includes('\nDawit @ ZemenayTech\nZemenay'), `${JSON.stringify(tm?.mail.from)} ${(tm?.raw || '').match(/^From:.*$/m)} ${ts.raw}`);

  // Nicknames: saved per account, served to the extension, and filled into {{nick_name}}.
  const cfgNow = (await call(handlers.config, { headers: { 'x-team-key': 'team-test-key' } })).json;
  const nickTemplates = { ...cfgNow.templates, callcenter: { subject: '{{company}}: a quick one', body: 'Hi {{company}} team,\n\nHey, this is {{nick_name}} from Zemenay.\n\n{{sender_name}}' } };
  const pn = await call(handlers.config, { method: 'PUT', headers: { 'x-admin-password': 'admin-test-pw' },
    body: { templates: nickTemplates, nicknames: { [ACCOUNTS[0].toUpperCase()]: '  Danny ', [ACCOUNTS[1]]: '', 'stranger@x.example': 'Nope' } } });
  const gn = (await call(handlers.config, { headers: { 'x-team-key': 'team-test-key' } })).json;
  check('nicknames are saved for known accounts only, trimmed, empty ones dropped, and served to the extension', pn.status === 200
    && JSON.stringify(gn.nicknames) === JSON.stringify({ [ACCOUNTS[0]]: 'Danny' }) && gn.senders[ACCOUNTS[0]] === 'Daniel', JSON.stringify(gn.nicknames));
  const keepNick = await call(handlers.config, { method: 'PUT', headers: { 'x-admin-password': 'admin-test-pw' }, body: { dailyLimit: 12 } });
  check('a save without nicknames keeps them', keepNick.json.nicknames[ACCOUNTS[0]] === 'Danny');
  const n1 = sim.sent.length;
  await admin('test.send', { account: ACCOUNTS[0], to: 'michaelgetu21@gmail.com', templateId: 'callcenter' });
  await admin('test.send', { account: ACCOUNTS[1], to: 'michaelgetu21@gmail.com', templateId: 'callcenter' });
  const [withNick, noNick] = [sim.sent[n1], sim.sent[n1 + 1]];
  check('{{nick_name}} is the nickname where one is set, else the account\'s name', /Hey, this is Danny from Zemenay\.\n\nDaniel/.test(withNick?.mail.text || '')
    && withNick?.mail.from?.name === 'Daniel' && /Hey, this is Brook from Zemenay\.\n\nBrook/.test(noNick?.mail.text || ''), `${withNick?.mail.text?.slice(0, 120)} | ${noNick?.mail.text?.slice(0, 120)}`);
  const pvn = (await admin('preview', { templateId: 'callcenter', account: ACCOUNTS[0] })).json;
  check('the template preview fills {{nick_name}} with no placeholder warning', /Hey, this is Danny/.test(pvn.text) && pvn.problems.ok, JSON.stringify(pvn.problems));
}

// ============================================================ categories switched off (Virtual assistants by default)
section('Categories switched off: Virtual assistants gets no emails by default; switching it back on resumes');
{
  await shim.flush();                         // no saved settings: the defaults
  sim.sent = []; sim.behaviour = {};
  E.setRandom(mulberry(97));
  check('Virtual assistants is switched off by default', JSON.stringify((await S.readSettings()).skipTemplates) === '["va"]');
  const HEAD = 'email,company,first_name,vertical,hours_gap,email_status';
  await admin('contacts.upload', { csv: [HEAD, 'va.one@vaone.example,VA One,Vi,accounting,,valid', 'cc.one@ccone.example,CC One,Cy,dental,closed weekends,valid',
    'va.two@vatwo.example,VA Two,Vo,hotel,,valid', 'cc.two@cctwo.example,CC Two,Ce,dental,closed weekends,valid'].join('\n') });
  // someone already emailed with the Virtual assistants template, due a follow-up
  const FU = 'va.old@vaold.example', old = EAT('2026-10-01', '10:00');
  await command('HSET', S.K.sent, FU, JSON.stringify({ email: FU, account: ACCOUNTS[0], company: 'VA Old', touches: [{ at: old, n: 1, t: 'vaoldtoken000001', template: 'va' }], firstSentAt: old, lastSentAt: old }));
  await command('ZADD', S.K.fu, old, FU);
  const q = (await admin('queue.list')).json;
  check('the queue marks Virtual assistants contacts as not sent', q.items.filter((x) => x.off).map((x) => x.email).join() === 'va.one@vaone.example,va.two@vatwo.example'
    && q.items[0].off === 'Virtual assistants emails are switched off' && !q.items[1].off, JSON.stringify(q.items));
  await saveSettings({ testRecipients: ['va.two@vatwo.example', 'cc.two@cctwo.example'] });
  const tb = (await admin('flow.testNow')).json;
  check('the test batch leaves the Virtual assistants contact out, with the reason', tb.assign.map((x) => x.email).join() === 'cc.two@cctwo.example'
    && tb.suppressed.find((x) => x.email === 'va.two@vatwo.example')?.reason === 'Virtual assistants emails are switched off', JSON.stringify(tb).slice(0, 400));

  await saveSettings({ paused: false, perAccountCap: 3 });
  const d = '2026-11-16';
  const plan = await E.ensurePlan(d, { now: EAT('2026-11-15', '20:00') });
  check('the plan takes only the other categories, and no follow-up to a Virtual assistants email', plan.items.map((i) => i.email).sort().join() === 'cc.one@ccone.example,cc.two@cctwo.example',
    plan.items.map((i) => i.email).join());
  check('the Virtual assistants contacts wait at the front of the queue, in order; the follow-up stays in rotation',
    (await command('LRANGE', S.K.queue, 0, -1)).join() === 'va.one@vaone.example,va.two@vatwo.example' && Number(await command('ZSCORE', S.K.fu, FU)) === old);
  for (let t = EAT(d, '08:55'); t <= EAT(d, '18:00'); t += 60000) { sim.now = t; await E.tick({ now: t, scan: false }); }
  check('the day sends to the other categories only', sim.sent.map((m) => m.to).sort().join() === 'cc.one@ccone.example,cc.two@cctwo.example', sim.sent.map((m) => m.to).join());

  await saveSettings({ skipTemplates: [] });
  const next = await E.ensurePlan('2026-11-17', { now: EAT(d, '20:00') });
  check('switched back on: the waiting contacts and the follow-up are planned', ['va.one@vaone.example', 'va.two@vatwo.example', FU].every((e) => next.items.some((i) => i.email === e)),
    next.items.map((i) => i.email).join());

  // A Virtual assistants email planned before the switch went off is held back at send time.
  await saveSettings({ skipTemplates: ['va'] });
  const n0 = sim.sent.length;
  const late = await E.sendItem({ id: '2026-11-18:late:va', date: '2026-11-18', account: ACCOUNTS[0], email: 'va.one@vaone.example', template: 'va', followUp: false, touch: 1,
    at: EAT('2026-11-18', '10:00'), status: 'planned' }, { now: EAT('2026-11-18', '10:00'), today: '2026-11-18' });
  check('a planned Virtual assistants email is deferred at send time, nothing sent', late.status === 'deferred' && late.reason === 'Virtual assistants emails are switched off' && sim.sent.length === n0,
    JSON.stringify(late));
  await saveSettings({ paused: true });
}

// ============================================================ footer link wording
section('Footer: the link says "Don\'t send this again"; an old saved default upgrades, a custom footer is kept');
await reset();
{
  const r = R.renderEmail({ contact: { email: 'x@y.example', company: 'Acme' }, templates: DEFAULT_TEMPLATES, templateId: 'callcenter-generic', senderName: 'Dawit', token: 'footertoken000001' });
  check('the HTML footer link reads "Don\'t send this again" and points at the page', r.html.includes(`>Don't send this again</a>`) && r.html.includes('/api/u?t=footertoken000001') && !/>Unsubscribe</.test(r.html));
  check('the plain-text footer spells it out with the address', r.text.includes("Not interested? Don't send this again (") && r.text.includes('/api/u?t=footertoken000001).') && !r.text.includes('Unsubscribe'));
  // an old saved default upgrades; an edited footer is kept as written
  await command('SET', S.K.settings, JSON.stringify({ ...(await S.readSettings()), footer: R.PREVIOUS_DEFAULT_FOOTER.replace(/\n/g, '\r\n') }));
  check('a footer still saved with the old default reads as the new one', (await S.readSettings()).footer === R.DEFAULT_FOOTER && R.DEFAULT_FOOTER.endsWith('Not interested? {{unsubscribe}}.'));
  await command('SET', S.K.settings, JSON.stringify({ ...(await S.readSettings()), footer: 'Our own words.\n{{unsubscribe}} whenever you like.' }));
  check('a footer someone edited is left exactly as written', (await S.readSettings()).footer === 'Our own words.\n{{unsubscribe}} whenever you like.');
  const page = await call(handlers.u, { method: 'GET', query: { t: 'footertoken000001' } });
  check('the page behind the link uses the same words', page.status === 200 && page.raw.includes("Don't send this again</button>") && !page.raw.includes('Unsubscribe'));
}

console.log(`\n${passes} passed, ${failures} failed`);
shim.close();
redis.kill();
process.exit(failures ? 1 : 0);

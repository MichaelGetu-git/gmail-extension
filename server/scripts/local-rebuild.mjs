// Rebuilds the Work lane's sending state in the local Redis, for when the
// Upstash database is out of reach (2026-10-23: monthly limit). Settings and
// config are production's own (read once from Upstash's console into JSON
// files); who was already emailed comes from the mailboxes.
//
//   node scripts/local-rebuild.mjs --start 361 [--dry] [--force]
//        [--prod-settings ../prod-settings.local.json] [--prod-config ../prod-config.local.json]
//        [--window 14:50-16:20 --cutoff 17:35 --min-gap 10 --max-gap 20]
//        [--work "<903-row csv>"] [--tech "<277-row csv>"] [--evidence evidence.json] [--gmail-scan scan.json]
//
// What it writes:
//   - config: production's, with only the Work lane's accounts on the team list
//   - settings: production's, paused, with today's window and gaps if given
//   - a sent record (no follow-up scheduled) for every 903-list row before
//     --start and every 277-list contact, with the bounces and replies seen in
//     the inboxes marked, so none of them is emailed again
//   - Gmail-sent recipients on the imported contacted list (never a first email)
//   - the 903 list uploaded to the Work queue through uploadContacts, which
//     skips everyone with a sent record, so the queue starts at --start in file order
// Sending stays paused; unpause on the dashboard after checking the plan.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useLocal, root, arg, flag } from './_local.mjs';

const SCRATCH = 'D:/temp/claude/D--gmail-list-mailer/58aec003-f3fa-48ed-9b42-d0d7b8c167a2/scratchpad';
const WORK_CSV = arg('work', 'D:/prospeo_person_export_20261015_101847_4c6453 - WORK UPLOAD.csv');
const TECH_CSV = arg('tech', 'D:/Telegram Desktop/Lane Tech from Prospeo - UPLOAD.csv');
const EVIDENCE = arg('evidence', `${SCRATCH}/evidence.local.json`);
const GMAIL_SCAN = arg('gmail-scan', `${SCRATCH}/scan.local.json`);
const PROD_SETTINGS = arg('prod-settings', join(root, '..', 'prod-settings.local.json'));
const PROD_CONFIG = arg('prod-config', join(root, '..', 'prod-config.local.json'));
const START = Number(arg('start'));
const DRY = flag('dry');
if (!Number.isInteger(START) || START < 2) { console.error('--start <row> is required (first 903-list row not yet emailed)'); process.exit(1); }

await useLocal();
const { command, pipeline } = await import('../api/_store.js');
const { K, cleanSettings, DEFAULT_SETTINGS, writeSettings, eatAt } = await import('../api/_settings.js');
const { cleanConfig, DEFAULT_CONFIG, saveConfig } = await import('../api/config.js');
const { parseCsv, normEmail, EMAIL_RE } = await import('../api/_render.js');
const { uploadContacts } = await import('../api/_engine.js');

if (!DRY && !flag('force') && (await command('EXISTS', K.settings, K.sent, K.contacts))) {
  console.error('the local Redis already has sending state; pass --force to write over it'); process.exit(1);
}

// ---- production settings and config
const prodSettings = JSON.parse(readFileSync(PROD_SETTINGS, 'utf8'));
const prodConfig = JSON.parse(readFileSync(PROD_CONFIG, 'utf8'));
const accounts = Object.entries(prodSettings.accountLanes || {}).filter(([, l]) => l === 'work').map(([a]) => a.toLowerCase());
const missing = accounts.filter((a) => !(a in (prodConfig.senders || {})));
if (missing.length) { console.error(`work accounts missing from the config's senders: ${missing.join(', ')}`); process.exit(1); }

// ---- lists and evidence
const work = parseCsv(readFileSync(WORK_CSV, 'utf8'));
const tech = parseCsv(readFileSync(TECH_CSV, 'utf8'));
const lines = readFileSync(WORK_CSV, 'utf8').split(/\r?\n/).slice(1).filter((l) => l.trim());
if (work.rows.length !== lines.length) { console.error(`row count mismatch (${work.rows.length} parsed, ${lines.length} lines): row numbers would be off`); process.exit(1); }
const evidence = JSON.parse(readFileSync(EVIDENCE, 'utf8'));
const evBy = new Map();
for (const e of evidence) { const k = normEmail(e.email); evBy.set(k, [...(evBy.get(k) || []), e]); }

// Day each already-sent row went out, from the latest row seen per day.
const DAYS = [[55, '2026-10-16'], [145, '2026-10-19'], [255, '2026-10-20'], [Infinity, '2026-10-21']];
const sentAt = (rowNo) => eatAt(DAYS.find(([max]) => rowNo <= max)[1], 17 * 60);
const WEEK = 7 * 86400000;

function record(email, row, { at, touches, list, template }) {
  const ev = evBy.get(email) || [];
  const account = ev.find((e) => accounts.includes(e.account))?.account || null;
  const bounce = ev.find((e) => e.kind === 'bounce');
  const reply = ev.find((e) => e.kind === 'reply');
  return {
    email, account, company: row.company || '', row, template, lane: 'work', firstSentAt: at, lastSentAt: at + (touches - 1) * WEEK,
    touches: Array.from({ length: touches }, (_, i) => ({ at: at + i * WEEK, n: i + 1, t: null, template: i ? 'followup' : template, followUp: i > 0, v: 0, plain: true, rebuilt: true })),
    repliedAt: reply ? reply.at : null, bouncedAt: bounce ? bounce.at : null, ...(bounce ? { bounceReason: 'bounce seen in the inbox (rebuilt)' } : {}),
    unsubscribedAt: null, rebuilt: list,
  };
}

const sent = new Map();
work.rows.forEach((row, i) => {
  const rowNo = i + 1, email = normEmail(row.email);
  if (rowNo >= START || !EMAIL_RE.test(email)) return;
  sent.set(email, record(email, row, { at: sentAt(rowNo), touches: 1, list: 'work-903', template: 'callcenter-generic' }));
});
for (const row of tech.rows) {
  const email = normEmail(row.email);
  if (EMAIL_RE.test(email) && !sent.has(email)) sent.set(email, record(email, row, { at: eatAt('2026-10-12', 17 * 60), touches: 2, list: 'tech-277', template: 'tech' }));
}
// Bounces and replies to addresses on neither list (forwards, old addresses).
for (const [email, ev] of evBy) {
  if (sent.has(email) || !EMAIL_RE.test(email) || !ev.some((e) => e.kind !== 'auto')) continue;
  sent.set(email, record(email, { email }, { at: ev[0].at, touches: 1, list: 'evidence', template: 'callcenter-generic' }));
}

const TEST = new Set([...DEFAULT_SETTINGS.testRecipients, ...(prodSettings.testRecipients || [])].map(normEmail));
const gmailSent = new Set();
for (const r of JSON.parse(readFileSync(GMAIL_SCAN, 'utf8')).results || []) {
  if (!/@gmail\.com$/.test(r.account)) continue;
  for (const s of r.sent || []) { const e = normEmail(s.to); if (EMAIL_RE.test(e) && !TEST.has(e) && !/^\[test\]/i.test(s.subject)) gmailSent.add(e); }
}

const vals = [...sent.values()];
console.log({
  start: START, firstQueued: work.rows[START - 1]?.email, accounts: accounts.length,
  sentRecords: sent.size, fromWork: vals.filter((r) => r.rebuilt === 'work-903').length, fromTech: vals.filter((r) => r.rebuilt === 'tech-277').length,
  bounced: vals.filter((r) => r.bouncedAt).length, replied: vals.filter((r) => r.repliedAt).length, gmailContacted: gmailSent.size,
});
if (DRY) { console.log('dry run: nothing written'); process.exit(0); }

// ---- write
const [ws, we] = String(arg('window', '')).split('-');
const today = {
  paused: true,
  ...(ws && we ? { windowStart: ws, windowEnd: we } : {}), ...(arg('cutoff') ? { lateCutoff: arg('cutoff') } : {}),
  ...(arg('min-gap') ? { minGapMin: Number(arg('min-gap')) } : {}), ...(arg('max-gap') ? { maxGapMin: Number(arg('max-gap')) } : {}),
};
const base = { ...DEFAULT_SETTINGS, ...prodSettings };
await writeSettings(cleanSettings({ ...base, ...today }, base));
const senders = Object.fromEntries(accounts.map((a) => [a, prodConfig.senders[a]]));
const nicknames = Object.fromEntries(Object.entries(prodConfig.nicknames || {}).filter(([a]) => accounts.includes(a)));
const cfgBase = { ...DEFAULT_CONFIG, ...prodConfig, version: (prodConfig.version || 1) - 1 };
await saveConfig(cleanConfig({ ...prodConfig, senders, nicknames }, cfgBase), cfgBase);

const cmds = [];
for (let i = 0; i < vals.length; i += 200) {
  const chunk = vals.slice(i, i + 200);
  cmds.push(['HSET', K.sent, ...chunk.flatMap((r) => [r.email, JSON.stringify(r)])]);
  cmds.push(['HSET', K.touch, ...chunk.flatMap((r) => r.touches.flatMap((t) => [`${r.email}#${t.n}`, `rebuilt:${r.rebuilt}`]))]);
  cmds.push(['HSET', K.contacts, ...chunk.flatMap((r) => [r.email, JSON.stringify({ email: r.email, row: r.row, template: r.template, lane: 'work',
    addedAt: r.firstSentAt, status: r.bouncedAt ? 'bounced' : 'sent', sentAt: r.firstSentAt, account: r.account, rebuilt: r.rebuilt })])]);
  for (const r of chunk.filter((x) => x.account)) cmds.push(['ZADD', K.byAcct(r.account), r.lastSentAt, r.email]);
}
const g = [...gmailSent];
for (let i = 0; i < g.length; i += 300) cmds.push(['SADD', K.suppEmails, ...g.slice(i, i + 300)]);
await pipeline(cmds);

const report = await uploadContacts(readFileSync(WORK_CSV, 'utf8'), { lane: 'work' });
console.log({ uploaded: report.added, skipped: report.skipped, byTemplate: report.byTemplate, placeholderWarnings: report.placeholderWarnings,
  queueLength: await command('LLEN', K.queueOf('work')), queueHead: (await command('LRANGE', K.queueOf('work'), 0, 2)) || [] });
process.exit(0);

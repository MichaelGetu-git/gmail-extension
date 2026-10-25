// Read-only scan of every sending account's mailbox, for rebuilding the
// sending state without the Upstash database: who each account emailed and
// when (its Sent folder), which template each email was, and the replies and
// bounces that came back (All Mail / INBOX, via scanInbox).
//
//   node scripts/local-scan.mjs [--env .env.production.local] [--since 2026-09-01]
//        [--accounts extra-accounts.txt] [--out scan.json] [--only a@x.com,b@y.com]
//
// Accounts: ../spacemail-accounts.txt, the four Gmail accounts, plus any file
// given with --accounts (one address per line). Only accounts with a password
// variable in the env file are opened. Nothing is moved, flagged or deleted.
//
// Only Gmail files SMTP-sent mail in Sent by itself, so a non-Google account's
// Sent folder may hold none of the server's emails; the summary says so.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };

// ---- env file (KEY=value or KEY="value"), never printed
const envFile = join(root, arg('env', '.env.production.local'));
if (!existsSync(envFile)) { console.error(`no env file at ${envFile}`); process.exit(1); }
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (!m) continue;
  let v = m[2];
  // vercel env pull escapes control characters; several values end in \r\n
  if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\([nrt"\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' }[c] || c)).trim();
  else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const { ImapFlow } = await import('imapflow');
const { getPassword, hasPassword, passwordVar, mailServer } = await import('../api/_settings.js');
const { scanInbox } = await import('../api/_imap.js');
const { DEFAULT_TEMPLATES } = await import('../api/_defaults.js');

const SINCE = Date.parse(`${arg('since', '2026-09-01')}T00:00:00Z`);
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter((s) => /@/.test(s)) : []);
let accounts = [...new Set([
  ...lines(join(root, '..', 'spacemail-accounts.txt')),
  'daniellzelalem@gmail.com', 'brookkdaniell@gmail.com', 'berryydaniel@gmail.com', 'noahadanial@gmail.com',
  ...(arg('accounts') ? lines(arg('accounts')) : []),
])];
if (arg('only')) accounts = arg('only').split(',').map((s) => s.trim().toLowerCase());
const usedVars = new Set(accounts.map(passwordVar));
const unmatched = Object.keys(process.env).filter((k) => /^GMAIL_APP_PASSWORD_/.test(k) && !usedVars.has(k));

// ---- template from subject: each default subject as a pattern ({{x}} = anything)
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SUBJECT_RE = Object.entries(DEFAULT_TEMPLATES).map(([id, t]) =>
  [id, new RegExp(`^${t.subject.split(/\{\{[a-z_]+\}\}/i).map(esc).join('.+?')}$`, 'i')]);
const templateOf = (subject) => SUBJECT_RE.find(([, re]) => re.test(String(subject || '').trim()))?.[0] || null;
// A subject with the company name taken out, to group custom templates.
const shapeOf = (subject, to) => {
  const dom = String(to || '').split('@')[1]?.split('.')[0] || '';
  let s = String(subject || '').trim();
  if (dom.length > 3) s = s.replace(new RegExp(esc(dom), 'ig'), '{{company?}}');
  return s;
};
const TOKEN = /\/api\/[olu]\?t=([a-z0-9]{12,40})/i;

async function sentFolder(client) {
  const boxes = await client.list();
  return boxes.find((b) => b.specialUse === '\\Sent')?.path
    || boxes.find((b) => /^(inbox[./])?sent( (items|messages|mail))?$/i.test(b.path))?.path || null;
}

async function scanSent(account) {
  const client = new ImapFlow({ host: mailServer(account).imap, port: 993, secure: true,
    auth: { user: account, pass: getPassword(account) }, logger: false, socketTimeout: 30000 });
  await client.connect();
  const out = { folder: null, sent: [] };
  try {
    out.folder = await sentFolder(client);
    if (!out.folder) return out;
    const lock = await client.getMailboxLock(out.folder, { readOnly: true });
    try {
      const uids = (await client.search({ since: new Date(SINCE) }, { uid: true })) || [];
      if (!uids.length) return out;
      for await (const m of client.fetch(uids, { uid: true, envelope: true, internalDate: true,
        source: { start: 0, maxLength: 12000 } }, { uid: true })) {
        const e = m.envelope || {};
        const src = m.source ? m.source.toString('utf8') : '';
        const body = src.split(/\r?\n\r?\n/).slice(1).join('\n\n');
        for (const t of e.to || []) {
          const to = String(t.address || '').toLowerCase();
          if (!to) continue;
          out.sent.push({ to, at: +(e.date || m.internalDate || 0), subject: e.subject || '',
            template: templateOf(e.subject), shape: shapeOf(e.subject, to), inReplyTo: e.inReplyTo || '',
            messageId: String(e.messageId || '').replace(/[<>]/g, '').toLowerCase(),
            token: TOKEN.exec(src)?.[1] || null, plain: !/content-type:\s*text\/html|multipart\/alternative/i.test(src),
            sample: body.slice(0, 1500) });
        }
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
  out.sent.sort((a, b) => a.at - b.at);
  return out;
}

async function scanOne(account) {
  const r = { account, server: mailServer(account).imap, hasPassword: hasPassword(account), passwordVar: passwordVar(account) };
  if (!r.hasPassword) return { ...r, error: 'no password variable in the env file' };
  try {
    const s = await scanSent(account);
    Object.assign(r, s);
    const known = new Set(s.sent.map((x) => x.to));
    try {
      const inbox = await scanInbox(account, { since: SINCE, known });
      r.replies = inbox.replies; r.autoReplies = inbox.autoReplies; r.bounces = inbox.bounces; r.softBounces = inbox.softBounces;
    } catch (e) { r.inboxError = String(e.message || e).slice(0, 200); }
  } catch (e) { r.error = String(e.responseText || e.message || e).slice(0, 200); }
  return r;
}

// A few accounts at a time; Spacemail and Gmail both limit parallel logins.
const results = [];
for (let i = 0; i < accounts.length; i += 4) {
  results.push(...(await Promise.all(accounts.slice(i, i + 4).map(scanOne))));
  process.stderr.write(`scanned ${Math.min(i + 4, accounts.length)}/${accounts.length}\n`);
}

const outFile = arg('out', join(root, 'scan.local.json'));
writeFileSync(outFile, JSON.stringify({ scannedAt: Date.now(), since: SINCE, results, unmatchedPasswordVars: unmatched }, null, 1));

const day = (ms) => (ms ? new Date(ms + 3 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '-');
console.log(`\nsince ${day(SINCE)} EAT, ${accounts.length} accounts; full detail in ${outFile}\n`);
for (const r of results) {
  if (r.error) { console.log(`${r.account}: ERROR ${r.error}`); continue; }
  const n = r.sent?.length || 0;
  const last = r.sent?.[n - 1];
  const tpl = {};
  for (const x of r.sent || []) { const k = x.template || `other: ${x.shape.slice(0, 50)}`; tpl[k] = (tpl[k] || 0) + 1; }
  console.log(`${r.account}  [${r.folder || 'no Sent folder'}]  sent ${n}` +
    (last ? `, last ${day(last.at)} to ${last.to} "${last.subject.slice(0, 60)}"` : '') +
    `, replies ${r.replies?.length ?? '?'}, bounces ${r.bounces?.length ?? '?'}`);
  for (const [k, v] of Object.entries(tpl).sort((a, b) => b[1] - a[1])) console.log(`    ${v}  ${k}`);
}
if (unmatched.length) console.log(`\npassword variables with no account in the list: ${unmatched.join(', ')}`);

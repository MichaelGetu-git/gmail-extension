// Reads each sending account's mail over IMAP (same app password) for two
// things the follow-ups and the reply rate depend on:
//   - replies from anyone we emailed, so they are never followed up
//   - mailer-daemon / postmaster bounces, for the bounce rate and auto-pause
// and, for the dashboard's conversations, the messages exchanged with one
// person (readThread). Reading never moves, flags or deletes anything; the one
// write is a copy of a dashboard answer put in a non-Google Sent folder
// (appendSent), since only Gmail files SMTP-sent mail by itself.
//
// It reads All Mail rather than INBOX, so a reply that was read and archived
// (or filtered past the inbox) still counts. A reply is matched by its sender
// being someone this account emailed, or by its In-Reply-To / References
// pointing at one of our Message-IDs (someone answering from another address).
// Out-of-office and other auto-responders are reported apart, never as replies.
import { ImapFlow } from 'imapflow';
import { getPassword, mailServer } from './_settings.js';

// The 'error' event needs a listener: without one, a connection that drops
// mid-login ("Already logged out") throws and kills the process. The same
// failure still rejects connect() or the command in progress, where it is handled.
let factory = (account) => new ImapFlow({
  host: mailServer(account).imap, port: 993, secure: true,
  auth: { user: account, pass: getPassword(account) },
  logger: false, socketTimeout: 20000,
}).on('error', () => {});
export function setImapFactory(f) { factory = f; }

const DAEMON = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i;
const EMAILS = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const HEADERS = ['in-reply-to', 'references', 'auto-submitted', 'x-autoreply', 'x-autorespond', 'x-autoresponder', 'precedence'];
// The prefixes auto-responders put on the subject ("Automatic reply: …",
// "Out of Office: …"). Prefix only: a person answering starts with "Re:", and
// our own subjects may well mention office hours.
const AUTO_SUBJECT = /^(automatic reply|auto(matic)?[ -]?(reply|response)|autoreply|auto:|out of (the )?office|ooo\b|abwesenheit|réponse automatique|respuesta automática|risposta automatica|automatisch antwoord|on (annual )?leave|away from (the|my) (office|desk))/i;

// Message-IDs in a header value, lowercased and without the angle brackets.
export const msgIds = (s) => [...String(s || '').matchAll(/<([^<>\s]+)>/g)].map((m) => m[1].toLowerCase());

function headerMap(buf) {
  const text = (buf ? buf.toString('utf8') : '').replace(/\r?\n[ \t]+/g, ' ');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

// RFC 3834 says any Auto-Submitted other than "no" is automatic.
export function isAutoReply(h, subject) {
  const auto = String(h['auto-submitted'] || '').toLowerCase();
  if (auto && auto !== 'no') return true;
  if (h['x-autoreply'] || h['x-autorespond'] || h['x-autoresponder']) return true;
  if (/auto[_-]?reply/i.test(h.precedence || '')) return true;
  return AUTO_SUBJECT.test(String(subject || '').trim());
}

// All Mail when the account shows it over IMAP (any language: found by its
// \All flag), else INBOX.
async function mailboxOf(client) {
  try {
    const boxes = typeof client.list === 'function' ? await client.list() : [];
    return (boxes || []).find((b) => b.specialUse === '\\All')?.path || 'INBOX';
  } catch { return 'INBOX'; }
}

// known: Set of addresses this account has emailed.
// threadOf: optional async (ids[]) -> Map(messageId -> recipient email), for
// replies whose sender is not in known. Returns what it found.
export async function scanInbox(account, { since, known, threadOf = null }) {
  const client = factory(account);
  const replies = [], autoReplies = [], bounces = [];
  const self = String(account).toLowerCase();
  await client.connect();
  try {
    const lock = await client.getMailboxLock(await mailboxOf(client), { readOnly: true });
    try {
      // Our own sent copies live in All Mail too; they are never a reply.
      const uids = (await client.search({ since: new Date(since), not: { from: self } }, { uid: true })) || [];
      const recent = uids.slice(-400);
      const daemonUids = [];
      const unmatched = [];
      if (recent.length) {
        for await (const m of client.fetch(recent, { uid: true, envelope: true, internalDate: true, headers: HEADERS }, { uid: true })) {
          const from = m.envelope?.from?.[0] || {};
          const addr = String(from.address || '').toLowerCase();
          if (addr === self) continue;
          const at = new Date(m.internalDate || m.envelope?.date || Date.now()).getTime();
          const subject = String(m.envelope?.subject || '').slice(0, 200);
          const h = headerMap(m.headers);
          const hit = { at, subject, from: addr, auto: isAutoReply(h, subject), messageId: String(m.envelope?.messageId || '') };
          if (DAEMON.test(`${addr} ${from.name || ''}`)) daemonUids.push({ uid: m.uid, at });
          else if (known.has(addr)) (hit.auto ? autoReplies : replies).push({ ...hit, email: addr });
          else {
            const ids = [...new Set([...msgIds(m.envelope?.inReplyTo || h['in-reply-to']), ...msgIds(h.references)])];
            if (ids.length) unmatched.push({ ...hit, ids });
          }
        }
      }
      // Someone answering one of our emails from another address.
      if (unmatched.length && threadOf) {
        const map = await threadOf([...new Set(unmatched.flatMap((u) => u.ids))]);
        for (const u of unmatched) {
          const email = u.ids.map((id) => map.get(id)).find(Boolean);
          if (email) (u.auto ? autoReplies : replies).push({ email, at: u.at, subject: u.subject, from: u.from, auto: u.auto, messageId: u.messageId, viaThread: true });
        }
      }
      for (const { uid, at } of daemonUids.slice(-60)) {
        const msg = await client.fetchOne(uid, { source: { start: 0, maxLength: 60000 } }, { uid: true });
        const src = msg?.source ? msg.source.toString('utf8') : '';
        const failed = /X-Failed-Recipients:\s*([^\r\n]+)/i.exec(src)?.[1] || '';
        const finalRcpt = [...src.matchAll(/Final-Recipient:\s*rfc822;\s*([^\s\r\n]+)/gi)].map((x) => x[1]);
        const candidates = new Set([...(failed.match(EMAILS) || []), ...finalRcpt, ...(src.match(EMAILS) || [])]
          .map((e) => e.toLowerCase().replace(/[<>;]/g, '')));
        const reason = (/\b(5\d\d[ -]\d\.\d\.\d+[^\r\n]{0,120})/.exec(src)?.[1] || /\b(4\d\d[ -]\d\.\d\.\d+[^\r\n]{0,120})/.exec(src)?.[1] || 'bounce').trim();
        const soft = /^4/.test(reason);
        for (const e of candidates) if (known.has(e)) bounces.push({ email: e, at, reason: reason.slice(0, 160), soft });
      }
    } finally { lock.release(); }
  } finally {
    await client.logout().catch(() => {});
  }
  return { replies, autoReplies, bounces: bounces.filter((b) => !b.soft), softBounces: bounces.filter((b) => b.soft) };
}

// ------------------------------------------------------------------ one conversation

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const codePoint = (n) => { try { return String.fromCodePoint(n); } catch { return ''; } };
// An HTML-only email as readable text: block ends become line breaks, tags go,
// entities are decoded. Only ever shown as text, never as HTML.
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] !== '#' ? ENTITY[e.toLowerCase()] ?? m
      : codePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))))
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Where a message's text is: the first text/plain part that is not an
// attachment, else the first text/html one. A single-part message has no part
// number; imapflow reads its body as part "1". A forwarded email inside is not
// the message's own text.
function textPart(node) {
  let html = null;
  const walk = (n) => {
    if (!n) return null;
    const type = String(n.type || '').toLowerCase();
    if (type === 'message/rfc822') return null;
    if (n.childNodes?.length) { for (const c of n.childNodes) { const r = walk(c); if (r) return r; } return null; }
    if (String(n.disposition || '').toLowerCase() === 'attachment') return null;
    if (type === 'text/plain') return { part: n.part || '1', html: false };
    if (type === 'text/html' && !html) html = { part: n.part || '1', html: true };
    return null;
  };
  return walk(node) || html;
}

async function partText(client, uid, { part, html }, maxBytes) {
  try {
    const { content } = await client.download(uid, part, { uid: true, maxBytes });
    if (!content) return '';
    const chunks = [];
    for await (const c of content) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const s = Buffer.concat(chunks).toString('utf8');
    return (html ? htmlToText(s) : s).replace(/\r\n/g, '\n').trim();
  } catch { return ''; }
}

// The messages between this account and any of `addresses` since `since` (ms),
// oldest first, at most `limit`: { out, from, fromName, to, at, subject,
// messageId, inReplyTo, references, text }. `out` is mail the account sent;
// Gmail's All Mail holds that too, other servers' inboxes only what arrived.
// Messages whose Message-ID is in `skip` (ours, already known) are left out.
export async function readThread(account, { addresses, since, skip = new Set(), limit = 30, maxBytes = 60000 }) {
  const self = String(account).toLowerCase();
  const want = new Set((addresses || []).map((a) => String(a || '').toLowerCase()).filter(Boolean));
  if (!want.size) return [];
  const client = factory(account);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(await mailboxOf(client), { readOnly: true });
    try {
      const or = [...want].flatMap((a) => [{ from: a }, { to: a }, { cc: a }]);
      const uids = (await client.search({ since: new Date(since), or }, { uid: true })) || [];
      const msgs = [];
      if (uids.length) {
        const q = { uid: true, envelope: true, internalDate: true, bodyStructure: true, headers: ['references'] };
        for await (const m of client.fetch(uids.slice(-limit * 2), q, { uid: true })) {
          const env = m.envelope || {};
          const f = env.from?.[0] || {};
          const from = String(f.address || '').toLowerCase();
          const rcpt = [...(env.to || []), ...(env.cc || [])].map((x) => String(x.address || '').toLowerCase());
          const out = from === self;
          // IMAP matches substrings ("ann@x" finds "joann@x"): exact addresses only.
          if (out ? !rcpt.some((a) => want.has(a)) : !want.has(from)) continue;
          const messageId = String(env.messageId || '');
          if (skip.has(msgIds(messageId)[0])) continue;
          msgs.push({ uid: m.uid, out, from, fromName: String(f.name || ''), to: rcpt,
            at: new Date(m.internalDate || env.date || Date.now()).getTime(), subject: String(env.subject || '').slice(0, 300),
            messageId, inReplyTo: String(env.inReplyTo || ''), references: msgIds(headerMap(m.headers).references), part: textPart(m.bodyStructure) });
        }
      }
      const keep = msgs.sort((a, b) => a.at - b.at).slice(-limit);
      // Bodies only once the fetch is done: imapflow runs one command at a time.
      for (const x of keep) {
        x.text = x.part ? await partText(client, x.uid, x.part, maxBytes) : '';
        delete x.part; delete x.uid;
      }
      return keep;
    } finally { lock.release(); }
  } finally {
    await client.logout().catch(() => {});
  }
}

// Puts a copy of a sent message in the account's Sent folder (found by its
// \Sent flag, else by name). Returns the folder, or null when there is none.
export async function appendSent(account, raw) {
  const client = factory(account);
  await client.connect();
  try {
    const boxes = (await client.list()) || [];
    const box = boxes.find((b) => b.specialUse === '\\Sent') || boxes.find((b) => /^(inbox[./])?sent( items| messages| mail)?$/i.test(b.path));
    if (!box) return null;
    await client.append(box.path, raw, ['\\Seen'], new Date());
    return box.path;
  } finally {
    await client.logout().catch(() => {});
  }
}

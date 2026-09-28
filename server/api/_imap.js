// Reads each sending account's mail over IMAP (same app password) for two
// things the follow-ups and the reply rate depend on:
//   - replies from anyone we emailed, so they are never followed up
//   - mailer-daemon / postmaster bounces, for the bounce rate and auto-pause
// Read-only: it never moves, flags or deletes anything.
//
// It reads All Mail rather than INBOX, so a reply that was read and archived
// (or filtered past the inbox) still counts. A reply is matched by its sender
// being someone this account emailed, or by its In-Reply-To / References
// pointing at one of our Message-IDs (someone answering from another address).
// Out-of-office and other auto-responders are reported apart, never as replies.
import { ImapFlow } from 'imapflow';
import { getPassword } from './_settings.js';

let factory = (account) => new ImapFlow({
  host: 'imap.gmail.com', port: 993, secure: true,
  auth: { user: account, pass: getPassword(account) },
  logger: false, socketTimeout: 20000,
});
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
          const hit = { at, subject, from: addr, auto: isAutoReply(h, subject) };
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
          if (email) (u.auto ? autoReplies : replies).push({ email, at: u.at, subject: u.subject, from: u.from, auto: u.auto, viaThread: true });
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

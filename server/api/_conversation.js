// Conversations with people who replied: the thread as the dashboard shows it,
// and answering from the dashboard, from the account that emailed them.
//
// A thread is put together from three places:
//   - our emails to them: the send record's touches, worded from the send log
//   - the account's mailbox (IMAP, read-only): their messages, and on Gmail
//     anything the account sent them from Gmail itself
//   - the answers sent from here, kept on the send record (rec.answers)
//
// An answer is an ordinary reply, always sent for real (dry-run is for the
// automatic sending): same account and From name, "Re:" subject, In-Reply-To
// and References pointing at their latest message, quoting it, so it lands in
// the same thread on both sides. It is plain text and carries no tracking, and
// it doesn't count toward the daily cap. Gmail files it under Sent by itself;
// other mail servers get a copy put in their Sent folder.
import MailComposer from 'nodemailer/lib/mail-composer';
import { command, pipeline } from './_store.js';
import { K, DAY, hasPassword, passwordVar, mailServer } from './_settings.js';
import { readConfig } from './config.js';
import { addLog, senderOf, fromHeader } from './_engine.js';
import { readThread, appendSent, msgIds } from './_imap.js';
import { transportFor, classifySmtpError } from './_smtp.js';
import { newToken, normEmail } from './_render.js';

export const ANSWER_MAX = 10000;      // characters in one answer
export const ANSWERS_KEPT = 30;       // answers kept on a send record
const TEXT_MAX = 20000;               // characters of one message sent to the dashboard

const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

export const reSubject = (s) => {
  const t = String(s || '').trim();
  return /^(re|aw|sv|antw)\s*:/i.test(t) ? t : `Re: ${t}`.trim();
};

// Where the earlier emails quoted in a message start: "On … wrote:" (Gmail,
// Apple Mail, Outlook on the web), Outlook's "-----Original Message-----" or
// "From: … Sent:" block, else a run of "> " lines at the end.
const QUOTE_START = [
  /^On [^\n]{0,300}?(\n[^\n]{0,200}?)?wrote:[ \t]*$/m,
  /^-{2,}[ \t]*Original Message[ \t]*-{2,}/mi,
  /^From:[^\n]*\n(Sent|Date):[^\n]*$/m,
];
export function splitQuote(text) {
  const s = String(text || '');
  let cut = -1;
  for (const re of QUOTE_START) { const m = re.exec(s); if (m && (cut < 0 || m.index < cut)) cut = m.index; }
  if (cut < 0) { const m = /(^>[^\n]*(\n|$))+\s*$/m.exec(s); if (m) cut = m.index; }
  if (cut <= 0 || !s.slice(0, cut).trim()) return { text: s.trim(), quoted: '' };
  return { text: s.slice(0, cut).trim(), quoted: s.slice(cut).trim() };
}

const WHEN = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
// Their message under the answer, the way mail apps quote.
export function quoteOf(m) {
  const who = m.fromName ? `${m.fromName} <${m.from}>` : m.from;
  const lines = String(m.text || '').slice(0, 8000).split('\n').map((l) => (l.startsWith('>') ? `>${l}` : `> ${l}`));
  return `On ${WHEN.format(m.at)}, ${who} wrote:\n${lines.join('\n')}`;
}

// The addresses a conversation is with: the person emailed, and whoever
// answered for them from another address.
const addressesOf = (rec) => [rec.email, rec.replyFrom].filter(Boolean);
// Our Message-IDs (as msgIds() gives them), so the mailbox read skips our own copies.
const ourIds = (rec) => new Set([...(rec.touches || []), ...(rec.answers || [])].map((x) => msgIds(x.messageId)[0]).filter(Boolean));

async function ourMessages(rec) {
  const touches = rec.touches || [];
  const ids = touches.map((t) => t.logId).filter(Boolean);
  const bodies = ids.length ? (await command('HMGET', K.logBody, ...ids)) || [] : [];
  const body = new Map(ids.map((id, i) => [id, parse(bodies[i], {})]));
  return [
    ...touches.map((t) => {
      const b = body.get(t.logId) || {};
      return { dir: 'out', kind: 'touch', touch: t.n || 1, followUp: Boolean(t.followUp), at: t.at, from: rec.account, to: rec.email,
        subject: b.subject || '', text: b.text || '', messageId: t.messageId || '' };
    }),
    ...(rec.answers || []).map((a) => ({ dir: 'out', kind: 'answer', at: a.at, from: rec.account, to: a.to, subject: a.subject, text: a.text, messageId: a.messageId })),
  ];
}

async function mailboxThread(rec) {
  if (!hasPassword(rec.account)) return { thread: [], error: `no app password for ${rec.account} (${passwordVar(rec.account)}), so its mailbox can't be read` };
  try {
    return { thread: await readThread(rec.account, { addresses: addressesOf(rec), since: rec.firstSentAt - DAY, skip: ourIds(rec) }), error: null };
  } catch (err) {
    return { thread: [], error: String(err?.responseText || err?.message || err).slice(0, 200) };
  }
}

async function sentRecord(email) {
  const e = normEmail(email);
  const rec = parse(await command('HGET', K.sent, e));
  if (!rec) throw bad('nobody at that address was emailed from the dashboard', 404);
  return rec;
}

// Everything exchanged with one person, oldest first, and what an answer
// would be sent as.
export async function getConversation(email) {
  const rec = await sentRecord(email);
  const [config, mine, box] = await Promise.all([readConfig(), ourMessages(rec), mailboxThread(rec)]);
  const messages = [
    ...mine,
    ...box.thread.map((m) => ({ dir: m.out ? 'out' : 'in', kind: m.out ? 'mailbox' : 'reply', at: m.at, from: m.from, fromName: m.fromName,
      to: m.to.join(', '), subject: m.subject, text: m.text, messageId: m.messageId })),
  ].sort((a, b) => a.at - b.at)
    .map((m) => ({ ...m, ...splitQuote(String(m.text || '').slice(0, TEXT_MAX)) }));
  const lastIn = messages.filter((m) => m.dir === 'in').at(-1);
  const row = rec.row || {};
  return {
    email: rec.email, name: row.name || [row.first_name, row.last_name].filter(Boolean).join(' ') || '', company: rec.company || row.company || '',
    account: rec.account, senderName: senderOf(config, rec.account).senderName, lane: rec.lane || 'regular',
    repliedAt: rec.repliedAt || null, autoReplyAt: rec.autoReplyAt || null, answeredAt: rec.answeredAt || null,
    canAnswer: Boolean(rec.repliedAt) && hasPassword(rec.account), mailboxError: box.error, messages,
    draft: { to: lastIn?.from || rec.replyFrom || rec.email,
      subject: reSubject(lastIn?.subject || rec.lastReplySubject || rec.replySubject || mine[0]?.subject || '') },
  };
}

// Sends an answer to their latest message and keeps it on the send record.
export async function sendAnswer({ email, text, now = Date.now() }) {
  const answer = String(text ?? '').replace(/\r\n?/g, '\n').replace(/^\s*\n/, '').trimEnd();
  if (!answer.trim()) throw bad('write the reply first');
  if (answer.length > ANSWER_MAX) throw bad(`a reply can be ${ANSWER_MAX.toLocaleString('en')} characters at most`);
  const rec = await sentRecord(email);
  if (!rec.repliedAt) throw bad(`${rec.email} hasn't replied, so there is nothing to answer yet`);
  const account = rec.account;
  if (!hasPassword(account)) throw bad(`no app password for ${account} (${passwordVar(account)})`);
  const [config, box] = await Promise.all([readConfig(), mailboxThread(rec)]);
  // What this answers: their latest message. Without the mailbox, the reply
  // the inbox check recorded, still in the same thread.
  const last = box.thread.filter((m) => !m.out).at(-1) || null;
  const to = last?.from || rec.replyFrom || rec.email;
  const subject = reSubject(last?.subject || rec.lastReplySubject || rec.replySubject || (await ourMessages(rec))[0]?.subject || '');
  const inReplyTo = last?.messageId || rec.replyMessageId || '';
  const references = [...new Set((last ? [...last.references.map((id) => `<${id}>`), last.messageId]
    : [...(rec.touches || []).map((t) => t.messageId), rec.replyMessageId]).filter(Boolean))].slice(-20);
  const messageId = `<${newToken()}.${now.toString(36)}@${account.split('@')[1] || 'localhost'}>`;
  const full = last?.text ? `${answer}\n\n${quoteOf(last)}` : answer;
  const mail = { from: fromHeader(senderOf(config, account).senderName, account), to, subject, text: full, messageId, date: new Date(now),
    ...(inReplyTo ? { inReplyTo } : {}), ...(references.length ? { references } : {}) };

  const transport = transportFor(account);
  let info;
  try {
    info = await transport.sendMail(mail);
  } catch (err) {
    const c = classifySmtpError(err);
    await addLog({ account, to: rec.email, status: 'answer failed', subject, error: c.msg, ...(to !== rec.email ? { sentTo: to } : {}) });
    throw bad(c.notSent ? `not sent: ${c.msg}` : `the mail server answered with an error after taking the reply, so it may have gone out: ${c.msg}`, 502);
  } finally {
    try { transport.close?.(); } catch { /* ignore */ }
  }

  // Gmail files SMTP-sent mail under Sent by itself; other servers don't.
  let sentCopy = null;
  if (mailServer(account).custom) {
    try { sentCopy = await appendSent(account, await new MailComposer(mail).compile().build()); }
    catch (err) { sentCopy = `failed: ${String(err?.message || err).slice(0, 120)}`; }
  }

  const kept = { at: now, to, subject, text: answer, messageId: info?.messageId || messageId };
  const fresh = parse(await command('HGET', K.sent, rec.email)) || rec;
  fresh.answers = [...(fresh.answers || []), kept].slice(-ANSWERS_KEPT);
  fresh.answeredAt = now;
  // byacct keeps the inbox check reading their messages for 60 days after our
  // last answer, as after our last outreach email.
  await pipeline([['HSET', K.sent, rec.email, JSON.stringify(fresh)], ['ZADD', K.byAcct(account), now, rec.email]]);
  await addLog({ account, to: rec.email, status: 'answered', subject, messageId: kept.messageId, response: String(info?.response || '').slice(0, 200),
    ...(to !== rec.email ? { sentTo: to } : {}) }, { subject, text: full, from: account, plain: true });
  return { ok: true, answer: kept, quoted: Boolean(last?.text), sentCopy, mailboxError: box.error };
}

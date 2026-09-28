// Who replied and when, for the dashboard's Replies card and tab.
//
// The send records are the source of truth (every reply the inbox checks ever
// recorded, including those from before the replies feed existed); the feed
// (mailer:srv:replies) is only the cheap "anything new?" poll.
import { command } from './_store.js';
import { K } from './_settings.js';

const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

function rowOf(r, auto) {
  const at = auto ? r.autoReplyAt : r.repliedAt;
  const touches = r.touches || [];
  // The reply belongs to the last email sent before it.
  const before = touches.filter((t) => t.at <= at);
  const t = before[before.length - 1] || touches[0] || {};
  const row = r.row || {};
  const name = row.name || [row.first_name, row.last_name].filter(Boolean).join(' ');
  return {
    email: r.email, name: name || '', company: r.company || row.company || '', account: r.account, lane: r.lane || 'regular',
    at, auto, subject: (auto ? r.autoReplySubject : r.replySubject) || '', from: auto ? '' : (r.replyFrom || ''),
    template: t.template || r.template, touch: t.n || before.length || 1, touches: touches.length,
    sentAt: t.at || r.firstSentAt || null, firstSentAt: r.firstSentAt || null, personal: Boolean(touches[0]?.personal),
  };
}

// kind: 'replies' (people), 'auto' (out-of-office), or 'all'.
export async function listReplies({ kind = 'replies', q = '', limit = 200 } = {}) {
  const rows = [];
  let cursor = '0';
  for (let guard = 0; guard < 400; guard++) {
    const [next, flat] = await command('HSCAN', K.sent, cursor, 'COUNT', 500);
    for (let i = 1; i < (flat || []).length; i += 2) {
      const r = parse(flat[i]);
      if (!r) continue;
      if (r.repliedAt && kind !== 'auto') rows.push(rowOf(r, false));
      if (r.autoReplyAt && !r.repliedAt && kind !== 'replies') rows.push(rowOf(r, true));
    }
    cursor = String(next);
    if (cursor === '0') break;
  }
  // Replies recorded before subjects were kept: take the subject from the log.
  const missing = new Set(rows.filter((x) => !x.subject && !x.auto).map((x) => x.email));
  if (missing.size) {
    for (let start = 0; start < 3100 && missing.size; start += 500) {
      const chunk = (await command('LRANGE', K.log, start, start + 499)) || [];
      for (const j of chunk) {
        const e = parse(j);
        if (e?.status === 'replied' && missing.has(e.to)) {
          for (const x of rows) if (x.email === e.to && !x.auto && !x.subject) x.subject = e.subject || '';
          missing.delete(e.to);
        }
      }
      if (chunk.length < 500) break;
    }
  }
  const needle = String(q || '').trim().toLowerCase();
  const all = rows.length;
  const out = (needle ? rows.filter((x) => `${x.email} ${x.name} ${x.company} ${x.account} ${x.subject} ${x.from}`.toLowerCase().includes(needle)) : rows)
    .sort((a, b) => b.at - a.at);
  return { items: out.slice(0, Math.max(1, Math.min(1000, Number(limit) || 200))), matched: out.length, total: all };
}

// The poll behind the "new replies" badge: one small read.
export async function latestReplies(n = 20) {
  const [last, feed] = await Promise.all([command('GET', K.lastReply), command('LRANGE', K.replies, 0, Math.max(0, n - 1))]);
  return { lastReplyAt: Number(last) || null, items: (feed || []).map((j) => parse(j)).filter(Boolean) };
}

// Telegram notices for new replies, through a bot (Telegram Bot API, free).
//
//   TELEGRAM_BOT_TOKEN  the bot's token from @BotFather
//   TELEGRAM_NOTIFY     who gets the notices: Telegram usernames and/or numeric
//                       chat ids, separated by commas or spaces (default: st_miki)
//
// A bot can only message someone who has sent it /start. Usernames are turned
// into chat ids from the bot's recent updates (getUpdates) the first time and
// remembered in Redis, so each person has to /start the bot once. That needs a
// bot without a webhook; a bot another app already uses (Tempzen's) works with
// numeric chat ids in TELEGRAM_NOTIFY instead, and sending never disturbs it.
//
// The token is only ever put in the request URL to api.telegram.org; it is
// never logged or returned.
import { command } from './_store.js';
import { K } from './_settings.js';

export const NOTIFY_EVERY_MIN = 30;
export const tgConfigured = () => Boolean(String(process.env.TELEGRAM_BOT_TOKEN || '').trim());
// Usernames never contain spaces, so "5185956276 6153340679" is two chat ids.
export const tgTargets = () => String(process.env.TELEGRAM_NOTIFY || 'st_miki').split(/[\s,;]+/)
  .map((s) => s.trim().replace(/^@/, '')).filter(Boolean);

async function call(method, body) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(8000),
  });
  const d = await res.json().catch(() => ({}));
  if (!d.ok) throw new Error(`Telegram ${method}: ${d.description || `HTTP ${res.status}`}`);
  return d.result;
}

// { chats: [chat id], missing: [username nobody has matched yet] }
export async function resolveChats() {
  const known = Object.fromEntries(((await command('HGETALL', K.tgChats)) || []).reduce((a, v, i, arr) => (i % 2 ? a : [...a, [arr[i], v]]), []));
  const chats = [], missing = [];
  for (const t of tgTargets()) {
    if (/^-?\d+$/.test(t)) chats.push(t);
    else if (known[t.toLowerCase()]) chats.push(known[t.toLowerCase()]);
    else missing.push(t);
  }
  if (missing.length) {
    const found = {};
    let updates;
    try { updates = await call('getUpdates', { allowed_updates: ['message'] }); }
    catch (e) {
      // A bot shared with another app that receives its messages by webhook
      // (e.g. Tempzen's) can't be read here: it needs the numeric chat id.
      if (/webhook|conflict/i.test(e.message)) {
        throw new Error(`this bot delivers its messages to a webhook (another app uses it), so ${missing.map((m) => `@${m}`).join(', ')} can't be looked up by username: set TELEGRAM_NOTIFY to the numeric chat id instead (Telegram's @userinfobot shows yours)`);
      }
      throw e;
    }
    for (const u of updates) {
      const from = u.message?.from, chat = u.message?.chat;
      if (from?.username && chat?.id != null && chat.type === 'private') found[from.username.toLowerCase()] = String(chat.id);
    }
    const now = missing.filter((m) => found[m.toLowerCase()]);
    if (now.length) await command('HSET', K.tgChats, ...now.flatMap((m) => [m.toLowerCase(), found[m.toLowerCase()]]));
    chats.push(...now.map((m) => found[m.toLowerCase()]));
    return { chats, missing: missing.filter((m) => !found[m.toLowerCase()]) };
  }
  return { chats, missing };
}

export async function sendTelegram(text) {
  const { chats, missing } = await resolveChats();
  if (!chats.length) throw new Error(`nobody to notify yet: ${missing.map((m) => `@${m}`).join(', ')} must send /start to the bot first`);
  for (const chat_id of chats) await call('sendMessage', { chat_id, text, disable_web_page_preview: true });
  return { sent: chats.length, missing };
}

// One message for every reply waiting, at most every NOTIFY_EVERY_MIN minutes.
// Replies found meanwhile wait in K.tgPending; a failed send keeps them.
export async function notifyReplies(now, notes = []) {
  if (!tgConfigured()) return null;
  const waiting = Number(await command('LLEN', K.tgPending)) || 0;
  if (!waiting) return null;
  if (now - (Number(await command('GET', K.tgLast)) || 0) < NOTIFY_EVERY_MIN * 60000) return null;
  const raw = (await command('LRANGE', K.tgPending, 0, 49)) || [];
  const items = raw.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  const more = waiting - raw.length;
  const line = (r) => `• ${r.from && r.from !== r.email ? `${r.from} (for ${r.email})` : r.email}${r.company ? ` · ${r.company}` : ''}${r.again ? ' · wrote again' : ''}\n  to ${r.account}${r.subject ? `\n  "${String(r.subject).slice(0, 120)}"` : ''}`;
  const text = `📬 ${waiting} new repl${waiting === 1 ? 'y' : 'ies'}\n\n${items.map(line).join('\n\n')}${more > 0 ? `\n\n…and ${more} more` : ''}\n\nhttps://mailer-tracker.vercel.app/#replies`;
  try {
    const r = await sendTelegram(text);
    await command('LTRIM', K.tgPending, waiting, -1);   // all counted above; any found since stay
    await command('SET', K.tgLast, String(now));
    notes.push(`telegram: ${waiting} repl${waiting === 1 ? 'y' : 'ies'} sent to ${r.sent} chat(s)`);
    return { notified: waiting };
  } catch (e) {
    notes.push(`telegram failed: ${String(e.message || e).slice(0, 200)}`);
    return { error: String(e.message || e).slice(0, 200) };
  }
}

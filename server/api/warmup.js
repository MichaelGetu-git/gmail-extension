// GET/POST /api/warmup — the accounts in email.csv write to each other.
//
// A round is a few groups, each running one 5-email thread between its own
// members (one starts it, four reply), with a random 2 to 60 minutes between
// turns. Only addresses in email.csv ever receive anything. The wording is in
// _warmup_threads.js: everyday office conversations, a different one per group.
//
// - action=init starts a round; the state lives in the store (mailer:warmup:state).
// - /api/tick calls warmupStep() on every tick, which sends whatever is due,
//   one email per tick. No separate schedule is needed.
// - When every group has finished, nothing more is sent until the next init.
// - Independent of the mailer's global pause: outreach can be paused while this runs.

import fs from 'fs';
import path from 'path';
import { timingSafeEqual } from 'node:crypto';
import { command, configured } from './_store.js';
import { send, body } from './_auth.js';
import { hasPassword } from './_settings.js';
import { transportFor } from './_smtp.js';
import { THREADS, threadById, turnText } from './_warmup_threads.js';

const STATE_KEY = 'mailer:warmup:state';
const MIN_DELAY_MIN = Number(process.env.WARMUP_MIN_DELAY_MIN) || 2;
const MAX_DELAY_MIN = Number(process.env.WARMUP_MAX_DELAY_MIN) || 60;

function authorised(req) {
  const secret = process.env.CRON_SECRET;
  const adminPass = process.env.ADMIN_PASSWORD;
  const authHeader = String(req.headers.authorization || '');
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const cronHeader = String(req.headers['x-cron-secret'] || '');
  const adminHeader = String(req.headers['x-admin-password'] || '');

  // 1. Check against CRON_SECRET if configured
  if (secret) {
    const candidate = bearerToken || cronHeader;
    const a = Buffer.from(candidate), b = Buffer.from(secret);
    if (a.length > 0 && a.length === b.length && timingSafeEqual(a, b)) return true;
  }

  // 2. Check against ADMIN_PASSWORD if configured
  if (adminPass) {
    const candidate = adminHeader;
    const a = Buffer.from(candidate), b = Buffer.from(adminPass);
    if (a.length > 0 && a.length === b.length && timingSafeEqual(a, b)) return true;
  }

  return false;
}

const capitalize = (str) =>
  str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : 'Team Member';

const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

// --- Load accounts from email.csv ---
// Each account sends through the mailer's own transport (_smtp.js): its own
// password and mail server (GMAIL_APP_PASSWORD_<NAME>, MAIL_SERVER_<DOMAIN>),
// looked up at send time and never stored in the warmup state.
// An address with no password is left out: it cannot send, and nothing proves
// the mailbox exists, so it is not a recipient either.
function loadAccounts() {
  const csvPath = [path.join(process.cwd(), 'email.csv'), path.join(process.cwd(), 'emails.csv')].find((p) => fs.existsSync(p));
  if (!csvPath) return [];
  const accounts = [];
  for (const line of fs.readFileSync(csvPath, 'utf-8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const parts = line.split(',').map((p) => p.trim().replace(/^["']|["']$/g, ''));
    const email = (parts.find((p) => p.includes('@')) || '').toLowerCase();
    if (!email || !email.includes('.') || !hasPassword(email)) continue;
    accounts.push({ email, name: capitalize(email.split('@')[0].replace(/[^a-zA-Z]/g, '')) });
  }
  return accounts;
}

// --- Initialize State for the 3 Groups ---
function initializeState(accounts) {
  const shuffled = [...accounts].sort(() => 0.5 - Math.random());
  const numGroups = Math.max(1, Math.floor(shuffled.length / 11)); // 3 groups for 38 accounts
  const groups = Array.from({ length: numGroups }, () => []);

  shuffled.forEach((acc, idx) => {
    groups[idx % numGroups].push(acc);
  });

  const now = Date.now();
  const threads = [...THREADS].sort(() => 0.5 - Math.random());
  const msgId = (email) => `<${now.toString(36)}.${Math.random().toString(36).slice(2, 12)}@${email.split('@')[1]}>`;
  return {
    status: 'active',
    updatedAt: now,
    groups: groups.map((grpAccounts, idx) => {
      const initiator = grpAccounts[0];
      const recipients = grpAccounts.slice(1);
      const thread = threads[idx % threads.length];
      return {
        id: idx + 1,
        thread: thread.id,
        subject: thread.subject,
        initiator,
        recipients,
        responders: recipients.slice(0, thread.turns.length - 1),
        turn: 1,
        status: 'in_progress', // 'in_progress' | 'completed'
        dueAt: now + idx * randomBetween(4, 9) * 60000, // the groups do not all start in the same minute
        threadMessageId: msgId(initiator.email),
        lastMessageId: null,
        lastSpeaker: null,
        references: [],
        history: [],
      };
    }),
  };
}

const LOCK_KEY = 'mailer:warmup:lock';

async function readState() {
  const raw = await command('GET', STATE_KEY);
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
}

const finished = (state) => !state?.groups?.length || state.groups.every((g) => g.status === 'completed');

// One step of the warmup: sends the next due email of at most one group, then
// saves the state. Called by /api/tick on every tick, so the scheduler that
// drives the mailer drives this too. Does nothing (returns null) unless a
// warmup was started with action=init and still has turns left. One email per
// step keeps it well inside the function's time limit; the lock stops two
// overlapping ticks from sending the same turn twice.
export async function warmupStep({ now = Date.now() } = {}) {
  if (!configured) return null;
  let state = await readState();
  if (finished(state)) return null;

  const lockId = `${now}-${Math.random().toString(36).slice(2)}`;
  if (!(await command('SET', LOCK_KEY, lockId, 'NX', 'PX', 90000))) return { busy: true };
  try {
    state = await readState(); // again, now that the lock is held
    if (finished(state)) return null;

    const open = state.groups.filter((g) => g.status !== 'completed');
    const group = open.filter((g) => now >= g.dueAt).sort((a, b) => a.dueAt - b.dueAt)[0];
    const pending = open.filter((g) => g !== group).map((g) => ({
      groupId: g.id, nextTurn: g.turn, dueInMinutes: Math.max(0, Math.round((g.dueAt - now) / 6000) / 10),
    }));
    if (!group) return { dispatched: [], pending };

    const thread = threadById(group.thread);
    const isFirstTurn = group.turn === 1;
    const speaker = isFirstTurn ? group.initiator : group.responders[group.turn - 2];
    const advance = () => {
      group.fails = 0;
      if (group.turn < thread.turns.length && group.responders[group.turn - 1]) {
        group.turn += 1;
        group.dueAt = now + randomBetween(MIN_DELAY_MIN, MAX_DELAY_MIN) * 60 * 1000;
      } else {
        group.status = 'completed';
        group.dueAt = null;
      }
    };

    const dispatched = [];
    const transporter = transportFor(speaker.email);
    try {
      const text = turnText(thread, group.turn, { name: speaker.name, prev: group.lastSpeaker });
      const others = [group.initiator, ...group.recipients].filter((r) => r.email !== speaker.email);
      const messageId = isFirstTurn
        ? group.threadMessageId
        : `<${now.toString(36)}.${Math.random().toString(36).slice(2, 12)}@${speaker.email.split('@')[1]}>`;
      const mail = {
        from: `"${speaker.name}" <${speaker.email}>`,
        to: others.map((r) => `"${r.name}" <${r.email}>`).join(', '),
        subject: isFirstTurn ? group.subject : `Re: ${group.subject}`,
        text,
        messageId,
      };
      if (!isFirstTurn) { mail.inReplyTo = group.lastMessageId; mail.references = group.references.join(' '); }

      const info = await transporter.sendMail(mail);
      group.lastMessageId = messageId;
      group.lastSpeaker = speaker.name;
      group.references = isFirstTurn ? [messageId] : [...group.references, messageId];
      group.history.push({ turn: group.turn, sender: speaker.email, sentAt: now, messageId: info.messageId || messageId });
      dispatched.push({ groupId: group.id, turn: group.turn, thread: thread.id, sender: speaker.email, recipients: others.length });
      advance();
    } catch (err) {
      // Try again in 5 minutes; after 3 failures this speaker's turn is skipped
      // so one unreachable mailbox cannot hold the thread forever.
      group.fails = (group.fails || 0) + 1;
      const skip = group.fails >= 3;
      dispatched.push({ groupId: group.id, turn: group.turn, sender: speaker.email, error: String(err.message).slice(0, 160), skipped: skip });
      group.history.push({ turn: group.turn, sender: speaker.email, failedAt: now, error: String(err.message).slice(0, 160) });
      if (skip && !isFirstTurn) advance();
      else if (skip) { group.status = 'completed'; group.dueAt = null; }
      else group.dueAt = now + 5 * 60 * 1000;
    } finally {
      transporter.close();
    }

    state.updatedAt = now;
    await command('SET', STATE_KEY, JSON.stringify(state));
    return { dispatched, pending, allCompleted: finished(state) };
  } finally {
    if ((await command('GET', LOCK_KEY)) === lockId) await command('DEL', LOCK_KEY);
  }
}

// GET/POST /api/warmup?action=…   (CRON_SECRET or ADMIN_PASSWORD, in a header)
//   init    start a new round: shuffle the accounts into groups, first emails due now
//   status  the current state (who sent what, what is due when)
//   reset   forget the state; nothing more is sent
//   tick    one step by hand (the scheduler does this through /api/tick anyway)
export default async function handler(req, res) {
  if (!configured) return send(res, 503, { error: 'no database connected' });
  if (!authorised(req)) return send(res, 401, { error: 'Not authorised. Provide CRON_SECRET or ADMIN_PASSWORD' });

  const action = req.query?.action || body(req)?.action || 'status';
  try {
    if (action === 'reset') {
      await command('DEL', STATE_KEY);
      return send(res, 200, { ok: true, message: 'Warmup state reset' });
    }
    if (action === 'status') {
      const state = await readState();
      return send(res, 200, { ok: true, running: !finished(state), state: state || 'uninitialized' });
    }
    if (action === 'init') {
      const current = await readState();
      if (!finished(current)) return send(res, 409, { error: 'a warmup round is still running; reset it first' });
      const accounts = loadAccounts();
      if (accounts.length < 11) return send(res, 400, { error: `Found only ${accounts.length} accounts with a password. Need at least 11.` });
      const state = initializeState(accounts);
      await command('SET', STATE_KEY, JSON.stringify(state));
      return send(res, 200, { ok: true, message: 'Warmup started', accounts: accounts.length,
        groups: state.groups.map((g) => ({ id: g.id, initiator: g.initiator.email, recipients: g.recipients.length })) });
    }
    if (action === 'tick') return send(res, 200, { ok: true, ...((await warmupStep({ now: Date.now() })) || { idle: true }) });
    return send(res, 400, { error: `unknown action ${action}` });
  } catch (err) {
    return send(res, 500, { error: err.message || 'warmup failed' });
  }
}

// GET/POST /api/warmup — the accounts in email.csv write to each other.
//
// A round is a few groups, each running one 5-email thread between its own
// members (one starts it, four reply), with a random 2 to 60 minutes between
// turns. Only addresses in email.csv ever receive anything.
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

// --- The 4 User Stories across 5 Conversation Turns ---
const STORY_TURNS = [
  {
    turn: 1,
    story: 'Story 1: Lead Import, Auto-Mapping & Pre-flight Suppression',
    promptTopic: 'kicking off the team sprint review discussing Story 1 (CSV lead upload, auto column mapping, seed list suppression, and pre-flight validation before committing to Redis)',
    fallback: (speaker) =>
      `Hi Team,\n\n` +
      `Kicking off our review of the 4 outreach engine user stories before production rollout:\n\n` +
      `First is Story 1 (CSV Lead Upload & Pre-Flight Validation). The dry-run engine parses the CSV, ` +
      `auto-maps custom headers, and validates records against our seed suppression lists and contacted history ` +
      `before anything commits to Redis.\n\n` +
      `Could everyone share feedback on their assigned stories?\n\n` +
      `Best regards,\n${speaker.name}`,
  },
  {
    turn: 2,
    story: 'Story 2: Automated Follow-ups & IMAP Reply/Bounce Detection',
    promptTopic: 'reviewing Story 2 (IMAP inbox monitoring on the \\All mail folder, detecting prospect replies and mailer bounces, matching Message-IDs to halt queued follow-ups, and filtering out auto-replies/OOO)',
    fallback: (speaker) =>
      `Hey team,\n\n` +
      `Checking in on Story 2 (Automated Follow-ups & IMAP Reply Detection).\n\n` +
      `The background inbox scanner is polling the Gmail \\All mail folder via IMAP. When a recipient responds ` +
      `or bounces, it matches the Message-ID and In-Reply-To references, logs the reply, and cancels any pending ` +
      `follow-up touch in the queue. Auto-replies and OOO notices are separated cleanly so real follow-ups aren't disrupted.\n\n` +
      `Best,\n${speaker.name}`,
  },
  {
    turn: 3,
    story: 'Story 3: Dynamic Cold Email Personalization',
    promptTopic: 'reviewing Story 3 (custom subject lines and opening lines per contact, template placeholder substitution, and tracking personal: true in send logs to measure conversion impact)',
    fallback: (speaker) =>
      `Thanks for the update!\n\n` +
      `On Story 3 (Dynamic Subject Lines & Custom Opening Lines):\n\n` +
      `The engine checks for custom 'subject_line' and 'opening_line' columns on each lead, injects them cleanly ` +
      `into the template, and strips placeholders when none are provided. The send logs also record 'personal: true' ` +
      `to benchmark reply rates against standard sends.\n\n` +
      `Cheers,\n${speaker.name}`,
  },
  {
    turn: 4,
    story: 'Story 4: Multi-Account Sending Scheduler with Safety Brakes',
    promptTopic: 'reviewing Story 4 (multi-account scheduler, randomized 3-8 minute jitter delays within the EAT window, atomic daily caps, and auto-pause safety brake on consecutive SMTP failures or >5% bounce rates)',
    fallback: (speaker) =>
      `Checking in regarding Story 4 (Multi-Account Scheduler & Safety Brakes).\n\n` +
      `The scheduler staggers sending across all active sender accounts within the defined window. ` +
      `The randomized jitter between dispatches keeps traffic human-like, and daily caps prevent quota overruns. ` +
      `If consecutive SMTP errors occur or bounce rates exceed 5%, the account automatically pauses.\n\n` +
      `Regards,\n${speaker.name}`,
  },
  {
    turn: 5,
    story: 'Final Sign-off: All 4 Stories Verified & Ready for Rollout',
    promptTopic: 'wrapping up the review thread, confirming all 4 user stories (lead suppression, IMAP reply tracking, dynamic copy personalization, and safe throttled sending) are verified and ready for production deployment',
    fallback: (speaker) =>
      `Awesome work everyone.\n\n` +
      `All 4 user stories (Lead Suppression, IMAP Reply Tracking, Personalization, and Throttled Scheduling) ` +
      `are reviewed and aligned.\n\n` +
      `Let's proceed with the rollout schedule.\n\n` +
      `Best,\n${speaker.name}`,
  },
];

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

// --- Gemini Content Generator ---
async function generateBody(turnData, speaker, isFirstTurn) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    const prompt =
      `You are ${speaker.name}, an engineer on an outreach software team. ` +
      `Write a natural, human email ${isFirstTurn ? 'initiating a team thread' : 'replying to the thread'}. ` +
      `Core topic: ${turnData.promptTopic}. ` +
      `Guidelines:\n` +
      `- Write 2 to 3 short, realistic paragraphs.\n` +
      `- Speak naturally like an engineer or product teammate.\n` +
      `- Do NOT use markdown bolding, bullet points, or subject lines.\n` +
      `- End with a natural sign-off using your name (${speaker.name}).`;

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.9, maxOutputTokens: 350 },
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) return text;
      }
    } catch (err) {
      // Fallback
    }
  }

  return turnData.fallback(speaker);
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
  return {
    status: 'active',
    updatedAt: now,
    groups: groups.map((grpAccounts, idx) => {
      const groupId = idx + 1;
      const initiator = grpAccounts[0];
      const recipients = grpAccounts.slice(1);
      return {
        id: groupId,
        subject: `Sprint Alignment Group ${groupId}: Outreach User Stories & Deliverability`,
        initiator,
        recipients,
        responders: recipients.slice(0, 4),
        turn: 1, // Ready for turn 1
        status: 'in_progress', // 'in_progress' | 'completed'
        dueAt: now + idx * 30000, // Stagger initial start times slightly (0s, 30s, 60s)
        threadMessageId: `<story-grp${groupId}-${now}-${Math.random().toString(36).slice(2)}@${initiator.email.split('@')[1]}>`,
        lastMessageId: null,
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

    const turnData = STORY_TURNS[group.turn - 1];
    const isFirstTurn = group.turn === 1;
    const speaker = isFirstTurn ? group.initiator : group.responders[group.turn - 2];
    const advance = () => {
      group.fails = 0;
      if (group.turn < STORY_TURNS.length && group.responders[group.turn - 1]) {
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
      const text = await generateBody(turnData, speaker, isFirstTurn);
      const others = [group.initiator, ...group.recipients].filter((r) => r.email !== speaker.email);
      const messageId = isFirstTurn
        ? group.threadMessageId
        : `<story-reply-grp${group.id}-${now}-${Math.random().toString(36).slice(2)}@${speaker.email.split('@')[1]}>`;
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
      group.references = isFirstTurn ? [messageId] : [...group.references, messageId];
      group.history.push({ turn: group.turn, sender: speaker.email, sentAt: now, messageId: info.messageId || messageId });
      dispatched.push({ groupId: group.id, turn: group.turn, story: turnData.story, sender: speaker.email, recipients: others.length });
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

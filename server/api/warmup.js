// GET/POST /api/warmup — State-driven warmup conversation engine for Vercel.
//
// Designed to run under Vercel Cron (e.g. every 5 minutes):
// - Stores active thread state in Upstash Redis (mailer:warmup:state).
// - Each invocation checks if any group's randomized delay lap (2 to 60 minutes) has elapsed.
// - If due: dispatches the next turn with Gemini-generated unique copy and schedules the next lap.
// - Executes in 1-3 seconds, completely avoiding Vercel serverless function timeouts.

import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { timingSafeEqual } from 'node:crypto';
import { command, configured } from './_store.js';
import { isAdmin, send, body } from './_auth.js';

const STATE_KEY = 'mailer:warmup:state';
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || '@Qwerty123';
const MIN_DELAY_MIN = Number(process.env.WARMUP_MIN_DELAY_MIN) || 2;
const MAX_DELAY_MIN = Number(process.env.WARMUP_MAX_DELAY_MIN) || 60;

function authorised(req) {
  const secret = process.env.CRON_SECRET;
  const adminPass = process.env.ADMIN_PASSWORD;
  const querySecret = String(req.query?.secret || '');
  const authHeader = String(req.headers.authorization || '');
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const cronHeader = String(req.headers['x-cron-secret'] || '');
  const adminHeader = String(req.headers['x-admin-password'] || '');

  // 1. Check against CRON_SECRET if configured
  if (secret) {
    const candidate = bearerToken || cronHeader || querySecret;
    const a = Buffer.from(candidate), b = Buffer.from(secret);
    if (a.length > 0 && a.length === b.length && timingSafeEqual(a, b)) return true;
  }

  // 2. Check against ADMIN_PASSWORD if configured
  if (adminPass) {
    const candidate = adminHeader || querySecret;
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

// --- Load accounts from email.csv or environment ---
function loadAccounts() {
  const csvCandidates = [
    path.join(process.cwd(), 'email.csv'),
    path.join(process.cwd(), 'emails.csv'),
    path.resolve('./email.csv'),
    path.resolve('../email.csv'),
  ];

  for (const csvPath of csvCandidates) {
    if (fs.existsSync(csvPath)) {
      const content = fs.readFileSync(csvPath, 'utf-8');
      const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const accounts = [];

      for (const line of lines) {
        const parts = line.split(',').map((p) => p.trim().replace(/^["']|["']$/g, ''));
        const email = parts.find((p) => p.includes('@'));

        if (email && email.toLowerCase() !== 'email' && email.includes('.')) {
          const userPart = email.split('@')[0].replace(/[^a-zA-Z]/g, '');
          const domain = email.split('@')[1].toLowerCase();
          const domainVar = `MAIL_SERVER_${domain.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
          const rawHost = process.env[domainVar] || process.env.SMTP_HOST || 'mail.spacemail.com';
          const customHost = String(rawHost).replace(/[\r\n"'\\]/g, '').trim();

          accounts.push({
            email: email.toLowerCase(),
            password: DEFAULT_PASSWORD,
            name: capitalize(userPart),
            host: customHost,
            port: Number(process.env.SMTP_PORT) || 465,
          });
        }
      }

      if (accounts.length > 0) return accounts;
    }
  }

  const envRaw = process.env.ACCOUNT_JSON || process.env.ACCOUNTS_JSON || process.env.ACCOUNTS;
  if (envRaw) {
    try {
      const list = JSON.parse(envRaw);
      return (Array.isArray(list) ? list : Object.values(list)).map((acc) => ({
        email: acc.email,
        password: acc.password || DEFAULT_PASSWORD,
        name: acc.name || capitalize(acc.email.split('@')[0]),
        host: acc.host || 'mail.spacemail.com',
        port: Number(acc.port) || 465,
      }));
    } catch (e) {}
  }

  return [];
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

function createTransporter(account) {
  return nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure: account.port === 465,
    auth: {
      user: account.email,
      pass: account.password,
    },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
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

export default async function handler(req, res) {
  if (!configured) return send(res, 503, { error: 'Redis database is not connected (KV_REST_API_URL/TOKEN)' });
  if (!authorised(req)) return send(res, 401, { error: 'Not authorised. Provide CRON_SECRET or ADMIN_PASSWORD' });

  const queryAction = req.query?.action || body(req)?.action || 'tick';

  // 1. Reset / Clear State Action
  if (queryAction === 'reset') {
    await command('DEL', STATE_KEY);
    return send(res, 200, { ok: true, message: 'Warmup state reset successfully' });
  }

  // 2. Read State from Redis
  let state = null;
  const rawState = await command('GET', STATE_KEY);
  if (rawState) {
    try { state = JSON.parse(rawState); } catch (e) {}
  }

  // 3. Status Action
  if (queryAction === 'status') {
    return send(res, 200, { ok: true, state: state || 'uninitialized' });
  }

  // 4. Initialize if uninitialized or all groups completed
  const accounts = loadAccounts();
  if (accounts.length < 11) {
    return send(res, 400, { error: `Found only ${accounts.length} accounts. Need at least 11.` });
  }

  const allCompleted = state?.groups?.length && state.groups.every((g) => g.status === 'completed');
  if (!state || allCompleted || queryAction === 'init') {
    state = initializeState(accounts);
    await command('SET', STATE_KEY, JSON.stringify(state));
    if (queryAction === 'init') {
      return send(res, 200, { ok: true, message: 'Initialized warmup groups', state });
    }
  }

  const now = Date.now();
  const dispatched = [];
  const pending = [];

  // 5. Evaluate each group for due emails
  for (const group of state.groups) {
    if (group.status === 'completed') {
      continue;
    }

    if (now >= group.dueAt) {
      const turnIndex = group.turn - 1;
      const turnData = STORY_TURNS[turnIndex];
      const isFirstTurn = group.turn === 1;
      const speaker = isFirstTurn ? group.initiator : group.responders[group.turn - 2];

      const transporter = createTransporter(speaker);
      const emailBody = await generateBody(turnData, speaker, isFirstTurn);

      let mailOptions;
      let sentId = null;

      try {
        if (isFirstTurn) {
          mailOptions = {
            from: `"${speaker.name}" <${speaker.email}>`,
            to: group.recipients.map((r) => `"${r.name}" <${r.email}>`).join(', '),
            subject: group.subject,
            text: emailBody,
            messageId: group.threadMessageId,
          };
          group.lastMessageId = group.threadMessageId;
          group.references = [group.threadMessageId];
        } else {
          const replyMessageId = `<story-reply-grp${group.id}-${now}-${Math.random().toString(36).slice(2)}@${speaker.email.split('@')[1]}>`;
          const ccRecipients = [
            group.initiator.email,
            ...group.recipients.filter((r) => r.email !== speaker.email).map((r) => r.email),
          ].join(', ');

          mailOptions = {
            from: `"${speaker.name}" <${speaker.email}>`,
            to: ccRecipients,
            subject: `Re: ${group.subject}`,
            text: emailBody,
            inReplyTo: group.lastMessageId,
            references: group.references.join(' '),
            messageId: replyMessageId,
          };

          group.lastMessageId = replyMessageId;
          group.references.push(replyMessageId);
        }

        const info = await transporter.sendMail(mailOptions);
        sentId = info.messageId || 'sent';

        dispatched.push({
          groupId: group.id,
          turn: group.turn,
          story: turnData.story,
          sender: speaker.email,
          messageId: sentId,
        });

        group.history.push({
          turn: group.turn,
          sender: speaker.email,
          sentAt: now,
          messageId: sentId,
        });

        // Advance to next turn or mark completed
        if (group.turn < 5) {
          group.turn += 1;
          const waitMinutes = randomBetween(MIN_DELAY_MIN, MAX_DELAY_MIN);
          group.dueAt = now + waitMinutes * 60 * 1000;
        } else {
          group.status = 'completed';
          group.dueAt = null;
        }
      } catch (err) {
        dispatched.push({
          groupId: group.id,
          turn: group.turn,
          error: err.message,
        });
        // Retry in 5 minutes on error
        group.dueAt = now + 5 * 60 * 1000;
      }
    } else {
      const waitMin = Math.max(0, ((group.dueAt - now) / 60000).toFixed(1));
      pending.push({
        groupId: group.id,
        nextTurn: group.turn,
        dueInMinutes: Number(waitMin),
      });
    }
  }

  state.updatedAt = now;
  await command('SET', STATE_KEY, JSON.stringify(state));

  return send(res, 200, {
    ok: true,
    dispatched,
    pending,
    allCompleted: state.groups.every((g) => g.status === 'completed'),
  });
}

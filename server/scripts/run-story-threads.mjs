import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';

// --- 1. Configuration & Default Password ---
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || '@Qwerty123';
const MIN_DELAY_MIN = Number(process.env.MIN_DELAY_MIN) || 2;
const MAX_DELAY_MIN = Number(process.env.MAX_DELAY_MIN) || 60;
const RUN_MODE = process.env.RUN_MODE || 'realistic'; // 'test' | 'realistic'

// Capitalize names cleanly: 'aaron' -> 'Aaron'
const capitalize = (str) =>
  str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : 'Team Member';

// --- 2. Load accounts from email.csv (or fallback to JSON / environment variable) ---
function loadAccounts() {
  // Load .env.local or .env if present
  for (const envFile of ['./.env.local', './.env', '../.env.local', '../.env']) {
    const p = path.resolve(envFile);
    if (fs.existsSync(p)) {
      try { process.loadEnvFile(p); break; } catch (e) {}
    }
  }

  // Check for email.csv in current or parent directory
  const csvCandidates = [
    path.resolve('./email.csv'),
    path.resolve('./emails.csv'),
    path.resolve('../email.csv'),
    path.resolve('../emails.csv'),
  ];

  for (const csvPath of csvCandidates) {
    if (fs.existsSync(csvPath)) {
      const content = fs.readFileSync(csvPath, 'utf-8');
      const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

      const accounts = [];
      for (const line of lines) {
        // Handle CSVs that might be raw emails or comma-separated
        const parts = line.split(',').map((p) => p.trim().replace(/^["']|["']$/g, ''));
        const email = parts.find((p) => p.includes('@'));

        // Skip headers like "email" or invalid lines
        if (email && email.toLowerCase() !== 'email' && email.includes('.')) {
          const userPart = email.split('@')[0].replace(/[^a-zA-Z]/g, '');
          const domain = email.split('@')[1].toLowerCase();

          // Check if domain has a custom mail server in env, else fallback to SMTP_HOST or mail.spacemail.com
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

      if (accounts.length > 0) {
        console.log(`✓ Loaded ${accounts.length} accounts from ${csvPath}`);
        console.log(`✓ Default password applied to all: ${DEFAULT_PASSWORD.slice(0, 3)}*****`);
        return accounts;
      }
    }
  }

  // Fallback: Check environment variables or JSON file
  const envRaw = process.env.ACCOUNT_JSON || process.env.ACCOUNTS_JSON || process.env.ACCOUNTS;
  if (envRaw) {
    try {
      const list = JSON.parse(envRaw);
      return (Array.isArray(list) ? list : Object.values(list)).map((acc) => ({
        email: acc.email,
        password: acc.password || DEFAULT_PASSWORD,
        name: acc.name || capitalize(acc.email.split('@')[0]),
        host: acc.host || 'smtp.gmail.com',
        port: Number(acc.port) || 465,
      }));
    } catch (e) {}
  }

  console.error('Error: Could not locate email.csv or accounts configuration.');
  process.exit(1);
}

// --- 3. Delays & Timers ---
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

function getWaitSeconds() {
  if (RUN_MODE === 'test') {
    return randomBetween(10, 20); // 10-20 seconds in test mode
  }
  // 2 minutes to 1 hour delay lap
  const minutes = randomBetween(MIN_DELAY_MIN, MAX_DELAY_MIN);
  return minutes * 60;
}

// --- 4. The 5-Turn Conversation Covering the 4 User Stories ---
const STORY_TURNS = [
  {
    turn: 1,
    story: 'Story 1: Lead Import, Auto-Mapping & Pre-flight Suppression',
    promptTopic: 'kicking off the sprint review and asking the team for feedback on Story 1 (CSV lead upload, auto column mapping, seed list suppression, and dry-run validation before committing to Redis)',
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

// --- Gemini Content Generator (Ensures Zero Email Repetition) ---
async function generateMessageContent(turnData, speaker, isFirstTurn) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    const prompt =
      `You are ${speaker.name}, an engineer on an outreach software team. ` +
      `Write a completely natural, human email ${isFirstTurn ? 'initiating a team thread' : 'replying to the thread'}. ` +
      `Core topic: ${turnData.promptTopic}. ` +
      `Guidelines:\n` +
      `- Write 2 to 3 short, realistic paragraphs.\n` +
      `- Speak naturally like an engineer or product teammate.\n` +
      `- Do NOT use markdown formatting, bold text, bullet points, or subject lines.\n` +
      `- End with a natural sign-off using your name (${speaker.name}).`;

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 350,
          },
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) return text;
      }
    } catch (err) {
      console.warn(`[Gemini] API error: ${err.message}. Using template fallback.`);
    }
  }

  // Fallback to template if Gemini API key is not configured or request fails
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
    tls: {
      rejectUnauthorized: false,
    },
  });
}

// --- 5. Single Group Thread Runner (1 Initiator + 10+ Recipients, 5 Turns) ---
async function runGroupThread(groupAccounts, groupId) {
  const initiator = groupAccounts[0];
  const recipients = groupAccounts.slice(1); // 10 to 12 recipients
  const responders = recipients.slice(0, 4); // 4 recipients reply across turns 2-5

  const prefix = `[Group #${groupId}]`;
  const subject = `Sprint Alignment Group ${groupId}: Outreach User Stories & Deliverability`;

  console.log(`\n${prefix} Initiator: ${initiator.name} <${initiator.email}>`);
  console.log(`${prefix} Recipients: ${recipients.length} accounts in this thread`);
  console.log(`${prefix} Subject: "${subject}"`);

  let threadMessageId = `<story-grp${groupId}-${Date.now()}-${Math.random().toString(36).slice(2)}@${initiator.email.split('@')[1]}>`;
  let currentParentId = threadMessageId;
  const references = [threadMessageId];

  for (let i = 0; i < STORY_TURNS.length; i++) {
    const turnData = STORY_TURNS[i];
    const isFirstTurn = i === 0;
    const speaker = isFirstTurn ? initiator : responders[i - 1];

    console.log(`\n${prefix} [Turn ${turnData.turn}/5] [${turnData.story}]`);
    console.log(`${prefix} Sender: ${speaker.name} <${speaker.email}>`);

    const transporter = createTransporter(speaker);
    const bodyText = await generateMessageContent(turnData, speaker, isFirstTurn);

    try {
      let mailOptions;
      if (isFirstTurn) {
        mailOptions = {
          from: `"${speaker.name}" <${speaker.email}>`,
          to: recipients.map((r) => `"${r.name}" <${r.email}>`).join(', '),
          subject: subject,
          text: bodyText,
          messageId: threadMessageId,
        };
      } else {
        const replyMessageId = `<story-reply-grp${groupId}-${Date.now()}-${Math.random().toString(36).slice(2)}@${speaker.email.split('@')[1]}>`;
        const ccRecipients = [
          initiator.email,
          ...recipients.filter((r) => r.email !== speaker.email).map((r) => r.email),
        ].join(', ');

        mailOptions = {
          from: `"${speaker.name}" <${speaker.email}>`,
          to: ccRecipients,
          subject: `Re: ${subject}`,
          text: bodyText,
          inReplyTo: currentParentId,
          references: references.join(' '),
          messageId: replyMessageId,
        };

        currentParentId = replyMessageId;
        references.push(replyMessageId);
      }

      if (process.env.DRY_RUN === 'true') {
        console.log(`${prefix} [DRY RUN] Simulated sending Turn ${turnData.turn} from ${speaker.email}`);
      } else {
        const info = await transporter.sendMail(mailOptions);
        console.log(`${prefix} ✓ Turn ${turnData.turn} sent successfully. (ID: ${info.messageId})`);
      }
    } catch (err) {
      console.error(`${prefix} ✗ Error sending Turn ${turnData.turn} (${speaker.email}):`, err.message);
    }

    // Delay before the next turn
    if (i < STORY_TURNS.length - 1) {
      const waitSec = getWaitSeconds();
      const waitMin = (waitSec / 60).toFixed(1);
      console.log(`${prefix} ⏳ Waiting ${waitMin} minutes (${waitSec}s) before next reply...`);
      await sleep(waitSec * 1000);
    }
  }

  console.log(`\n${prefix} ★★★ Group #${groupId} finished all 5 conversation turns! ★★★`);
}

// --- 6. Main Multithreaded Orchestrator ---
async function main() {
  const accounts = loadAccounts();

  if (accounts.length < 11) {
    console.error(`Error: Found ${accounts.length} accounts. Need at least 11 accounts for a 1-to-10 conversation.`);
    process.exit(1);
  }

  // Shuffle accounts to ensure natural random pairings
  const shuffled = [...accounts].sort(() => 0.5 - Math.random());

  // Group accounts so every group has 1 sender + 10 to 12 recipients (all 38 accounts included)
  const numGroups = Math.floor(shuffled.length / 11); // 3 groups for 38 accounts
  const groups = Array.from({ length: numGroups }, () => []);

  shuffled.forEach((account, idx) => {
    groups[idx % numGroups].push(account);
  });

  console.log('\n====================================================================');
  console.log(`🚀 MULTITHREADED OUTREACH CONVERSATION RUNNER`);
  console.log(`• Total Accounts Loaded: ${accounts.length} (from email.csv)`);
  console.log(`• Shared Password: ${DEFAULT_PASSWORD.slice(0, 3)}*****`);
  console.log(`• Parallel Groups: ${numGroups} groups running concurrently`);
  groups.forEach((grp, i) => {
    console.log(`   Group ${i + 1}: 1 Initiator + ${grp.length - 1} Recipients (${grp.length} total)`);
  });
  console.log(`• Delay Lap per Turn: ${RUN_MODE === 'test' ? '10-20 seconds' : `${MIN_DELAY_MIN} to ${MAX_DELAY_MIN} minutes`}`);
  console.log(`• AI Variation: ${process.env.GEMINI_API_KEY ? 'Active (Powered by Gemini)' : 'Template Fallback (Set GEMINI_API_KEY to enable AI rewrites)'}`);
  console.log(`• Mode: FULL MULTITHREADED PARALLEL`);
  console.log('====================================================================\n');

  // Launch all groups simultaneously
  const tasks = groups.map((grp, idx) => runGroupThread(grp, idx + 1));
  await Promise.allSettled(tasks);

  console.log('\n====================================================================');
  console.log('🎉 ALL PARALLEL CONVERSATION GROUPS HAVE FINISHED!');
  console.log('====================================================================\n');
}

main().catch(console.error);

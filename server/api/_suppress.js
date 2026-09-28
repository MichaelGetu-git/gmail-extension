// Who must never get a first email (or a follow-up), checked on upload, when a
// day's plan is built, and again right before every send.
//
// Sources, all consulted every time:
//   - the do-not-contact lists bundled at deploy (api/_seed.js, from
//     D:\resume\outreach\_contacted-emails.json / _contacted-domains.json)
//   - the same kind of lists imported into Redis from the dashboard
//   - opt-outs: unsubscribes (mailer:unsub, mapped through our tokens) and
//     manual additions
//   - the extension's own history, pushed by the extension (mailer:ext:contacted)
//   - leads the extension claimed (mailer:leads:claimed) and the Lead Desk's
//     claim state (leaddesk:state) when it lives in this same database
//   - everyone this server has already sent to
import { command, pipeline } from './_store.js';
import { K } from './_settings.js';
import { EMAIL_RE, normEmail, domainOf } from './_render.js';
import { SEED_EMAILS, SEED_DOMAINS } from './_seed.js';

const seedEmails = new Set(SEED_EMAILS);
const seedDomains = new Set(SEED_DOMAINS);
export const seedCounts = { emails: seedEmails.size, domains: seedDomains.size };

// Consumer mailboxes: one person at gmail.com says nothing about another, so
// domain-level suppression skips these (exact addresses are still suppressed).
export const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'gmx.de', 'gmx.net', 'gmx.com', 'web.de', 't-online.de', 'proton.me', 'protonmail.com', 'mail.com', 'yandex.com',
  'zoho.com', 'btinternet.com', 'orange.fr', 'free.fr', 'libero.it']);

// Shared inboxes rather than a named person. The user's rule is named real
// people only, so these are refused for first emails.
const ROLE = /^(info|contact|contacts|office|admin|administrator|sales|hello|hi|support|help|enquiries|enquiry|inquiries|inquiry|mail|email|team|abuse|noreply|no-reply|donotreply|do-not-reply|postmaster|webmaster|hostmaster|billing|accounts|accounting|finance|hr|jobs|careers|recruitment|marketing|press|media|reception|service|services|customerservice|customer\.service|kontakt|buero|bureau|verwaltung|post|mailbox|general|studio|booking|bookings|reservations|orders|shop|store)([._-]?[a-z]{0,3}\d*)?$/i;
export const isRoleAddress = (email) => ROLE.test(normEmail(email).split('@')[0] || '');

let leadDeskIsHash = null;

// emails -> Map(email -> reason or null). firstTouch=false is the follow-up
// check: being in our own sent history (or a contacted list that now includes
// our own sends) is expected there, an opt-out or reply is not.
export async function checkMany(emails, { settings, firstTouch = true } = {}) {
  const out = new Map();
  const list = [...new Set(emails.map(normEmail))];
  if (leadDeskIsHash === null) {
    try { leadDeskIsHash = (await command('TYPE', K.leadDesk)) === 'hash'; } catch { leadDeskIsHash = false; }
  }
  for (let i = 0; i < list.length; i += 300) {
    const chunk = list.slice(i, i + 300);
    const domains = chunk.map(domainOf);
    const cmds = [
      ['SMISMEMBER', K.optout, ...chunk],
      ['SMISMEMBER', K.suppEmails, ...chunk],
      ['SMISMEMBER', K.suppDomains, ...domains],
      ['SMISMEMBER', K.extContacted, ...chunk],
      ['HMGET', K.leadsClaimed, ...chunk],
      ['HMGET', K.sent, ...chunk],
    ];
    if (leadDeskIsHash) cmds.push(['HMGET', K.leadDesk, ...chunk]);
    const [optout, suppE, suppD, ext, claimed, sent, desk] = await pipeline(cmds);
    chunk.forEach((email, j) => {
      const domain = domains[j];
      const domainCounts = !(settings?.freemailDomainExempt ?? true) || !FREEMAIL.has(domain);
      let rec = null;
      try { rec = sent[j] ? JSON.parse(sent[j]) : null; } catch { rec = { corrupt: true }; }
      let reason = null;
      if (!EMAIL_RE.test(email)) reason = 'invalid address';
      else if (Number(optout[j])) reason = 'opted out / unsubscribed';
      else if (rec?.unsubscribedAt) reason = 'unsubscribed';
      else if (rec?.bouncedAt) reason = 'bounced before';
      else if (rec?.repliedAt) reason = 'replied';
      else if (Number(ext[j])) reason = 'in the extension history';
      else if (firstTouch) {
        if (rec) reason = 'already emailed by the server';
        else if (seedEmails.has(email)) reason = 'on the contacted-emails list';
        else if (Number(suppE[j])) reason = 'on the imported contacted list';
        else if (domainCounts && seedDomains.has(domain)) reason = 'domain on the contacted-domains list';
        else if (domainCounts && Number(suppD[j])) reason = 'domain on the imported domains list';
        else if (claimed[j]) reason = 'claimed through the extension';
        else if (desk && desk[j]) reason = 'taken on the Lead Desk';
        else if ((settings?.skipRoleAddresses ?? true) && isRoleAddress(email)) reason = 'role address, not a named person';
      }
      out.set(email, reason);
    });
  }
  return out;
}

export async function checkOne(email, opts) {
  return (await checkMany([email], opts)).get(normEmail(email));
}

export async function importLists({ emails = [], domains = [], optout = [] }) {
  const clean = (arr, re) => [...new Set(arr.map((x) => String(x).trim().toLowerCase()).filter((x) => re.test(x)))];
  const e = clean(emails, EMAIL_RE);
  const d = clean(domains, /^[a-z0-9.-]+\.[a-z]{2,}$/);
  const o = clean(optout, EMAIL_RE);
  const cmds = [];
  for (let i = 0; i < e.length; i += 1000) cmds.push(['SADD', K.suppEmails, ...e.slice(i, i + 1000)]);
  for (let i = 0; i < d.length; i += 1000) cmds.push(['SADD', K.suppDomains, ...d.slice(i, i + 1000)]);
  for (let i = 0; i < o.length; i += 1000) cmds.push(['SADD', K.optout, ...o.slice(i, i + 1000)]);
  const res = await pipeline(cmds);
  return { emails: e.length, domains: d.length, optout: o.length, added: res.reduce((n, r) => n + Number(r || 0), 0) };
}

export async function counts() {
  const [e, d, o, x] = await pipeline([['SCARD', K.suppEmails], ['SCARD', K.suppDomains], ['SCARD', K.optout], ['SCARD', K.extContacted]]);
  return { seedEmails: seedEmails.size, seedDomains: seedDomains.size, importedEmails: e, importedDomains: d, optout: o, extension: x };
}

// Unsubscribes land in mailer:unsub keyed by token (u.js). Map the ones that
// belong to server-sent mail back to addresses and opt them out for good.
export async function syncUnsubscribes() {
  const len = Number(await command('HLEN', 'mailer:unsub')) || 0;
  const seen = Number(await command('GET', K.unsubSeen)) || 0;
  if (len === seen) return 0;
  const flat = (await command('HGETALL', 'mailer:unsub')) || [];
  const tokens = [], at = [];
  for (let i = 0; i < flat.length; i += 2) { tokens.push(flat[i]); at.push(Number(flat[i + 1]) || Date.now()); }
  let n = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const emails = (await command('HMGET', K.tokens, ...tokens.slice(i, i + 500))) || [];
    for (let j = 0; j < emails.length; j++) {
      const email = emails[j];
      if (!email) continue;
      const added = Number(await command('SADD', K.optout, email));
      const raw = await command('HGET', K.sent, email);
      if (raw) {
        const rec = JSON.parse(raw);
        if (!rec.unsubscribedAt) { rec.unsubscribedAt = at[i + j]; await command('HSET', K.sent, email, JSON.stringify(rec)); }
      }
      await command('ZREM', K.fu, email);
      n += added;
    }
  }
  await command('SET', K.unsubSeen, String(len));
  return n;
}

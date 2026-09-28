// The extension's rendering, routing and pre-flight logic, ported from
// content.js so an email sent by the server is byte-for-byte the email the
// extension would have put into Gmail's compose window: same template routing,
// same {{placeholder}} filling, same per-segment default wording, same footer,
// same tracked logo and unsubscribe link with a fresh random token.
//
// test/parity.test.mjs extracts the originals out of ../../content.js and
// compares their output with these on a batch of rows, so if content.js
// changes and this file doesn't, the test fails.
import { randomBytes } from 'node:crypto';

export const TRACKER = process.env.TRACKER_URL || 'https://mailer-tracker.vercel.app';

export const SEGMENTS = [
  { id: 'callcenter', label: 'Call centre',
    match: /call.?cent|property|real.?estate|realtor|estate_agent|law|legal|attorney|notary|insurance|dental|dentist|medical|clinic|doctor|veterinar|hvac|plumb|roof|electric|contractor|trades|car_repair|motor|driving_school|funeral/i },
  { id: 'callcenter-generic', label: 'Call centre (no hours)', match: /^$/ },
  { id: 'tech', label: 'Tech & talent',
    match: /tech|software|saas|engineer|developer|it\b|telecommunication|research|agency|marketing|advertising|consulting|logistics|architect/i },
  { id: 'va', label: 'Virtual assistants',
    match: /virtual|assistant|admin|account|bookkeep|tax|finance|hotel|guest_house|hospitality|travel|education|childcare|school|beauty|hairdresser|fitness|pharmacy|optician|retail|ecommerce|shop|salon/i },
  { id: 'followup', label: 'Follow-up', match: /(?!)/ },
];
export const TEMPLATE_IDS = SEGMENTS.map((s) => s.id);
export const DEFAULT_SEGMENT = 'callcenter';

export const DEFAULT_WORDING = {
  callcenter: {
    business_type: 'a business like yours',
    pain: 'A new customer calls, hits voicemail, and hires whoever picks up next. You never even hear about it.',
  },
  tech: {
    business_type: 'a team like yours',
    pain: "that's work waiting, clients nudging, and you paying recruiter rates to fill one seat.",
  },
  va: {
    business_type: 'a business like yours',
    pain: 'the inbox, the scheduling and the data entry are still eating your evenings.',
  },
};
DEFAULT_WORDING['callcenter-generic'] = DEFAULT_WORDING.callcenter;

export const DEFAULT_SENDER = 'The Zemenay team';

export const DEFAULT_FOOTER =
  'Zemenay Tech · Bole, Addis Ababa, Ethiopia\n' +
  "You're getting this because we thought your team might find it useful. " +
  "Not interested? {{unsubscribe}}.";
// The words the {{unsubscribe}} link shows.
export const UNSUB_LABEL = "Don't send this again";
// The default before the link said "Don't send this again": a footer still
// saved with exactly this text is read as the new default (see _settings.js).
export const PREVIOUS_DEFAULT_FOOTER =
  'Zemenay Tech · Bole, Addis Ababa, Ethiopia\n' +
  "You're getting this because we thought your team might find it useful. " +
  "Not interested? {{unsubscribe}} and we won't email you again.";

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Same alphabet and length as the extension's newToken(): 16 chars of [0-9a-z].
export function newToken() {
  return Array.from(randomBytes(16), (b) => (b % 36).toString(36)).join('');
}

export function parseCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { headers: [], rows: [] };
  const splitLine = (line) => {
    const cells = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else cur += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  };
  const headers = splitLine(lines[0]).map((h) => h.toLowerCase());
  const rows = lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const row = {};
    headers.forEach((h, i) => (row[h] = cells[i] || ''));
    if (!row.name && (row.first_name || row.last_name)) {
      row.name = [row.first_name, row.last_name].filter(Boolean).join(' ');
    }
    return row;
  });
  return { headers, rows };
}

export function fillTemplate(template, row) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const v = row[key.toLowerCase()];
    return v !== undefined ? v : match;
  });
}

export function routeContact(row) {
  const explicit = String(row.segment || '').trim().toLowerCase();
  if (explicit) {
    const hit = SEGMENTS.find((s) => s.id === explicit || s.label.toLowerCase() === explicit);
    if (hit) return hit.id;
  }
  const haystack = [row.vertical, row.category, row.osm_type, row.detail, row.title, row.segment]
    .filter(Boolean).join(' ');
  if (Number(row.eng_roles) > 0) return 'tech';
  if (Number(row.support_roles) > 0) return 'va';
  return (SEGMENTS.find((s) => s.match.test(haystack)) || {}).id || DEFAULT_SEGMENT;
}

// A From name may carry the company ("Michael at ZemenayTech", "Michael @
// Zemenay", "Michael | Zemenay", "Michael from Zemenay"); the email signs off
// with just the name part ("Michael").
export function signOffName(name) {
  const s = String(name || '').trim();
  return s.split(/\s+(?:at|@|\||-|–|from)\s+/i)[0].trim() || s;
}

export function withWording(c) {
  const d = DEFAULT_WORDING[c._segment || routeContact(c)] || DEFAULT_WORDING.callcenter;
  return {
    ...c,
    business_type: String(c.business_type || '').trim() || d.business_type,
    pain: String(c.pain || '').trim() || d.pain,
    sender_name: signOffName(c.sender_name) || DEFAULT_SENDER,
    // {{nick_name}}: the account's nickname, else the name it signs with.
    nick_name: String(c.nick_name || '').trim() || signOffName(c.sender_name) || DEFAULT_SENDER,
  };
}

export function renderFooter(footer, contact, token, { html }) {
  const url = `${TRACKER}/api/u?t=${token}`;
  const MARK = '\u0000unsub\u0000';
  const text = fillTemplate(footer || '', { ...contact, unsubscribe: MARK, unsubscribe_url: url });
  if (!html) return text.replace(MARK, UNSUB_LABEL);
  return escapeHtml(text).replace(/\r?\n/g, '<br>')
    .replace(MARK, `<a href="${url}" style="color:#8a8a8a">${UNSUB_LABEL}</a>`);
}

const FOOTER_BUILTINS = /\{\{(unsubscribe|unsubscribe_url)\}\}/gi;
export const footerSource = (footer) => String(footer || '').replace(FOOTER_BUILTINS, '');

const logoTag = (src) =>
  `<img src="${src}" alt="Zemenay" width="115" height="24" ` +
  'style="display:block;width:115px;height:24px;border:0;margin:0 0 8px">';

export function buildBodyHtml(text, contact, token, footer = DEFAULT_FOOTER) {
  return `<div>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>` +
    '<br><div style="color:#8a8a8a;font-size:12px;line-height:1.5">' +
    logoTag(`${TRACKER}/api/l?t=${token}`) +
    `${renderFooter(footer, contact, token, { html: true })}</div>`;
}

// What the extension's campaign loop does per contact (startCampaign), in one
// call: pick the template, word it, fill it, and build the HTML with the
// tracked footer. The plain-text part is what Gmail itself derives from that
// HTML: the body, then the footer with the unsubscribe address spelled out.
//
// plain: true is the lanes' "Plain text (no footer, no tracking)" mode: the
// email is the filled template body only, as text/plain. No HTML, no footer,
// no logo/open pixel, no tracked or unsubscribe link. `optOut` is an optional
// one-line plain sentence appended after a blank line (no link).
// Per-contact lines from the list (e.g. research on the business):
// subject_line replaces a first email's subject; opening_line goes where the
// template says {{opening_line}}, else right after the greeting line.
// Follow-ups keep their own wording. Without these columns (and without
// {{opening_line}} in the template) the template comes back unchanged, so
// rendering stays identical to the extension's.
const GREETING = /^(hi|hello|hey|dear|good (morning|afternoon|evening))\b[^\n]*,\s*$/i;
export function personalise(tpl, row, templateId) {
  const followUp = /followup$/.test(String(templateId || ''));
  const subj = followUp ? '' : String(row?.subject_line ?? '').trim();
  const open = followUp ? '' : String(row?.opening_line ?? '').trim();
  let body = String(tpl.body ?? '');
  if (/\{\{opening_line\}\}/i.test(body)) {
    if (!open) body = body.replace(/[ \t]*\{\{opening_line\}\}[ \t]*(\r?\n){0,2}/gi, '');
  } else if (open) {
    const cut = body.search(/\r?\n\r?\n/);
    const first = cut >= 0 ? body.slice(0, cut) : body;
    body = cut >= 0 && GREETING.test(first)
      ? `${first}\n\n{{opening_line}}${body.slice(cut)}`
      : `{{opening_line}}\n\n${body}`;
  }
  if (!subj && body === tpl.body) return tpl;
  return { ...tpl, subject: subj ? '{{subject_line}}' : tpl.subject, body };
}

// Which personal lines a first email carries: {subject, opener}, or null.
export function personalFlags(row, templateId) {
  if (/followup$/.test(String(templateId || ''))) return null;
  const subject = Boolean(String(row?.subject_line ?? '').trim());
  const opener = Boolean(String(row?.opening_line ?? '').trim());
  return subject || opener ? { subject, opener } : null;
}

export function renderEmail({ contact, templates, templateId, senderName, nickName = '', token, footer = DEFAULT_FOOTER, plain = false, optOut = '' }) {
  const segId = templateId || contact._segment || routeContact(contact);
  const tpl = personalise(templates[segId] || { subject: '', body: '' }, contact, segId);
  const personal = personalFlags(contact, segId);
  const worded = withWording({ ...contact, _segment: contact._segment || segId, sender_name: senderName || '', nick_name: nickName || '' });
  const subject = fillTemplate(tpl.subject, worded);
  const bodyText = fillTemplate(tpl.body, worded);
  if (plain) {
    const line = String(optOut || '').trim();
    const text = line ? `${bodyText.replace(/\s+$/, '')}\n\n${fillTemplate(line, worded)}` : bodyText;
    return { templateId: segId, subject, bodyText, text, html: '', token, plain: true, personal,
      unsubscribeUrl: null, problems: problems(tpl, worded, line) };
  }
  const html = buildBodyHtml(bodyText, contact, token, footer);
  const footText = renderFooter(footer, contact, token, { html: false })
    .replace(UNSUB_LABEL, `${UNSUB_LABEL} (${TRACKER}/api/u?t=${token})`);
  const text = `${bodyText}\n\n${footText}`;
  return { templateId: segId, subject, bodyText, text, html, token, personal,
    unsubscribeUrl: `${TRACKER}/api/u?t=${token}`, problems: problems(tpl, worded, footer) };
}

// The extension's Check step for one contact: placeholders that survive the
// merge (column missing) and ones that merge to nothing (column empty).
export function problems(tpl, c, footer = DEFAULT_FOOTER) {
  const foot = footerSource(footer);
  const merged = `${fillTemplate(tpl.subject, c)}\n${fillTemplate(tpl.body, c)}\n${fillTemplate(foot, c)}`;
  const missing = [...new Set((merged.match(/\{\{(\w+)\}\}/g) || []).map((m) => m.slice(2, -2).toLowerCase()))];
  const used = [...`${tpl.subject}\n${tpl.body}\n${foot}`.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1].toLowerCase());
  const empty = [...new Set(used.filter((f) => c[f] !== undefined && !String(c[f] ?? '').trim()))];
  const emptyTpl = !String(tpl.subject || '').trim() || !String(tpl.body || '').trim();
  return { missing, empty, emptyTemplate: emptyTpl, ok: !missing.length && !empty.length && !emptyTpl };
}

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
export const normEmail = (e) => String(e || '').trim().toLowerCase();
export const domainOf = (e) => normEmail(e).split('@')[1] || '';

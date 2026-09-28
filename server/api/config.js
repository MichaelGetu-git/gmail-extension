// GET /api/config — templates, limits and the team, for the extension and the editor
// PUT /api/config — save them (editor only, with the admin password)
//
// The extension polls this and follows it, so changing a template or the daily
// limit here reaches every salesperson's copy within minutes, with nothing to
// set on their side. Until the first save, the built-in defaults are served.
import { command, configured } from './_store.js';
import { body, isAdmin, isTeam, send, teamCors } from './_auth.js';
import { DEFAULT_TEMPLATES } from './_defaults.js';

const KEY = 'mailer:config';
export const TEMPLATE_IDS = ['callcenter', 'callcenter-generic', 'tech', 'va', 'followup'];

export const DEFAULT_CONFIG = {
  version: 0,
  dailyLimit: 10,
  followUpDays: 7,
  maxTouches: 3,
  templates: DEFAULT_TEMPLATES,
  senders: {
    'daniellzelalem@gmail.com': '',
    'brookkdaniell@gmail.com': '',
    'berryydaniel@gmail.com': '',
    'noahadanial@gmail.com': '',
  },
  // Optional per-account nickname for {{nick_name}}; empty means the name above.
  nicknames: {},
};

const int = (v, lo, hi, d) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const str = (v, max) => String(v ?? '').slice(0, max);

// Everything is rebuilt from known fields with bounds, so a bad save can't
// break the extension or smuggle anything else in.
export function cleanConfig(input, prev = DEFAULT_CONFIG) {
  const templates = {};
  for (const id of TEMPLATE_IDS) {
    const t = input.templates?.[id] || prev.templates[id] || DEFAULT_TEMPLATES[id];
    templates[id] = { subject: str(t.subject, 300), body: str(t.body, 6000) };
  }
  const senders = {};
  for (const [email, name] of Object.entries(input.senders || prev.senders).slice(0, 20)) {
    const e = String(email).trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)) senders[e] = str(name, 40).trim();
  }
  // Only for accounts on the team list, and only non-empty ones are kept.
  const nicknames = {};
  for (const [email, nick] of Object.entries(input.nicknames || prev.nicknames || {})) {
    const e = String(email).trim().toLowerCase();
    const n = str(nick, 40).trim();
    if (senders[e] !== undefined && n) nicknames[e] = n;
  }
  return {
    version: (prev.version || 0) + 1,
    updatedAt: Date.now(),
    dailyLimit: int(input.dailyLimit, 1, 200, prev.dailyLimit),
    followUpDays: int(input.followUpDays, 1, 60, prev.followUpDays),
    maxTouches: int(input.maxTouches, 1, 5, prev.maxTouches),
    templates,
    senders,
    nicknames,
  };
}

export async function readConfig() {
  const raw = configured ? await command('GET', KEY) : null;
  if (!raw) return DEFAULT_CONFIG;
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }; } catch { return DEFAULT_CONFIG; }
}

// Every save keeps the version it replaced, so the editor can roll back.
export const HISTORY_KEY = 'mailer:config:history';
export async function saveConfig(next, prev) {
  await command('SET', KEY, JSON.stringify(next));
  await command('LPUSH', HISTORY_KEY, JSON.stringify({ ...prev, replacedAt: Date.now() }));
  await command('LTRIM', HISTORY_KEY, 0, 19);
  return next;
}

export default async function handler(req, res) {
  teamCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!configured) return send(res, 503, { error: 'no database connected' });

  try {
    if (req.method === 'GET') {
      if (!isTeam(req)) return send(res, 401, { error: 'not authorised' });
      return send(res, 200, await readConfig());
    }
    if (req.method === 'PUT') {
      if (!isAdmin(req)) return send(res, 401, { error: 'wrong password' });
      const prev = await readConfig();
      const next = cleanConfig(body(req), prev);
      await saveConfig(next, prev);
      return send(res, 200, next);
    }
    return send(res, 405, { error: 'method not allowed' });
  } catch (err) {
    return send(res, 500, { error: err.message || 'store error' });
  }
}

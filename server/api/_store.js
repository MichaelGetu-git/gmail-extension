// Shared state for open tracking and unsubscribes.
//
// Same shape as the Lead Desk store: Upstash Redis over its REST API, so there
// is no driver and nothing to install. Vercel provisions it as "Upstash for
// Redis" and injects the two variables below. It can be the Lead Desk's
// database — the keys here are prefixed `mailer:` and never touch its data.
//
// Nothing here knows who anyone is. The mailer puts a random token in each
// email and keeps the token → address mapping on its own machine, so this
// store holds tokens and timestamps and no personal data at all.

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const configured = Boolean(URL_ && TOKEN);

export async function command(...args) {
  if (!configured) throw new Error('no_store');
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`store ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

// Several commands in one round trip (Upstash's /pipeline endpoint). Returns
// each command's result; a failed command throws, like command() does.
export async function pipeline(cmds) {
  if (!configured) throw new Error('no_store');
  if (!cmds.length) return [];
  const res = await fetch(`${URL_.replace(/\/$/, '')}/pipeline`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!res.ok) throw new Error(`store ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const json = await res.json();
  return json.map((r) => { if (r.error) throw new Error(r.error); return r.result; });
}

export const OPENS = 'mailer:opens';   // field = token, value = JSON [[at, via], ...]
export const UNSUB = 'mailer:unsub';   // field = token, value = timestamp

// The mailer generates these; anything else is a guess or a scanner.
export const isToken = (t) => /^[a-z0-9]{12,40}$/.test(String(t || ''));

// Which mailbox fetched the image. Gmail and Yahoo fetch through their own
// proxies, so the recipient's device is never visible — only the provider.
function via(ua = '') {
  if (/GoogleImageProxy/i.test(ua)) return 'gmail';
  if (/YahooMailProxy/i.test(ua)) return 'yahoo';
  if (/Outlook|Microsoft Office/i.test(ua)) return 'outlook';
  return 'other';
}

// Read-modify-write on one field. Two opens of the same email in the same
// millisecond could drop one hit; that costs nothing worth a Lua script.
export async function recordOpen(token, ua) {
  const prev = await command('HGET', OPENS, token);
  const hits = prev ? JSON.parse(prev) : [];
  hits.push([Date.now(), via(ua)]);
  // Keep the first hit and the latest ones. The first is the open that matters;
  // the tail is enough to see repeat opens without growing forever.
  const kept = hits.length > 20 ? [hits[0], ...hits.slice(-19)] : hits;
  await command('HSET', OPENS, token, JSON.stringify(kept));
}

// Mail proxies cache aggressively; without this a second open never reaches us.
export function noCache(res) {
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, max-age=0, private');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('expires', '0');
}

export function hashToObject(flat, parse = JSON.parse) {
  const out = {};
  if (Array.isArray(flat)) {
    for (let i = 0; i < flat.length; i += 2) {
      try { out[flat[i]] = parse(flat[i + 1]); } catch { /* skip a corrupt row */ }
    }
  }
  return out;
}

export function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'x-mailer-key');
  res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
}

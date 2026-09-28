// Two kinds of caller, two secrets, both set on the Vercel project:
//
//   TEAM_KEY        built into the extension, so every salesperson's copy can
//                   read the templates and claim leads with nothing to type
//   ADMIN_PASSWORD  typed into the editor page to change templates and limits
//
// Either one missing locks its door rather than leaving it open.
import { timingSafeEqual } from 'node:crypto';

function same(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

export const isTeam = (req) =>
  same(req.headers['x-team-key'], process.env.TEAM_KEY) || isAdmin(req);

export const isAdmin = (req) => same(req.headers['x-admin-password'], process.env.ADMIN_PASSWORD);

export function body(req) {
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { return {}; } }
  return req.body || {};
}

export function teamCors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, x-team-key, x-admin-password');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
}

export function send(res, status, obj) {
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.status(status).end(JSON.stringify(obj));
}

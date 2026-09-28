// Gmail SMTP with an app password per account (smtp.gmail.com:465, TLS).
//
// The transport factory is swappable so tests (and dry-run mode) never open a
// network connection: setTransportFactory(() => fakeTransport).
import nodemailer from 'nodemailer';
import { getPassword } from './_settings.js';

let factory = (account) => nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user: account, pass: getPassword(account) },
  connectionTimeout: 15000,
  greetingTimeout: 10000,
  socketTimeout: 20000,
  logger: false,
  debug: false,
});

export function setTransportFactory(f) { factory = f; }

export const dryRunTransport = () => nodemailer.createTransport({ jsonTransport: true });

export function transportFor(account, { dryRun = false } = {}) {
  return dryRun ? dryRunTransport() : factory(account);
}

// Where in the SMTP conversation it failed decides whether the mail could have
// gone out. Before MAIL FROM nothing was handed over, so it is safe to try the
// contact again another day; a rejected RCPT means the address is bad; from
// DATA on, the server may have accepted it, so it is never retried.
export function classifySmtpError(err) {
  const code = err?.code || '';
  const cmd = String(err?.command || '').toUpperCase();
  const rc = Number(err?.responseCode) || 0;
  const msg = String(err?.response || err?.message || 'error').replace(/\s+/g, ' ').slice(0, 300);
  if (code === 'EAUTH' || rc === 535 || rc === 534 || /^AUTH/.test(cmd)) return { kind: 'auth', notSent: true, msg };
  if (/^RCPT/.test(cmd) && rc >= 500) return { kind: 'rejected', notSent: true, msg };
  if (['ECONNECTION', 'ETIMEDOUT', 'EDNS', 'ETLS', 'ESOCKET', 'ECONNREFUSED'].includes(code) &&
      (!cmd || cmd === 'CONN' || /^EHLO|^HELO|^STARTTLS/.test(cmd))) return { kind: 'connection', notSent: true, msg };
  if (/^MAIL/.test(cmd)) return { kind: 'sender', notSent: true, msg };
  if (/^RCPT/.test(cmd)) return { kind: 'transient', notSent: true, msg };
  return { kind: 'unknown', notSent: false, msg };
}

// GET  /api/u?t=<token> — unsubscribe page with a confirm button
// POST /api/u?t=<token> — records the unsubscribe
//
// GET only shows the page. Corporate mail scanners (Microsoft Safe Links,
// Mimecast, Proofpoint) follow every link in an email the moment it arrives,
// so a GET that unsubscribed would opt out every prospect behind one of them
// before a human ever read the message. Scanners do not submit forms.
import { command, configured, isToken, UNSUB } from './_store.js';

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
         font: 16px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; background: #f6f6f4; color: #1d1d1b; }
  main { max-width: 420px; background: #fff; border: 1px solid #e3e3df; border-radius: 12px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 18px; color: #55554f; }
  button { font: inherit; padding: 10px 18px; border-radius: 8px; border: 0; background: #1d1d1b; color: #fff; cursor: pointer; }
  @media (prefers-color-scheme: dark) {
    body { background: #161615; color: #ededea; }
    main { background: #1f1f1d; border-color: #33332f; }
    p { color: #a8a8a2; }
    button { background: #ededea; color: #161615; }
  }
</style></head>
<body><main>${body}</main></body></html>`;

export default async function handler(req, res) {
  const t = String(req.query.t || '').toLowerCase();
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  if (!isToken(t)) {
    return res.status(400).end(page('Link not recognised',
      `<h1>This link isn't valid</h1><p>Just reply to the email and ask us to stop, and we'll take you off the list by hand.</p>`));
  }

  if (req.method === 'POST') {
    if (!configured) {
      return res.status(503).end(page('Try again',
        `<h1>Something went wrong</h1><p>We couldn't record that. Just reply to the email and ask us to stop, and we'll take you off the list by hand.</p>`));
    }
    try {
      await command('HSETNX', UNSUB, t, String(Date.now()));
    } catch {
      return res.status(500).end(page('Try again',
        `<h1>Something went wrong</h1><p>We couldn't record that. Just reply to the email and ask us to stop, and we'll take you off the list by hand.</p>`));
    }
    return res.status(200).end(page('Done',
      `<h1>Done. We won't email you again</h1><p>No more emails from us, including follow-ups. Sorry for the interruption.</p>`));
  }

  return res.status(200).end(page("Don't send this again",
    `<h1>Stop these emails?</h1><p>We won't email you again, including follow-ups.</p>
     <form method="post" action="/api/u?t=${t}"><button type="submit">Don't send this again</button></form>`));
}

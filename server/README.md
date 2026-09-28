# Mailer tracker

A small Vercel app that the mailer puts into every email. It's deployed as
the Vercel project `mailer-tracker` at **https://mailer-tracker.vercel.app**,
and the extension has that address built in. It has these endpoints:

| | |
|---|---|
| `GET /api/l?t=…` | the footer logo; loading it records an open |
| `GET /logo.png` | the same logo, untracked (the sender's own browser is redirected here) |
| `GET /api/o?t=…` | the old 1px pixel, kept so earlier mail still reports opens |
| `GET/POST /api/u?t=…` | the unsubscribe page (GET shows a button, POST records it) |
| `GET /api/events` | every open and unsubscribe, keyed by token, for the extension to pull (needs `x-team-key` or `x-admin-password`) |
| `GET/PUT /api/config` | templates, limits and signatures; the extension polls it (team key), the dashboard saves it (admin password) |
| `POST /api/admin` | everything the dashboard does, including the chart data (`analytics`) (admin password) |
| `GET /api/admin` | the sign-in screen's probe: `{adminConfigured, database}`, nothing else (no password) |
| `GET/POST /api/tick` | sends whatever is due; called by a scheduler (`CRON_SECRET`) |
| `GET/POST /api/leads` | the lead queue for the extension, plus the suppression exchange with it (team key) |
| `GET/POST /api/report` | the extension's campaign totals (merged into the dashboard's Overview) |

Each email carries its own random token in its logo URL and unsubscribe link. The address is never in a URL.
For mail the extension sends, the extension keeps the token → address mapping in
its own history. For mail the server sends itself (below), the server keeps
that mapping in Redis (`mailer:srv:tokens`), so its opens and unsubscribes land
in the same `mailer:opens` / `mailer:unsub` keys and count the same way.

The page at `/` is the dashboard. It opens on a sign-in screen (the
`ADMIN_PASSWORD`, kept in this tab's sessionStorage until you sign out or close
the tab); nothing else is shown before that. After sign-in: **Overview** (KPIs
with week-on-week deltas, the latest replies, sends per day by account or
segment, rate trends, funnel, account health with bounce gauges, follow-up
pipeline, the send-time timeline for today and the next sending day,
performance per segment and per template version), **Replies**, **Templates**,
**Sending**, **Queue**, **Send log** and **Contacts & suppression**. The
Overview's rates are the dashboard's own sends; the *Dashboard + extension*
switch adds the totals the extension reports to `/api/report`. Charts use Chart.js 4.5.1, self-hosted at
`public/vendor/` (no CDN, no build step); the page itself is `public/index.html`,
`app.css` and `app.js`. Server sends record the template version they used from
this release on, so older server sends show as "earlier" in the version table.

## Server-side sending

Besides driving Gmail in the browser, the dashboard can send on its own, from
the four Gmail accounts, over Gmail SMTP with app passwords. It uses the
extension's exact rendering (`api/_render.js` is a port of `content.js`, and
`npm test` fails if they drift): same template routing, same placeholders and
default wording, same footer, same tracked logo and unsubscribe link with a
fresh random token per email.

**Nothing sends until you unpause it.** The global pause is ON by default, and
the server also needs the env vars below and a trigger.

### How a day works

1. **Contacts** come from a CSV uploaded on the *Contacts* tab (same format as
   the extension: `email` column required; with an `email_status` column only
   `valid` rows load). Each contact is routed to a template on upload.
2. On upload, when a day is planned, and again **right before every send**, a
   contact is refused if it is: on the contacted lists bundled at deploy
   (`api/_seed.js`, from `D:\resume\outreach\_contacted-emails.json` and
   `_contacted-domains.json`), on lists imported on the dashboard, opted out or
   unsubscribed, in the extension's history (the extension uploads it), claimed
   through the extension's lead queue, taken on the Lead Desk (if the Lead Desk
   uses this same Redis database), already emailed by the server, a duplicate,
   or a role address like info@ (named people only). The domain list is not
   applied to gmail.com-style consumer domains (exact addresses still are);
   both of those are switches on the *Sending* tab.
3. **Each sending day** (Mon–Fri by default) every unpaused account gets its
   own random start between **09:00 and 11:30 EAT**, then sends its quota with
   **random 3–8 minute gaps**. Default 15 per account per day, max 40.
   Follow-ups (same account as the first email, `followup` template, after
   `followUpDays`, up to `maxTouches`) come first and count toward the cap.
   The plan is stored in Redis, so the *Queue* tab's next-day view is what will
   actually go out. Nothing is sent after 18:00 EAT; anything left goes back
   to the front of the queue for the next day.
4. **Follow-ups only go out if that account's inbox was checked for replies in
   the last 24 hours.** Every tick reads each account's mail over IMAP (same
   app password, read-only) when it hasn't been checked for 10 minutes, for
   replies (they are never followed up) and mailer-daemon bounces. See
   *Replies* below.

### Uploading contacts (preview first)

The upload box (*Contacts* tab for the Regular lane, *Hot leads* for Work/Hot)
takes a CSV by drag-and-drop or the file picker. It lists the columns the
server reads (`email` required; `first_name`, `last_name`, `name`, `company`,
`segment`, `vertical`, `title`, `email_status`, plus any column your templates
use) and offers a **sample CSV** built from those columns and the real
segments. Before anything is saved it shows a **preview**: file name, row
count, the first 10 rows with what will happen to each, a column mapping
(headers like "Email Address" or "Company Name" are matched automatically and
can be changed), how many will be added vs skipped (invalid email, duplicate
in the file, already in a list or emailed before, do-not-email, role address,
not verified), a per-segment count with the template each gets, a warning when
that template is empty, and the lane they go into. **Import** then saves them
and shows the final summary.

The preview is a real dry run on the server, not a guess in the browser:
`{action: "contacts.upload", dryRun: true, csv, lane, includeUnverified, mapping}`
(or `{action: "contacts.preview", ...}`) runs the exact same parsing,
validation, lane and suppression checks as the import and writes nothing (no
lock is taken). `mapping` is `"auto"` or `{target: "csv header"}`; without
it the upload behaves exactly as before. `{action: "contacts.format"}`
describes the accepted columns, segments and which template each segment uses
per lane. The tests prove a dry run leaves every Redis key untouched and that
its counts match the real import.

### Never twice, and other brakes

- One tick at a time (Redis lock). Each account sends at most one email per
  tick and never within 3 minutes of its previous one.
- Before the SMTP call the server claims `email#touch` with `HSETNX`; a
  second claim is impossible, so the same email can't go to the same person
  twice even if two ticks overlap. An item is marked "sending" before the
  network call; if the function dies mid-send it is never retried.
- The daily cap is an atomic counter checked per send.
- An account pauses itself on an SMTP login failure, after 3 failed sends in a
  row, or when more than 5% of its last 50 sends bounced. Resume it on the
  *Sending* tab.
- **Dry-run** renders and logs everything without sending. **Test send**
  sends one `[TEST]` email from a chosen account to an address you type (works
  while paused, max 10 per account per day).
- Every attempt is in the *Send log* (time, account, recipient, template,
  rendered subject and body, SMTP message id and response, status, error).
- Emails with a missing or empty placeholder are held back (switch on the
  *Sending* tab) instead of going out with a hole.

### Test buttons (Sending tab → *Test batch* card)

Both work while sending is paused and outside the window, and only ever touch
contacts whose address is on **Test recipients** (*Schedule and safety*,
saved with *Save schedule*; defaults to the three test inboxes, max 10). Every
other contact is left alone. Both show a confirm dialog listing exactly who
gets what from which account, go through the normal send path (suppression
re-check, rendering, SMTP, send log marked `testBatch`, tracking logo,
never-twice claim, follow-up rotation, bounce auto-pause), respect paused
accounts and the daily cap, send at most one email per account per click, and
share Test send's limit of 10 test emails per account per day.

- **Send test batch now** (`flow.testNow`): a first email to allowlisted
  contacts waiting in the queue.
- **Send test follow-up now** (`flow.testFollowUp`): the next follow-up to
  allowlisted contacts the server already emailed, skipping the follow-up
  wait: same account as their last email, the follow-up template, touch n+1,
  stopping at *max touches*. Like real follow-ups it is not threaded (own
  subject, no `In-Reply-To`). Before sending it maps new unsubscribes and runs
  the inbox check for each involved account (what the timer does many times
  during a real wait); anyone who replied, bounced or unsubscribed is skipped
  with the reason, and a contact whose inbox check fails is held back
  ("click Check inbox, then try again"). Off when *Send follow-ups* is off.

Both are also admin API actions: without `confirm` they only preview; with
`confirm: [emails]` they send to those (allowlisted) addresses.

### Categories switched off

*Sending → Categories that get emails* picks which categories (first-email
templates) are sent. **Virtual assistants is unticked by default** (setting
`skipTemplates: ["va"]`). A contact whose first email would use an unticked
category waits at the front of the queue (the *Queue* tab marks it "not sent:
switched off"), and a contact already emailed with one gets no follow-up. The
test batch leaves them out with the reason, and an email planned before the
switch went off is held back at send time. Ticking the category again sends
them from the next plan on.

### Personal subject and opening lines

**Off by default.** Unless *Use the CSV's own subject and opening lines* is
ticked on the *Sending* tab (setting `personalLines`), both columns are ignored
everywhere (sends, test sends, previews, the queue and the plan) and every first
email is the dashboard template for the contact's category. The columns stay
stored on the contact, so ticking the switch brings them back.

With the switch on, a contact row may carry two optional columns (any other
column works as a `{{placeholder}}` as before):

- `subject_line` replaces the template's subject on that contact's **first**
  email. Follow-ups keep the follow-up template's own subject.
- `opening_line` goes where the template has `{{opening_line}}`, or, if it
  doesn't, right after the greeting line ("Hi {{company}} team,"). A contact
  without one gets the template unchanged, and `{{opening_line}}` in a template
  disappears cleanly (with its blank line) for them, so it is never held back
  as an empty placeholder.

Contacts without these columns render exactly as before (the extension-parity
test still passes).

To add them to contacts **already uploaded**, upload a CSV with `email` plus the
new columns and tick *Update contacts already uploaded (not yet emailed) with
this file's columns* in the preview. Their rows get the file's non-empty values
merged in (a blank cell never erases anything); they keep their place in the
queue and their lane. Anyone the server has already emailed is left alone and
listed as "already emailed, not updated". API: `contacts.upload` /
`contacts.preview` with `updateExisting: true`; the response adds `updated` and
`updatedColumns`.

**Seeing it.** The *Queue* tab shows how many waiting contacts are personalised
(a coverage bar), filters to *Personalised* or *Standard*, and lists each
contact's subject line with the opening line under it; the day plan has the
same column. *Preview* on any queued or planned row opens the exact first email
that contact will get, rendered by the server with the template, account and
lane the send will use (`contact.preview`, records nothing).

**Measuring it.** Every send records whether it carried personal lines (the
touch and its send-log entry get `personal: true`). The Overview's
*Personalised vs standard* card compares reply and open rates per contact
against standard contacts first emailed over the same period
(`analytics.personalisation`: `personal`, `standard`, `standardSamePeriod`,
`since`), and says so while either group is under 30 contacts. Replies and the
send log mark personalised emails.

### Replies

The reply rate is exact only if every reply is found, so the inbox check:

- reads **All Mail** (found by its `\All` flag, so any Gmail language), not just
  INBOX: a reply someone read and archived, or a filter moved, still counts.
  The account's own messages are left out of the search.
- matches a reply by its sender being someone that account emailed, **or** by
  its `In-Reply-To` / `References` pointing at one of our Message-IDs, so a
  colleague answering from another address counts for the person we emailed
  (shown as "answered from …").
- keeps **out-of-office and other auto-replies** apart (`Auto-Submitted`,
  `X-Autoreply`/`X-Autorespond`, `Precedence: auto_reply`, or an
  "Automatic reply:" / "Out of Office:" style subject prefix). They are listed
  under *Replies → Auto-replies*, never count toward the reply rate, and don't
  stop the follow-ups.
- checks every due inbox in one tick (while the tick has time), not one per
  tick. **Run the scheduler all day, not only in sending hours**: ticks outside
  the window send nothing but still pick up replies.

The **Replies** tab lists who replied (name, company, address), when, to which
template and touch, how long after our email, from which account, their
subject, and an *Open in Gmail* link. The Overview shows the latest ones, the
sidebar badge counts replies since you last opened the tab, and a toast says
when a new one arrives. *Check inboxes now* checks every account at once. A
banner warns when an inbox check fails (e.g. a changed app password) or no
check has succeeded for an hour. Admin actions: `replies.list` (`kind`:
`replies`, `auto` or `all`; `q`; `limit`), `replies.latest` (the badge poll,
from the `mailer:srv:replies` feed and `mailer:srv:lastReplyAt`) and `scan.all`.

### Deleting test data (`data.purge`)

*Contacts & suppression → Delete test data* removes named addresses (a test
upload, your own inboxes) and nothing else, so the rates count real prospects
while real sends, their replies and their history stay. Paste addresses, fill
in the *Test recipients*, or take every address out of a CSV (such as the test
file you uploaded), click **Preview**, then **Delete**.

`POST /api/admin {action: "data.purge", emails: [...]}` (up to 100) reports,
per address, what is stored and deletes nothing. With `confirm: "DELETE"` it
removes each address's contact record, queue and day-plan entries, send record,
tokens and their open and unsubscribe hits, never-twice claims, follow-up and
per-account history, send-log entries (test sends included) and their bodies,
and replies-feed entries. It first writes all of it to
`mailer:backup:purge:<timestamp>` (one field per address, kept 180 days) and
reads it back. Suppression lists are kept; `alsoOptout: true` also takes the
addresses off the opt-out list (for your own test inboxes only).

### Resetting the data (`data.reset`)

`POST /api/admin {action: "data.reset"}` lists what a reset would remove and
deletes nothing. `{action: "data.reset", confirm: "RESET"}` empties the sending
data: contacts, queue, day plans, the send log and bodies, send records and
tokens, never-twice claims, follow-up rotation, per-account history and
counters, test-send counters, and the open records of server-sent mail, test
sends and `zzjunkzz…` probes. It keeps settings, templates and their history,
sender accounts and their states, every suppression list, unsubscribes, the
extension's own open records and reports, and any key it doesn't recognise.
Before deleting it writes everything it removes to
`mailer:backup:reset:<timestamp>` (kept 180 days), reads it back, and returns
it in the response.

### Sender names

Each account's name is set on the *Templates* tab (*Signatures and extension
limits*), for example "Berry". Server sends go out as
`Berry <berryydaniel@gmail.com>` and sign off "Berry". A name saved with the
company ("Berry @ ZemenayTech", "Berry at ZemenayTech") is cut to "Berry" in
both places. An account with no name sends from its bare address and signs off
"The Zemenay team".

Next to each name is an optional **nickname**, used wherever a template says
`{{nick_name}}` ("Hey, this is {{nick_name}} from Zemenay"). Set it only on the
accounts that need one; an account without a nickname fills `{{nick_name}}`
with its name. It is saved with the templates (`nicknames` in `/api/config`),
so the extension fills `{{nick_name}}` the same way.

### Environment variables (Vercel → Settings → Environment Variables)

| Name | What |
|---|---|
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | already set by the Upstash integration |
| `ADMIN_PASSWORD` | the password for the dashboard's admin tabs and template saving |
| `TEAM_KEY` | must equal the `TEAM_KEY` constant in `background.js`; without it the extension can't read templates, pull opens/unsubscribes from `/api/events`, or exchange suppression lists |
| `CRON_SECRET` | a long random string; `/api/tick` refuses every call without it |
| `GMAIL_APP_PASSWORD_DANIELLZELALEM` | app password for daniellzelalem@gmail.com |
| `GMAIL_APP_PASSWORD_BROOKKDANIELL` | app password for brookkdaniell@gmail.com |
| `GMAIL_APP_PASSWORD_BERRYYDANIEL` | app password for berryydaniel@gmail.com |
| `GMAIL_APP_PASSWORD_NOAHADANIAL` | app password for noahadanial@gmail.com |
| `TRACKER_URL` | optional; defaults to `https://mailer-tracker.vercel.app` |

The rule for a password variable is `GMAIL_APP_PASSWORD_` plus the part before
the `@`, uppercased. App passwords need 2-Step Verification on the Google
account (Google Account → Security → App passwords); spaces are ignored. They
are only ever handed to the SMTP/IMAP client: never logged, stored or returned.
An account without one simply doesn't send (the dashboard says so). Redeploy
after changing env vars.

### The trigger (something must call `/api/tick`)

Vercel's Hobby plan runs cron jobs at most **once a day**, somewhere inside the
scheduled hour, which can't do 3–8 minute gaps. `vercel.json` still has one
daily Vercel cron (06:00 UTC = 09:00 EAT, weekdays) as a backstop, but the real
trigger is external. Pick one (both is fine: ticks are idempotent):

**Option A — cron-job.org (free, simplest).** Sign up at cron-job.org → *Create
cronjob*:
- URL `https://mailer-tracker.vercel.app/api/tick`
- Schedule: every minute; *Custom*: days Mon–Fri, hours 9–17, timezone
  `Africa/Nairobi`
- *Advanced* → Headers: `Authorization` = `Bearer <your CRON_SECRET>`;
  request method GET; timeout 30 s. Save, then *Test run*: the response should
  be `{"ok":true,...}` (with `"paused":true` until you unpause).

**Option B — Upstash QStash** (Upstash console → QStash; free tier 1,000
messages/day). Copy the QStash token, then:

```bash
curl -X POST "https://qstash.upstash.io/v2/schedules/https://mailer-tracker.vercel.app/api/tick" \
  -H "Authorization: Bearer <QSTASH_TOKEN>" \
  -H "Upstash-Cron: * 6-14 * * 1-5" \
  -H "Upstash-Method: POST" \
  -H "Upstash-Retries: 0" \
  -H "Upstash-Forward-Authorization: Bearer <your CRON_SECRET>"
```

(QStash cron is UTC: `6-14` is 09:00–17:59 EAT; 540 calls a day. Use the
QStash URL your console shows if it isn't `qstash.upstash.io`.)

Once a trigger runs, the *Sending* tab shows "Last tick". Then: upload
contacts, check the *Queue* tab's next-day plan, send yourself a test from
each account, and unpause.

### Redis keys used by server sending

All under `mailer:srv:` (plus `mailer:config:history` for template versions
and `mailer:ext:contacted` for the extension's uploaded history): settings,
per-account state, the contact queue, per-day plans, the sent history and
token map, the never-twice claims, follow-up candidates, per-day cap counters,
the send log (last 3,000), suppression sets, per-day test-send counters
(`mailer:srv:tests:<date>`) and reset backups (`mailer:backup:reset:<ts>`).

### Refresh the bundled suppression lists

`api/_seed.js` is a snapshot of the two contacted files. Refresh it before a
deploy (or import the files on the *Contacts* tab, which adds to Redis):

```bash
cd D:/gmail-list-mailer/server
node scripts/sync-suppression.mjs
```

### Tests and local preview

```bash
npm install
npm test                      # needs redis-server; fake SMTP/IMAP, nothing is sent
node test/dev-server.mjs      # http://127.0.0.1:3100, admin password "dev", fake SMTP
DEV_SEED=1 node test/dev-server.mjs     # the same, filled with realistic sample data
DEV_NO_ADMIN=1 node test/dev-server.mjs # ADMIN_PASSWORD unset: the sign-in screen says so
```

## Why this isn't part of the Lead Desk

Every recipient can see this app's address: it's in the image URL and the
unsubscribe link. The Lead Desk serves your lead list at its root, and its
README says to keep that URL private. Keep them as separate projects. They can
share the same Upstash database, because keys here are prefixed `mailer:`.

## Deploy

```bash
cd D:/gmail-list-mailer/server
node scripts/sync-suppression.mjs   # refresh the bundled do-not-contact lists
npx vercel --prod
```

Then, in the Vercel dashboard:

1. **Storage → connect Upstash for Redis.** You can reuse the Lead Desk's
   database. Vercel injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
2. **Set the env vars** listed under *Server-side sending* above
   (`ADMIN_PASSWORD`, `TEAM_KEY`, `CRON_SECRET`, the four app passwords).
3. **`MAILER_KEY` is optional and legacy.** `/api/events` only answers
   callers holding `TEAM_KEY` (the extension sends it as `x-team-key`) or the
   admin password; if `MAILER_KEY` is set, `x-mailer-key` works too. Without
   one of them it returns 401 and no data. It holds only codes and
   timestamps, never names or addresses.
4. **Optional: add a domain on the sending domain**, such as
   `track.zemenaytech.com`. Links to a `*.vercel.app` address in cold email
   look like spam to filters. A subdomain of the domain you send from looks
   like you.
5. Redeploy. If the address ever changes, update `TRACKER` in `content.js` and
   `background.js`, and the tracker host in `manifest.json`.

## What an "open" means

- **Apple Mail over-counts.** Mail Privacy Protection downloads every image
  as soon as the email arrives. Every Apple Mail recipient shows as
  "opened", whether or not they read it.
- **Many clients under-count.** Outlook desktop and plenty of corporate setups
  block images by default. Those recipients never show as opened, even after
  reading.
- **Gmail hides the device.** Gmail fetches images through its own proxy, so
  the tracker learns only that a Gmail user opened the email, not where.
- **Your own views are filtered out.** In the sender's browser, the extension
  redirects the tracked logo to the untracked `/logo.png`. It also notes when
  you view your own sent copy and discounts the hit that view causes.

Use open rate to compare templates and to spot deliverability problems. For
example, near-zero opens on one sending domain usually means its mail is going
to spam. Replies are still the number to trust.

Tracking through a visible logo rather than a hidden 1px pixel avoids the
tiny-invisible-image pattern that some spam filters score.

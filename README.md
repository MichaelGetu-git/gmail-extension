# Gmail List Mailer

A Chrome extension that sends a templated email to a list of contacts from a CSV file, by driving Gmail's own compose window.

It works inside your open Gmail tab: it clicks **Compose**, fills in the recipient, subject, and body, then clicks **Send** and waits for Gmail to confirm before moving to the next contact. No API keys, no SMTP, no OAuth. Mail goes out from whichever account that tab is signed in to.

## Load it in Chrome

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Open `mail.google.com` in a tab, signed in to the account you want to send from
5. Open the extension popup and confirm the **Sending from** address is correct

## Which account it sends from

**Whichever Gmail tab you are looking at.** The panel opens in the active Gmail tab and states the
detected address at the top — check it before starting.

This used to be pinned to the default account (`/mail/u/0/`), with `/mail/u/1/` and up deliberately
ignored. That was wrong once outreach had been sent from more than one address: the other
mailboxes were invisible, so their history could not be imported and their deliverability could
not be measured. To work with a particular account, open its Gmail tab and click the toolbar icon
there.

History is shared across accounts, so importing from several merges into one picture, and every
send records which mailbox it went out from. The dashboard breaks reply and bounce rates down per
sending address — which is the comparison that matters, because deliverability is a property of
the sending domain, not of the copy.

## CSV format

First row is headers, one column must be named `email`.

```csv
company,first_name,last_name,title,location,linkedin_url,email,email_status
Zemenay Tech,Michael,G.,Founder,"Addis Ababa, Ethiopia",https://...,michael@example.com,valid
```

- Any column is available in the template as `{{column}}` — `{{company}}`, `{{title}}`, `{{location}}`
- `first_name` + `last_name` are combined into `{{name}}` automatically
- If an `email_status` column exists, only `valid` rows are loaded by default; the checkbox includes the rest

Template example:

```
Subject: Quick question, {{name}}
Body: Hi {{name}}, saw {{company}} is hiring for {{title}}...
```

Use `test-contacts.csv` for a dry run before pointing it at a real list.

## Three templates, routed automatically

There are three templates, one per offer — **Call centre**, **Tech & talent**, and **Virtual
assistants** — and each contact is sent through whichever one fits it. You do not split the CSV or
run three campaigns; you load one list and every row gets the right message.

Routing is decided per row, in this order:

1. An explicit `segment` column (`callcenter`, `tech`, or `va`) — the list decides, not the guesser
2. `eng_roles` greater than zero → **Tech & talent**, because open engineering roles outrank
   whatever industry the company is in
3. `support_roles` greater than zero → **Virtual assistants**
4. Otherwise a keyword match against `vertical`, `category`, `osm_type`, `detail` or `title`
5. Falling back to **Call centre**

The tab for each segment shows how many of the selected contacts it will send, and each row in the
contact list is tagged with the template it will use. Editing the subject or message only changes
the template you have open; all three are saved separately and persist across reloads.

## Check before you send

The **Check** button renders every selected contact against its template without sending anything,
and reports what would have gone wrong:

- **Missing columns** — the template says `{{hours_gap}}` and the CSV has no such column, so the
  recipient receives a literal `{{hours_gap}}`
- **Empty values** — the column exists but this row's is blank, which is the quieter failure: the
  placeholder vanishes and leaves *"I saw Acme Ltd is ."* mid-sentence
- **Duplicates** within the list, **invalid addresses**, and anyone already contacted
- A per-segment breakdown and the count that would actually send

It then shows the fully merged first email for the segment you are editing, addressed to a real
contact, so you read what they will read.

This matters more here than in most tools: there is no unsend. On a first run against a real
4,000-row list this caught 499 rows that would have gone out with a broken placeholder.

## Results, follow-ups and the dashboard

The **Results** section tracks what actually happened, using your real mailbox — there is no mock
data anywhere in this, and nothing is estimated.

**Import sent** reads your Sent folder and reconstructs history from mail that went out before the
extension was tracking anything. It records the recipient, date and subject of each message and
guesses nothing else — the segment is left blank rather than inferred from a subject line, because
a wrong segment would corrupt the one number the dashboard exists to report. Use it once, when you
first want a picture of outreach already done.

**Scan inbox** drives Gmail's own search to find:

- **Replies** — searched in batches of 25 addresses (`from:(a@x OR b@y) newer_than:60d`). Only the
  address attribute on the row is trusted; a display name that happens to match is not evidence,
  and a false positive would silently drop a live prospect out of every future follow-up.
- **Bounces** — mail from `mailer-daemon` or `postmaster`, matched against contacts you actually
  emailed, and classified as address-does-not-exist, mailbox-full, or blocked-as-spam.

Both move the Gmail view while they run, so neither will start during a campaign.

**Follow-ups** builds a queue from history rather than from a CSV — the point is chasing people
whose original list you may no longer have open. A contact appears three days after its last
email, unless it replied or bounced, and drops out after three touches. Sending that queue uses
the template each contact was originally sent, and skips anyone who has since replied.

**Dashboard** opens the results page in a new tab, and on first open it **reads every signed-in
Gmail account by itself** — no per-account clicking. It walks `/mail/u/0/`, `/mail/u/1/` and
upward in background tabs, pulls each account's Sent mail, replies and bounces into one shared
history, and closes any tab it opened. Accounts are probed rather than listed because Gmail
publishes no index of how many are signed in; a gap left by a removed account is stepped over,
and probing stops after two consecutive empty slots.

After that it reads storage directly, so there is no export step and nothing to upload — open it
and it is current, and it updates while a campaign runs. **Refresh** in the bar at the top re-reads
the mailboxes, and the bar says how long ago that last happened. It shows contacts, emails sent, reply rate, bounce rate, activity by day,
performance per template and per industry, a breakdown **per sending address**, and the full
contact table.

**Export** is only for publishing a copy somewhere else, such as the Vercel version in
`../leads/dashboard/`. You never need it to see your own numbers.

## Footer, unsubscribe and open tracking

Every email ends with a footer in small grey text. At the top is the blue
Zemenay logo, followed by who sent the email, a postal address, and an
unsubscribe link. Anti-spam law (CAN-SPAM, CASL, GDPR/PECR) requires these
things, and filters look for them. You can edit the footer's wording in the
panel. `{{unsubscribe}}` becomes the link, and CSV columns such as
`{{company}}` work too. **Check** validates the footer's columns the same way
it validates the subject and body.

**The logo is the open tracker.** Each email's logo URL carries a random code
unique to that email. When the recipient's mail app loads the logo, the
[tracker](server/README.md) at `mailer-tracker.vercel.app` records an open.
There's no hidden pixel, and the recipient's address never appears in a URL.
None of this needs setting up: the tracker is built in.

- Opens are pulled automatically every 10 minutes, and whenever the panel or
  dashboard opens.
- Your own views don't count. In this browser, the extension swaps in an
  untracked copy of the logo, so writing or reviewing an email isn't an open.
  It also notes when you view your own copy in Sent and discounts it.
- Unsubscribes are pulled before every run and added to the do-not-email list.
  An unsubscribed contact is never emailed again, even with the skip box
  unticked or in a follow-up run. A run won't start if the tracker can't be
  reached, because someone who opted out yesterday must not get today's email.

On the **dashboard**, opens have their own section:
- an open-rate tile
- first opens per day on the activity chart
- open rate by offer and by sending address
- a **Recently opened** feed that flags anyone who opened more than once
  without replying, since that's the warmest follow-up on the list
- Opens and Last-opened columns in the contacts table

The open rate counts only contacts who were sent a tracked logo, so imported
mail doesn't drag it down.

Open counts are estimates. Apple Mail over-counts them and image-blocking
clients under-count them; [`server/README.md`](server/README.md) explains why.
When you test, open the email on your phone or in a different mail app.

## Nobody gets emailed twice

Every address that Gmail confirms is recorded permanently. On any future run — different CSV,
different day, different segment — those contacts are skipped and shown struck through in the
list. Failures are not recorded, so a genuine error can be retried.

Paste addresses into the same store to honour opt-outs. Uncheck **Skip anyone already emailed or
opted out** only if you deliberately intend a second touch, and note that follow-ups in the same
thread are usually the better way to do that.

## Where the mailer lives

Click the extension icon. It focuses your Gmail tab (opening one if needed) and shows the composer as a floating panel inside the page. There is no popup.

Drag it by its header, resize from the grip in the bottom-left corner, collapse it to a title bar with –, and dismiss it with ×. Size and position persist, and dismissing sticks across Gmail reloads, so the panel only comes back when you click the toolbar icon. The one exception is an unfinished run, which always reopens the panel so you don't lose the queue.

It runs there rather than in the popup for a reason: the popup closes the moment you click away, and Chrome shuts down a Manifest V3 background worker after about 30 seconds of inactivity. A run driven from either one dies partway through. Inside the Gmail page it keeps going while you work in other tabs.

If a run is interrupted (you close the tab, Gmail reloads), the remaining contacts are saved. Reopen the panel and it offers to resume them.

## Contact list and row range

After loading a CSV the panel lists every contact it will use, numbered, with the name and address. Two boxes above it set which rows to send: rows outside the range are dimmed and excluded. The numbers refer to the filtered list you can see, not to line numbers in the file, so they stay correct when unverified addresses are being skipped.

Use it to send in batches (1 to 50 today, 51 to 100 tomorrow) or to retry a single contact without reloading anything. Reversed values are tolerated.

While a run is going, each row updates in place: highlighted for the one being sent, green when accepted, red when it failed.

## Sending modes

- **Review mode (default, checkbox off)**: fills the compose window and stops. You read it and click Send yourself. The queue advances once you send or discard the draft, so drafts never stack up.
- **Auto-send (checkbox on)**: also clicks Send for you, waits for Gmail to accept it, then moves on after your delay.

The log reports what actually happened per contact. A send is only counted when Gmail tears down the compose window, which it does only once the send is accepted — so a "Sent" line means it really went out, and failures say why.

## Running it in the background

You can switch tabs and keep working. The run lives in the Gmail page, so it is not affected by the popup closing or by a background worker being shut down.

Chrome throttles timers in tabs you aren't looking at, down to roughly once a minute after a few minutes hidden. Two things deal with that.

**Detection is not on a timer.** Finding Gmail's compose window uses a MutationObserver, so it reacts to the DOM change itself. Measured under 7x throttling, both "compose opened" and "send accepted" were detected in under a millisecond. This is what stops a throttled tab from reporting a timeout for a send that was actually fine.

**Keep full speed in a background tab** (checkbox, on by default) plays a 40Hz tone at 0.001 gain for the duration of a run. Chrome exempts tabs that are playing audio from throttling, so pacing stays at whatever delay you set. Measured on a hidden tab, a 100ms timer took 1005ms with no audio and 108ms with the tone. Audibility is what Chrome keys on, not merely holding an audio context: a gain of 0.0001 made no difference at all, while 0.001 lifted the throttling completely.

At that level and frequency the tone is inaudible in normal use, but the tab does show the usual speaker icon while sending, which doubles as a signal that a run is still going. Muting the tab in Chrome defeats the exemption and puts throttling back. Turn the checkbox off if you would rather have no audio and accept slower pacing.

## Server-side sending from the dashboard

The dashboard at `mailer-tracker.vercel.app` can also send by itself, from the
four Gmail accounts over SMTP with app passwords, on a randomized weekday
schedule (each account starts at a random time between 09:00 and 11:30 EAT,
then 3–8 minute gaps, 15 a day per account by default). It renders exactly
what this extension renders: same routing, templates, placeholders, footer,
tracked logo and unsubscribe link. It is **paused until you unpause it** on
the dashboard. Setup, env vars and the trigger are in
[`server/README.md`](server/README.md#server-side-sending).

The two never email the same person: on every sync this extension uploads the
addresses in its history and do-not-email list to the dashboard, and
downloads the addresses the dashboard has emailed, which the send loop then
skips in every mode ("already emailed by the dashboard's server sending").
Templates edited on the dashboard reach both.

## Limits and notes

- Gmail caps outgoing mail at ~500/day on personal accounts, ~2000/day on Workspace.
- Leave the Gmail tab open and visible while a run is going. Clicking around in it mid-run can steal focus from the compose window.
- Auto-send depends on matching Gmail's DOM (Compose button, To/Subject/Body fields, Send button). If Google reshuffles their markup this can break — the extension reports an error rather than silently doing nothing, and review mode is the safe fallback.
- Sending hundreds of near-identical cold emails from a personal Gmail account is a good way to get it rate-limited or flagged. Keep the delay at a few seconds, start with a small batch, and make sure your template is something a human would actually want to receive.
#   g m a i l - e x t e n s i o n  
 "# gmail-extension" 
"# gmail-list-mailer" 

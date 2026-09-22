// Everything runs inside the Gmail tab: the panel UI, the CSV, and the send
// loop. The loop used to live in the MV3 service worker, which Chrome kills
// after ~30s idle, so a run died as soon as the popup closed.

// ---------------------------------------------------------------- Gmail DOM

const BRAND = {
  name: "ZemenayTech",
  website: "https://zemenaytech.com/",
  logoUrl: "https://zemenaytech.com/logo/logo.svg",
  blue: "#0B5ED7",
};

// Set baseUrl and writeKey after deploying tracker/. Leave baseUrl empty while
// testing locally; emails will then be sent without a tracking pixel.
const TRACKING = {
  baseUrl: "https://tracker-roan-xi.vercel.app",
  writeKey: "5fe3df4eadef0b06664e4e090eb8850a3711ca7b8ff9b34e87467242e20ac9a7",
};

function createTrackingId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function registerTracking({ trackingId, contact, segment, subject }) {
  if (!TRACKING.baseUrl) return null;

  const res = await fetch(`${TRACKING.baseUrl}/api/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Write-Key": TRACKING.writeKey,
    },
    body: JSON.stringify({
      trackingId,
      recipientEmail: contact.email,
      company: contact.company || "",
      segment,
      subject,
    }),
  });

  if (!res.ok) {
    throw new Error(`Tracking registration failed (${res.status})`);
  }
  return trackingId;
}

const SEL = {
  composeButton: ['div[gh="cm"]', 'div[role="button"][gh="cm"]'],
  subject: ['input[name="subjectbox"]', 'input[aria-label="Subject"]'],
  to: [
    'input[aria-label="To recipients"]',
    'input[peoplekit-id]',
    'input[name="to"]',
    'textarea[name="to"]',
    '[role="combobox"][aria-label^="To"]',
  ],
  body: [
    'div[role="textbox"][aria-label*="Message Body"]',
    'div[g_editable="true"]',
    'div[contenteditable="true"][role="textbox"]',
  ],
  send: [
    'div[role="button"][data-tooltip^="Send"]',
    'div[role="button"][aria-label^="Send"]',
    'div.T-I.aoO',
  ],
  // Thread-list rows in a search result, and the sender cell inside one. Gmail
  // puts the real address in an `email` attribute, which survives display-name
  // changes and is far steadier than parsing the visible text.
  threadRow: ["tr.zA", 'div[role="listitem"]'],
  rowSender: ["span[email]", "span.yP", "span.zF"],
  rowSnippet: ["span.y2", ".y6 + .y2"],
  rowSubject: ["span.bog", ".y6 span"],
};

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// Prefer a visible match, but fall back to a hidden one — Gmail keeps some
// legacy fields in the DOM behind the visible peoplekit inputs.
function pick(root, selectors) {
  let fallback = null;
  for (const sel of selectors) {
    for (const el of root.querySelectorAll(sel)) {
      if (isVisible(el)) return el;
      if (!fallback) fallback = el;
    }
  }
  return fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Chrome throttles timers in tabs you aren't looking at, down to roughly once a
// minute after a few minutes hidden. A poll-only wait therefore misses the
// moment Gmail opens or closes a compose window and reports a timeout for a
// send that was fine. A MutationObserver fires on the DOM change itself, so
// detection stays immediate no matter how throttled the tab is. The interval is
// only a backstop for conditions no mutation announces, and the timeout firing
// late under throttling is harmless: it makes the wait more patient, not less.
function waitFor(fn, timeoutMs, pollMs = 500) {
  const read = () => {
    try {
      return fn();
    } catch {
      return null;
    }
  };

  const immediate = read();
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    let settled = false;
    let lastCheck = 0;

    const finish = (val) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearInterval(poller);
      clearTimeout(timer);
      resolve(val);
    };

    const check = () => {
      if (settled) return;
      const now = Date.now();
      // Gmail mutates constantly; don't re-run the predicate on every batch.
      if (now - lastCheck < 50) return;
      lastCheck = now;
      const val = read();
      if (val) finish(val);
    };

    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const poller = setInterval(check, pollMs);
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

// Gmail tracks its own value state, so a plain el.value = x is ignored.
function setNativeValue(el, value) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function setBody(el, html) {
  el.focus();
  document.execCommand("selectAll", false, null);
  document.execCommand("delete", false, null);

  el.innerHTML = html;
  el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function createEmailHtml(body, trackingUrl = "") {
    const bodyHtml = escapeHtml(body)
      .replace(/\n\n+/g, "</p><p>")
      .replace(/\n/g, "<br>");
    const tracker = trackingUrl
      ? `<img src="${escapeHtml(trackingUrl)}" width="1" height="1" style="display:none" alt="">`
      : "";

    return `
      <p>${bodyHtml}</p>

      <br>

      <div style="border-top:1px solid #dddddd;padding-top:12px;
                  font-family:Arial,sans-serif;font-size:12px;color:#666666">

        <div style="display:inline-block;background:${BRAND.blue};
                    padding:10px 14px;border-radius:6px;margin-bottom:8px">
          <img src="${BRAND.logoUrl}"
               alt="ZemenayTech"
               width="140"
               style="display:block;max-width:140px">
        </div>

        <div>
          <strong>${escapeHtml(BRAND.name)}</strong><br>
          ${escapeHtml(BRAND.website)}
        </div>
      </div>
      ${tracker}
    `;
}

// The panel lives in a shadow root, so document-level queries never see it.
function findComposeDialogs() {
  return [...document.querySelectorAll('div[role="dialog"]')].filter((d) =>
    pick(d, SEL.subject)
  );
}

function detectAccount() {
  const fromTitle = document.title.match(/[\w.+-]+@[\w.-]+\.\w+/);
  if (fromTitle) return fromTitle[0];
  const accountEl = document.querySelector(
    'a[aria-label*="@"], [aria-label*="Google Account"]'
  );
  if (accountEl) {
    const m = accountEl.getAttribute("aria-label").match(/[\w.+-]+@[\w.-]+\.\w+/);
    if (m) return m[0];
  }
  return null;
}

// Has Gmail actually turned the typed text into a recipient? Markup varies by
// Gmail version, so accept any of the forms a committed chip takes rather than
// betting on one. This runs before the subject and body are filled, so the
// address cannot appear anywhere else in the dialog yet.
function recipientRegistered(dialog, email) {
  const needle = email.toLowerCase();

  for (const el of dialog.querySelectorAll("[email], [data-hovercard-id]")) {
    const v = (
      el.getAttribute("email") ||
      el.getAttribute("data-hovercard-id") ||
      ""
    ).toLowerCase();
    if (v === needle) return true;
  }

  // A chip with no matching contact renders the bare address as leaf text.
  for (const el of dialog.querySelectorAll("span, div")) {
    if (!el.firstElementChild && el.textContent.trim().toLowerCase() === needle) {
      return true;
    }
  }

  const hidden = dialog.querySelector('textarea[name="to"], input[name="to"]');
  if (hidden && String(hidden.value || "").toLowerCase().includes(needle)) return true;

  return false;
}

// Newer Gmail compose collapses the To row behind a "Recipients" label. The
// input exists the whole time but stays hidden and inert until that row is
// clicked, so typing into it does nothing and Send reports no recipient even
// though the subject and body filled normally.
async function revealRecipientField(dialog) {
  const visibleTo = () => {
    const el = pick(dialog, SEL.to);
    return el && isVisible(el) ? el : null;
  };

  const already = visibleTo();
  if (already) return already;

  // The trigger is the collapsed label, never a form field: an aria-label like
  // "To recipients" is carried by the hidden input itself, and clicking that
  // does nothing while it is still collapsed.
  const candidates = [
    ...dialog.querySelectorAll('[aria-label="Recipients"], div.aoD.hl'),
    ...[...dialog.querySelectorAll("div, span")].filter(
      (el) => !el.firstElementChild && /^(recipients|to)$/i.test(el.textContent.trim())
    ),
  ];
  const trigger = candidates.find(
    (el) => !/^(input|textarea)$/i.test(el.tagName) && isVisible(el)
  );

  if (trigger) {
    trigger.click();
    const revealed = await waitFor(visibleTo, 3000);
    if (revealed) return revealed;
  }

  // Fall back to whatever we can find; setRecipient reports the state either way.
  return pick(dialog, SEL.to);
}

function describeToField(toEl, dialog) {
  const attrs = [...toEl.attributes]
    .map((a) => `${a.name}="${a.value}"`.slice(0, 60))
    .join(" ");
  const chips = [...dialog.querySelectorAll("[email], [data-hovercard-id]")].length;
  return (
    `field=<${toEl.tagName.toLowerCase()} ${attrs}> ` +
    `value="${String(toEl.value || "").slice(0, 60)}" ` +
    `visible=${isVisible(toEl)} chipNodes=${chips} ` +
    `focused=${document.activeElement === toEl} docFocus=${document.hasFocus()}`
  );
}

// The To field is a peoplekit widget holding its own state. Assigning .value
// updates the DOM node while the widget stays empty, so Send fires with no
// recipient. Several input paths exist and which one works varies by Gmail
// build, so try them in order of reliability and confirm a chip after each.
//
// Paste goes first because pasting addresses into To is a first-class user
// flow the widget is built to parse. Note execCommand silently does nothing
// when the document lacks focus, so it cannot be the only strategy for a run
// happening in a background tab.
async function setRecipient(dialog, email) {
  const toEl = await revealRecipientField(dialog);
  if (!toEl) throw new Error("Could not find the To field");

  const strategies = [
    async function paste() {
      toEl.focus();
      const dt = new DataTransfer();
      dt.setData("text/plain", `${email},`);
      toEl.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
      );
    },

    async function typeNatively() {
      toEl.focus();
      toEl.click();
      document.execCommand("insertText", false, email);
      await sleep(150);
      // Comma rather than Enter: Enter accepts whatever the autocomplete has
      // highlighted, which may not be the address we asked for.
      document.execCommand("insertText", false, ",");
    },

    async function setValueThenCommit() {
      toEl.focus();
      setNativeValue(toEl, email);
      toEl.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: email })
      );
      await sleep(150);
      for (const type of ["keydown", "keypress", "keyup"]) {
        toEl.dispatchEvent(
          new KeyboardEvent(type, {
            key: ",", code: "Comma", keyCode: 188, which: 188, bubbles: true,
          })
        );
      }
      await sleep(150);
      toEl.blur();
    },
  ];

  const tried = [];
  for (const strategy of strategies) {
    try {
      await strategy();
    } catch (err) {
      tried.push(`${strategy.name}:threw`);
      continue;
    }
    if (await waitFor(() => recipientRegistered(dialog, email), 2500)) return;
    tried.push(strategy.name);
  }

  throw new Error(
    `Recipient ${email} never registered. Tried ${tried.join(", ")}. ` +
      describeToField(toEl, dialog)
  );
}

async function composeAndSend({ to, subject, body, autoSend, trackingUrl }) {
  const before = findComposeDialogs();

  const composeBtn = await waitFor(() => pick(document, SEL.composeButton), 15000);
  if (!composeBtn) throw new Error("Compose button not found");
  composeBtn.click();

  const dialog = await waitFor(() => {
    const now = findComposeDialogs().filter((d) => !before.includes(d));
    return now[now.length - 1];
  }, 15000);
  if (!dialog) throw new Error("Compose window did not open");

  const subjEl = pick(dialog, SEL.subject);
  const bodyEl = pick(dialog, SEL.body);
  if (!subjEl) throw new Error("Could not find the Subject field");
  if (!bodyEl) throw new Error("Could not find the message body");

  await setRecipient(dialog, to);

  setNativeValue(subjEl, subject);
  await sleep(150);
  const emailHtml = createEmailHtml(body, trackingUrl);
  setBody(bodyEl, emailHtml);
  await sleep(300);

  if (!autoSend) {
    const handled = await waitFor(() => !document.contains(dialog), 300000, 500);
    return handled
      ? { status: "handled" }
      : { status: "error", message: "Draft left open for 5 minutes" };
  }

  const sendBtn = pick(dialog, SEL.send);
  if (!sendBtn) throw new Error("Send button not found");
  sendBtn.click();

  // Gmail tears the dialog out of the DOM only once the send is accepted.
  const closed = await waitFor(() => !document.contains(dialog), 30000, 250);
  if (!closed) throw new Error("Gmail did not confirm the send");

  return { status: "sent" };
}

// ------------------------------------------------------------- CSV + template

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { headers: [], rows: [] };

  const splitLine = (line) => {
    const cells = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') {
          inQuotes = false;
        } else {
          cur += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        cells.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  };

  const headers = splitLine(lines[0]).map((h) => h.toLowerCase());
  const rows = lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const row = {};
    headers.forEach((h, i) => (row[h] = cells[i] || ""));
    if (!row.name && (row.first_name || row.last_name)) {
      row.name = [row.first_name, row.last_name].filter(Boolean).join(" ");
    }
    return row;
  });
  return { headers, rows };
}

function fillTemplate(template, row) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const v = row[key.toLowerCase()];
    return v !== undefined ? v : match;
  });
}

// ------------------------------------------------------------------ segments

// Three offers, three audiences, three templates. A property manager and a
// CTO with four roles open need different first sentences, and sending one
// list through one template is what makes cold mail read like cold mail.
const SEGMENTS = [
  {
    id: "callcenter",
    label: "Call centre",
    // Businesses whose phone is the front door: someone has to answer it, and
    // the hours say nobody is there when it rings.
    match: /call.?cent|property|real.?estate|realtor|estate_agent|law|legal|attorney|notary|insurance|dental|dentist|medical|clinic|doctor|veterinar|hvac|plumb|roof|electric|contractor|trades|car_repair|motor|driving_school|funeral/i,
    subject: "who picks up when {{company}} is {{hours_gap}}?",
    body:
      "Hi — I saw {{company}} is {{hours_gap}}.\n\n" +
      "For most businesses like yours that's exactly when the calls that matter " +
      "arrive: an emergency, a lockout, someone ringing three places and going with " +
      "whoever answers first.\n\n" +
      "We run outsourced front desks for companies your size — trained agents " +
      "answering as your team, logging every call, escalating the real emergencies " +
      "and handling the rest. Roughly $6-10/hr, with no recruiting and no payroll on " +
      "your side.\n\n" +
      "Worth a 15-minute call to see if your volume justifies it?\n\n" +
      "Michael\nZemenay · Bole, Addis Ababa, Ethiopia",
  },
  {
    id: "callcenter-generic",
    label: "Call centre (no hours)",
    // Same offer, for the majority of rows where opening hours were never
    // published. Opens on a question rather than a fact we do not have.
    match: /^$/,
    subject: "who answers the phone at {{company}}?",
    body:
      "Hi — quick question about how {{company}} handles inbound calls.\n\n" +
      "For most teams your size the phone is the front door, and it rings hardest " +
      "exactly when everyone is busy with the customer in front of them. The calls " +
      "that go unanswered are rarely the unimportant ones.\n\n" +
      "We run outsourced front desks: trained agents answering as your team, logging " +
      "every call, escalating what's urgent and handling the rest. Roughly $6-10/hr, " +
      "with no recruiting and no payroll on your side.\n\n" +
      "Worth a 15-minute call to see whether your volume justifies it?\n\n" +
      "Michael\nZemenay · Bole, Addis Ababa, Ethiopia",
  },
  {
    id: "tech",
    label: "Tech & talent",
    // Agencies, consultancies and B2B service firms — the ones who bill their
    // people out and feel every unfilled seat directly.
    //
    // This template used to open on {{sample_role}} and {{eng_roles}}, which
    // exist only in the hiring-signal export. Against the main send list those
    // merged to nothing and the recipient got a literal {{sample_role}}. It now
    // uses only fields the list actually carries.
    match: /tech|software|saas|engineer|developer|it\b|telecommunication|research|agency|marketing|advertising|consulting|logistics|architect/i,
    subject: "senior developers for {{company}}, without the recruiter fee",
    body:
      "Hi — I'll be brief.\n\n" +
      "If {{company}} is carrying work you can't staff, or paying agency rates to " +
      "fill a seat, that's the gap we cover.\n\n" +
      "We place vetted senior developers — React, Node, Python, React Native, DevOps " +
      "— as contractors, usually within two weeks, and you keep the relationship " +
      "directly. No placement fee on contract hires, and we handle payroll and " +
      "compliance.\n\n" +
      "Want me to send two or three profiles so you can judge the standard? Costs you " +
      "nothing to look.\n\n" +
      "Michael\nZemenay · Bole, Addis Ababa, Ethiopia",
  },
  {
    id: "va",
    label: "Virtual assistants",
    // Admin-heavy operations where the owner is still doing the paperwork.
    //
    // Previously greeted {{name}}, which is empty on every row of the send list
    // — these are business addresses, not people — so it rendered as "Hi ,".
    match: /virtual|assistant|admin|account|bookkeep|tax|finance|hotel|guest_house|hospitality|travel|education|childcare|school|beauty|hairdresser|fitness|pharmacy|optician|retail|ecommerce|shop|salon/i,
    subject: "the admin nobody at {{company}} has time for",
    body:
      "Hi — quick one.\n\n" +
      "Most owners I speak to at businesses like {{company}} are still doing their own " +
      "inbox, scheduling and data entry at the end of the day, long after the actual " +
      "work is finished.\n\n" +
      "We place dedicated virtual assistants who take that off you — inbox and " +
      "calendar, bookings and reminders, research, data entry, supplier follow-up. " +
      "They work your hours and learn your systems. $6-10/hr, month to month.\n\n" +
      "Want me to send what a first month usually looks like?\n\n" +
      "Michael\nZemenay · Bole, Addis Ababa, Ethiopia",
  },
];

const DEFAULT_SEGMENT = "callcenter";

// An explicit `segment` column always wins — it lets the list decide rather
// than the guesser. Otherwise route on whatever descriptive columns exist.
function routeContact(row) {
  const explicit = String(row.segment || "").trim().toLowerCase();
  if (explicit) {
    const hit = SEGMENTS.find((s) => s.id === explicit || s.label.toLowerCase() === explicit);
    if (hit) return hit.id;
  }
  const haystack = [row.vertical, row.category, row.osm_type, row.detail, row.title, row.segment]
    .filter(Boolean).join(" ");
  // Engineering roles are the strongest signal available, so let them outrank
  // the vertical: a software company with open roles is a tech lead, not a VA one.
  if (Number(row.eng_roles) > 0) return "tech";
  if (Number(row.support_roles) > 0) return "va";
  return (SEGMENTS.find((s) => s.match.test(haystack)) || {}).id || DEFAULT_SEGMENT;
}

// ----------------------------------------------------------------- pre-flight

// The failure this catches: a template referencing {{hours_gap}} against a row
// that hasn't got one, producing "I saw Acme Ltd is ." That single blank is
// worse than not sending at all, and there is no way to unsend it.
function preflight(list, templates) {
  const issues = { blank: [], unfilled: [], noEmail: [], dupe: [], suppressed: [] };
  const seen = new Set();

  for (const c of list) {
    const seg = c._segment || routeContact(c);
    const tpl = templates[seg] || { subject: "", body: "" };
    const email = String(c.email || "").trim().toLowerCase();

    if (!email || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) { issues.noEmail.push(c); continue; }
    if (seen.has(email)) { issues.dupe.push(c); continue; }
    seen.add(email);
    if (suppressed.has(email)) { issues.suppressed.push(c); continue; }

    const merged = `${fillTemplate(tpl.subject, c)}\n${fillTemplate(tpl.body, c)}`;
    // A placeholder that survived the merge means the column is missing entirely.
    const leftover = merged.match(/\{\{(\w+)\}\}/g);
    if (leftover) { issues.unfilled.push({ contact: c, fields: [...new Set(leftover)] }); continue; }

    // A field that exists but is empty is the quieter, more dangerous version:
    // the placeholder disappears and leaves a hole in the sentence.
    const used = [...`${tpl.subject}\n${tpl.body}`.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1].toLowerCase());
    const empty = used.filter((f) => !String(c[f] ?? "").trim());
    if (empty.length) issues.blank.push({ contact: c, fields: [...new Set(empty)] });
  }
  return issues;
}

// The domains outreach goes out from. Everything imported is scoped to these,
// so the account's personal mail never enters the history.
const BUSINESS_DOMAINS = ["zemenaytech.com", "africanrecruitment.com"];

const isBusinessContact = (rec) =>
  BUSINESS_DOMAINS.some((d) =>
    String(rec.account || "").includes(d) ||
    (rec.touches || []).some((t) => String(t.from || "").includes(d))
  );

// ------------------------------------------------------------------- history

// One record per contact ever emailed. This is the substrate for follow-ups,
// reply detection and the dashboard — everything downstream reads from here,
// so it is written on every send rather than reconstructed later.
//
// Keyed by lowercased email. Kept in chrome.storage.local, which holds ~10MB
// under the unlimitedStorage permission; 4,000 contacts is well under 2MB.
let history = {};

function loadHistory() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["history"], (d) => {
      history = d.history && typeof d.history === "object" ? d.history : {};
      resolve(history);
    });
  });
}

function saveHistory() {
  return new Promise((r) => chrome.storage.local.set({ history }, r));
}

function recordSend(contact, segment, subject, { followUp = false, trackingId = null } = {}) {
  const key = String(contact.email || "").trim().toLowerCase();
  if (!key) return;
  const now = Date.now();
  const existing = history[key];
  // Which mailbox this went out from. Reply and bounce rates are properties of
  // the sending domain as much as the copy, so a record without it cannot
  // answer the question that matters when one domain starts getting blocked.
  const from = detectAccount() || "";

  if (existing) {
    existing.touches.push({ at: now, segment, subject, followUp, from, trackingId });
    existing.lastSentAt = now;
    if (from && !existing.account) existing.account = from;
    if (followUp) existing.followUps = (existing.followUps || 0) + 1;
  } else {
    history[key] = {
      email: key,
      company: contact.company || "",
      name: contact.name || "",
      segment,
      account: from,
      vertical: contact.vertical || contact.category || "",
      country: contact.country || "",
      city: contact.city || "",
      firstSentAt: now,
      lastSentAt: now,
      followUps: 0,
      touches: [{ at: now, segment, subject, followUp: false, from, trackingId }],
      repliedAt: null,
      bouncedAt: null,
      bounceReason: "",
    };
  }
}

const DAY = 86400000;

// Contacts worth chasing: sent, no reply, no bounce, past the wait, and under
// the follow-up ceiling. Three touches is where persistence turns into pestering.
function followUpDue(afterDays = 3, maxTouches = 3) {
  const now = Date.now();
  return Object.values(history).filter((h) =>
    !h.repliedAt &&
    !h.bouncedAt &&
    (h.touches?.length || 1) < maxTouches &&
    now - h.lastSentAt >= afterDays * DAY
  );
}

function historyStats() {
  const rows = Object.values(history);
  const sent = rows.length;
  const replied = rows.filter((h) => h.repliedAt).length;
  const bounced = rows.filter((h) => h.bouncedAt).length;
  const touches = rows.reduce((n, h) => n + (h.touches?.length || 1), 0);
  return {
    contacts: sent,
    emails: touches,
    replied,
    bounced,
    replyRate: sent ? (replied / sent) * 100 : 0,
    bounceRate: sent ? (bounced / sent) * 100 : 0,
  };
}

// ------------------------------------------------------- reply/bounce scanning

// Replies and bounces are read out of the inbox itself, by driving Gmail's own
// search. There is no API call and no OAuth here — the same reason the sender
// works the way it does.
//
// Search runs in the same tab, so it necessarily moves the user's view. The
// scan therefore records where it started and puts it back afterwards, and it
// refuses to run mid-campaign rather than yanking the page out from under a
// send in progress.

function gmailSearch(query) {
  const base = location.hash.startsWith("#search") ? "#inbox" : location.hash || "#inbox";
  location.hash = `#search/${encodeURIComponent(query)}`;
  return base;
}

// Wait for the thread list to settle. Gmail re-renders rows in place, so the
// signal is "rows stopped changing", not "rows exist".
async function waitForResults(timeoutMs = 12000) {
  const started = Date.now();
  let lastCount = -1;
  let stableFor = 0;
  while (Date.now() - started < timeoutMs) {
    const rows = document.querySelectorAll(SEL.threadRow.join(","));
    if (rows.length === lastCount) {
      stableFor += 300;
      if (stableFor >= 900) return rows;
    } else {
      lastCount = rows.length;
      stableFor = 0;
    }
    await sleep(300);
  }
  return document.querySelectorAll(SEL.threadRow.join(","));
}

function readRows() {
  const out = [];
  for (const row of document.querySelectorAll(SEL.threadRow.join(","))) {
    const senderEl = pick(row, SEL.rowSender);
    const email = (senderEl?.getAttribute?.("email") || "").trim().toLowerCase();
    // Gmail renders a preview of the message body in the list itself, so the
    // gist of a reply can be read without opening anything. Opening each thread
    // would give the full text at the cost of a page load per reply and a lot
    // of visible thrashing in the user's own mailbox.
    const subject = (pick(row, SEL.rowSubject)?.textContent || "").trim();
    const snippet = (pick(row, SEL.rowSnippet)?.textContent || "")
      .replace(/^\s*-\s*/, "").trim();
    const date = (row.querySelector("span[title]")?.getAttribute("title") || "").trim();
    out.push({ email, text: row.textContent || "", subject, snippet, date });
  }
  return out;
}

// What a cold-outreach reply actually is. Most are not answers — they are
// auto-responders and unsubscribes, and counting those as interest would
// inflate the one number the dashboard exists to report.
function classifyReply(subject, snippet) {
  const t = `${subject} ${snippet}`.toLowerCase();
  if (/out of (the )?office|annual leave|on holiday|abwesenheit|urlaub|maternity|paternity|away from my desk|automatic reply|autoreply|auto-reply/.test(t)) {
    return "auto-reply";
  }
  if (/unsubscribe|remove me|opt.?out|do not (contact|email)|stop emailing|take me off/.test(t)) {
    return "unsubscribe";
  }
  if (/no thank|not interested|no interest|we are all set|already have|not looking|kein interesse|nicht interessiert/.test(t)) {
    return "not interested";
  }
  if (/\?|how much|pricing|price|cost|rates?|call|meeting|available|tell me more|interested|send me|more info|when can/.test(t)) {
    return "interested";
  }
  return "other";
}

// Gmail's search box accepts from:(a@x OR b@y). Batch size is a compromise:
// too many and the URL gets unwieldy and the query slow, too few and a
// 4,000-contact scan takes all afternoon.
const SCAN_BATCH = 25;

async function scanForReplies({ days = 60, onProgress } = {}) {
  const addresses = Object.keys(history).filter((e) => !history[e].repliedAt && !history[e].bouncedAt);
  if (!addresses.length) return { scanned: 0, found: 0 };

  const returnTo = location.hash || "#inbox";
  let found = 0;

  for (let i = 0; i < addresses.length; i += SCAN_BATCH) {
    const batch = addresses.slice(i, i + SCAN_BATCH);
    gmailSearch(`from:(${batch.join(" OR ")}) newer_than:${days}d`);
    await sleep(700);
    await waitForResults();

    for (const row of readRows()) {
      // Only trust the address attribute. A display name that happens to match
      // is not evidence, and marking a live prospect as replied would silently
      // drop them out of every future follow-up.
      if (row.email && history[row.email] && !history[row.email].repliedAt) {
        const h = history[row.email];
        h.repliedAt = Date.parse(row.date) || Date.now();
        h.replySubject = row.subject;
        h.replySnippet = row.snippet;
        h.replyKind = classifyReply(row.subject, row.snippet);
        found++;
      }
    }
    onProgress?.(Math.min(i + SCAN_BATCH, addresses.length), addresses.length, found);
    await saveHistory();
  }

  location.hash = returnTo;
  return { scanned: addresses.length, found };
}

// Reads the Sent folder and reconstructs history from mail that went out before
// this extension was tracking anything. Without it the dashboard starts empty
// and stays empty until a fresh campaign has run for a week — with it, whatever
// outreach has already happened from this account becomes measurable today.
//
// Deliberately conservative: it records what it can read (recipient, date,
// subject) and guesses nothing. Segment is left blank rather than inferred from
// a subject line, because a wrong segment would corrupt the one number the
// dashboard exists to report.
// `alias` narrows the import to mail sent *as* a particular address. Gmail's
// "Send mail as" lets one account send from addresses hosted elsewhere — a
// cPanel mailbox, say — and those messages are stored in Gmail's Sent folder,
// never on the other server. Without this, outreach sent that way is invisible
// to both importers: absent from the cPanel mailbox because it was never there,
// and mis-attributed to the Gmail address by a plain in:sent scan.
async function importSentMail({ days = 180, maxPages = 40, alias = "", onProgress } = {}) {
  const returnTo = location.hash || "#inbox";
  // A domain pass arrives as "@zemenaytech.com"; store it without the @ so the
  // dashboard's per-sender column reads as a domain rather than a fragment.
  const from = alias ? alias.replace(/^@/, "") : detectAccount() || "";
  let imported = 0, updated = 0, pages = 0;

  gmailSearch(alias
    ? `in:sent from:${alias} newer_than:${days}d`
    : `in:sent newer_than:${days}d`);
  await sleep(900);

  while (pages < maxPages) {
    await waitForResults();
    const rows = document.querySelectorAll(SEL.threadRow.join(","));
    if (!rows.length) break;

    for (const row of rows) {
      // In the Sent view the span[email] is the recipient, not the sender.
      const who = row.querySelector("span[email]");
      const addr = (who?.getAttribute("email") || "").trim().toLowerCase();
      if (!addr || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(addr)) continue;

      const subjectEl = pick(row, SEL.rowSubject);
      const subject = (subjectEl?.textContent || "").trim().slice(0, 200);
      // Gmail puts a full timestamp in the date cell's title attribute; the
      // visible text is abbreviated and ambiguous across years.
      const dateEl = row.querySelector("span[title]:not([email])") || row.querySelector("td.xW span");
      const parsed = Date.parse(dateEl?.getAttribute?.("title") || dateEl?.textContent || "");
      const at = Number.isFinite(parsed) ? parsed : Date.now();

      const existing = history[addr];
      if (!existing) {
        history[addr] = {
          email: addr,
          company: (who?.getAttribute("name") || "").trim(),
          name: "",
          segment: "",           // unknown, and not worth guessing
          account: from,
          vertical: "", country: "", city: "",
          firstSentAt: at, lastSentAt: at, followUps: 0,
          touches: [{ at, segment: "", subject, followUp: false, imported: true, from }],
          repliedAt: null, bouncedAt: null, bounceReason: "",
          imported: true,
        };
        imported++;
      } else {
        const same = existing.touches.find((t) => Math.abs(t.at - at) < 60000);
        if (same) {
          // The unfiltered in:sent pass records every message but can only
          // attribute it to the Gmail account. An alias pass reaching the same
          // message knows which address actually sent it, so it corrects the
          // attribution instead of skipping the row — otherwise the per-sending
          // address breakdown reports every alias as the Gmail account.
          if (alias && same.from !== alias) {
            same.from = alias;
            existing.account = alias;
            updated++;
          }
        } else {
          existing.touches.push({ at, segment: existing.segment || "", subject, followUp: true, imported: true, from });
          existing.firstSentAt = Math.min(existing.firstSentAt, at);
          existing.lastSentAt = Math.max(existing.lastSentAt, at);
          updated++;
        }
      }
    }

    pages++;
    onProgress?.(pages, imported, updated);
    await saveHistory();

    // Advance to the next page of results. When the button is gone or disabled,
    // the list is exhausted.
    const next = document.querySelector('div[role="button"][aria-label*="Older"], div[aria-label="Older"]');
    if (!next || next.getAttribute("aria-disabled") === "true") break;
    next.click();
    await sleep(1400);
  }

  location.hash = returnTo;
  return { imported, updated, pages };
}

// Bounces and rejections arrive as mail from the postmaster, with the failed
// recipient named in the body. This is the closest thing to a real spam signal
// available without a mail server of your own — a spike here means the domain
// is in trouble and sending should stop.
async function scanForBounces({ days = 60, onProgress } = {}) {
  const returnTo = location.hash || "#inbox";
  gmailSearch(`from:(mailer-daemon OR postmaster) newer_than:${days}d`);
  await sleep(700);
  await waitForResults();

  const rows = readRows();
  let found = 0;
  const known = Object.keys(history);

  for (const row of rows) {
    const haystack = row.text.toLowerCase();
    // The snippet usually names the address that failed; match it against
    // contacts we actually emailed rather than trusting a loose regex.
    for (const addr of known) {
      if (!haystack.includes(addr) || history[addr].bouncedAt) continue;
      history[addr].bouncedAt = Date.now();
      history[addr].bounceReason =
        /spam|blocked|policy|reputation|blacklist/.test(haystack) ? "blocked as spam"
        : /not exist|no such user|unknown|invalid|couldn't be found/.test(haystack) ? "address does not exist"
        : /full|quota|over quota/.test(haystack) ? "mailbox full"
        : "delivery failed";
      found++;
    }
  }
  onProgress?.(rows.length, rows.length, found);
  await saveHistory();
  location.hash = returnTo;
  return { scanned: rows.length, found };
}

// --------------------------------------------------------------- suppression

// Everyone already emailed, plus anyone who asked not to be. Persisted, so it
// survives reloads and applies across every future run and every CSV.
let suppressed = new Set();

function loadSuppression() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["suppressed"], (d) => {
      suppressed = new Set(Array.isArray(d.suppressed) ? d.suppressed : []);
      resolve(suppressed);
    });
  });
}

function addSuppression(emails) {
  for (const e of emails) {
    const v = String(e || "").trim().toLowerCase();
    if (v) suppressed.add(v);
  }
  return new Promise((r) => chrome.storage.local.set({ suppressed: [...suppressed] }, r));
}

// -------------------------------------------------------------------- Panel

const PANEL_ID = "gmail-list-mailer-panel";

const PANEL_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }

  /* Layered glass: a tinted base, two coloured light sources bleeding through
     from behind, and a specular rim. The blur is what sells it, so the tint
     stays translucent enough for Gmail to show through. */
  .wrap {
    position: fixed; top: 64px; right: 28px; width: 520px; z-index: 2147483647;
    color: #f4f6fb; font-size: 13px;
    background:
      radial-gradient(120% 90% at 8% -10%, rgba(120,160,255,.30), transparent 60%),
      radial-gradient(110% 80% at 100% 0%, rgba(226,120,220,.22), transparent 58%),
      radial-gradient(100% 70% at 50% 115%, rgba(80,235,200,.16), transparent 60%),
      linear-gradient(165deg, rgba(26,28,52,.88), rgba(14,10,30,.93));
    backdrop-filter: blur(40px) saturate(200%);
    -webkit-backdrop-filter: blur(40px) saturate(200%);
    border: 1px solid rgba(255,255,255,.22);
    border-radius: 26px;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.45),
      inset 0 -1px 0 rgba(255,255,255,.08),
      inset 0 0 60px rgba(255,255,255,.05),
      0 24px 70px rgba(0,0,0,.5),
      0 2px 10px rgba(0,0,0,.3);
    overflow: hidden;
    min-width: 400px; max-width: 92vw;
  }
  .wrap.collapsed { width: 300px; }
  .wrap.collapsed .body { display: none; }

  /* Glancing highlight along the top edge. */
  .wrap::before {
    content: ""; position: absolute; inset: 0 0 auto 0; height: 140px;
    background: linear-gradient(180deg, rgba(255,255,255,.14), transparent);
    pointer-events: none;
  }

  .head {
    position: relative; display: flex; align-items: center; gap: 10px;
    padding: 14px 16px; cursor: grab; user-select: none;
    border-bottom: 1px solid rgba(255,255,255,.14);
    background: linear-gradient(180deg, rgba(255,255,255,.10), rgba(255,255,255,.02));
  }
  .head:active { cursor: grabbing; }
  .head h1 { font-size: 14px; font-weight: 700; margin: 0; flex: 1; letter-spacing: -.01em; }
  .dot {
    width: 9px; height: 9px; border-radius: 50%; flex: none;
    background: rgba(255,255,255,.28); box-shadow: inset 0 1px 1px rgba(0,0,0,.4);
  }
  .dot.on { background: #7bf0c2; box-shadow: 0 0 12px #7bf0c2, inset 0 1px 1px rgba(0,0,0,.2); }
  .icon-btn {
    flex: none; width: 28px; height: 28px; border-radius: 10px; cursor: pointer;
    color: #fff; font-size: 14px; line-height: 1;
    border: 1px solid rgba(255,255,255,.24);
    background: linear-gradient(180deg, rgba(255,255,255,.16), rgba(255,255,255,.06));
    box-shadow: inset 0 1px 0 rgba(255,255,255,.3);
  }
  .icon-btn:hover { background: rgba(255,255,255,.24); }

  .body {
    position: relative; padding: 18px; overflow-y: auto;
    max-height: calc(100vh - 190px);
  }
  .body::-webkit-scrollbar { width: 10px; }
  .body::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,.16); border-radius: 10px;
    border: 3px solid transparent; background-clip: content-box;
  }

  label.lbl {
    display: block; font-size: 10px; font-weight: 600; letter-spacing: .14em;
    text-transform: uppercase; color: rgba(255,255,255,.66); margin: 16px 0 6px;
  }
  label.lbl:first-child { margin-top: 0; }

  input[type=text], input[type=number], textarea {
    width: 100%; padding: 11px 13px; font-size: 13.5px; color: #f4f6fb;
    border: 1px solid rgba(255,255,255,.16); border-radius: 14px;
    background: linear-gradient(180deg, rgba(0,0,0,.30), rgba(0,0,0,.20));
    box-shadow: inset 0 1px 2px rgba(0,0,0,.35), inset 0 -1px 0 rgba(255,255,255,.06);
    outline: none; resize: vertical;
  }
  textarea { min-height: 280px; line-height: 1.62; font-size: 14px; }
  input:focus, textarea:focus {
    border-color: rgba(130,175,255,.75);
    box-shadow: inset 0 1px 2px rgba(0,0,0,.35), 0 0 0 3px rgba(120,160,255,.18);
  }
  input::placeholder, textarea::placeholder { color: rgba(255,255,255,.3); }
  input[type=number] { width: 92px; }

  .drop {
    display: flex; align-items: center; justify-content: center; padding: 15px;
    border-radius: 16px; border: 1px dashed rgba(255,255,255,.3);
    background: linear-gradient(180deg, rgba(255,255,255,.09), rgba(255,255,255,.03));
    font-size: 12.5px; cursor: pointer; color: rgba(255,255,255,.78); text-align: center;
  }
  .drop:hover { background: rgba(255,255,255,.14); border-color: rgba(255,255,255,.45); }
  .drop input { display: none; }

  .hint { font-size: 11.5px; line-height: 1.55; color: rgba(255,255,255,.6); margin: 7px 0 0; }
  .hint code {
    background: rgba(255,255,255,.14); padding: 1px 5px; border-radius: 5px;
    font-size: 11px;
  }
  .summary { color: rgba(150,220,255,.95); font-weight: 500; }

  .rangebar { display: flex; align-items: center; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
  .rangebar input[type=number] { width: 78px; }
  .rlbl {
    font-size: 10px; font-weight: 600; letter-spacing: .12em;
    text-transform: uppercase; color: rgba(255,255,255,.6);
  }

  .list {
    margin-top: 10px; max-height: 190px; overflow-y: auto; border-radius: 14px;
    background: rgba(0,0,0,.24); border: 1px solid rgba(255,255,255,.1);
    box-shadow: inset 0 1px 2px rgba(0,0,0,.3);
  }
  .list .c {
    display: flex; align-items: baseline; gap: 9px; padding: 7px 11px;
    border-bottom: 1px solid rgba(255,255,255,.07); font-size: 12px;
  }
  .list .c:last-child { border-bottom: none; }
  .list .c.out { opacity: .32; }
  .list .n {
    flex: none; min-width: 26px; font-variant-numeric: tabular-nums;
    color: rgba(255,255,255,.45); font-size: 11px;
  }
  .list .who { flex: none; font-weight: 600; color: rgba(255,255,255,.9); }
  .list .addr {
    flex: 1; color: rgba(150,220,255,.85); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .list .c.done .addr { color: rgba(123,240,194,.92); }
  .list .c.failed .addr { color: #ff8a8a; }
  .list .c.sending { background: rgba(120,160,255,.16); }

  .row { display: flex; align-items: center; gap: 9px; font-size: 12.5px; margin-top: 14px; cursor: pointer; }
  .row input { accent-color: #5b8dff; width: 15px; height: 15px; }

  .actions { display: flex; gap: 12px; margin-top: 18px; }
  .btn {
    flex: 1; padding: 13px; font-size: 13.5px; font-weight: 600; color: #fff;
    border: 1px solid rgba(255,255,255,.32); border-radius: 18px; cursor: pointer;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.4), 0 6px 18px rgba(0,0,0,.28);
  }
  .btn:active { transform: scale(.98); }
  .btn.go { background: linear-gradient(135deg, rgba(96,146,255,.92), rgba(150,104,255,.82)); }
  .btn.stop { background: linear-gradient(135deg, rgba(255,96,96,.92), rgba(255,64,124,.82)); }
  .btn[disabled] { opacity: .5; cursor: not-allowed; }
  .hidden { display: none !important; }

  /* Segment tabs. The active one lights up in the same violet as the primary
     button, so it reads as "this is the template you are editing". */
  .segs { display: flex; gap: 6px; margin-top: 8px; }
  .seg {
    flex: 1; padding: 9px 6px; font-size: 12px; font-weight: 600; color: rgba(255,255,255,.72);
    background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.18);
    border-radius: 14px; cursor: pointer; text-align: center; line-height: 1.3;
  }
  .seg:hover { background: rgba(255,255,255,.14); }
  .seg.on {
    color: #fff; border-color: rgba(255,255,255,.42);
    background: linear-gradient(135deg, rgba(96,146,255,.92), rgba(150,104,255,.82));
    box-shadow: inset 0 1px 0 rgba(255,255,255,.4);
  }
  .seg .cnt { display: block; font-size: 10.5px; font-weight: 500; opacity: .8; }

  /* Per-contact segment badge in the list. */
  .list .seg-tag {
    margin-left: auto; font-size: 10px; font-weight: 600; padding: 2px 7px;
    border-radius: 8px; background: rgba(255,255,255,.12); color: rgba(255,255,255,.75);
    white-space: nowrap;
  }
  .list .c.suppressed { opacity: .4; }
  .list .c.suppressed .addr { text-decoration: line-through; }

  .checks {
    margin-top: 12px; padding: 12px 14px; border-radius: 16px;
    background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.16);
    font-size: 12px; line-height: 1.6;
  }
  .checks .ok { color: rgba(123,240,194,.95); font-weight: 600; }
  .checks .warn { color: #ffcf7a; }
  .checks .bad { color: #ff8a8a; }
  .checks ul { margin: 6px 0 0; padding-left: 18px; }
  .checks li { margin: 3px 0; color: rgba(255,255,255,.78); }

  .pvbar {
    display: flex; align-items: center; gap: 10px; margin-top: 8px;
  }
  .pvbar .summary { flex: 1; text-align: center; font-size: 11.5px; }
  .pvbar .icon-btn { flex: none; }

  /* An empty merge field is invisible in a rendered email — the sentence just
     reads oddly. Marking it makes the hole findable before it is sent. */
  .preview .gap {
    background: rgba(255,120,120,.22); border-bottom: 1px solid rgba(255,120,120,.6);
    padding: 0 3px; border-radius: 3px;
  }
  .preview .missing {
    background: rgba(255,200,90,.22); border-bottom: 1px solid rgba(255,200,90,.7);
    padding: 0 3px; border-radius: 3px; font-family: monospace; font-size: 11px;
  }

  .preview {
    margin-top: 10px; padding: 12px 14px; border-radius: 14px;
    background: rgba(0,0,0,.28); border: 1px solid rgba(255,255,255,.12);
    font-size: 12px; white-space: pre-wrap; max-height: 240px; overflow: auto;
    color: rgba(255,255,255,.85);
  }
  .preview .subj { font-weight: 700; color: #fff; display: block; margin-bottom: 8px; }
  .btn.ghost {
    background: rgba(255,255,255,.1); flex: 0 0 auto; padding: 13px 18px;
  }

  /* Headline numbers. Deliberately plain — a reply rate is a number you check,
     not a thing to decorate. */
  .stats { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .stat {
    flex: 1 1 88px; padding: 10px 12px; border-radius: 14px;
    background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.15);
  }
  .stat b { display: block; font-size: 18px; font-weight: 700; color: #fff; line-height: 1.2; }
  .stat span { font-size: 10.5px; color: rgba(255,255,255,.62); }
  .stat.good b { color: rgba(123,240,194,.95); }
  .stat.bad b { color: #ff8a8a; }

  .status { font-size: 12.5px; font-weight: 600; margin: 18px 0 9px; }
  .log {
    font-size: 11.5px; max-height: 160px; overflow-y: auto; border-radius: 14px;
    padding: 10px; background: rgba(0,0,0,.24);
    border: 1px solid rgba(255,255,255,.1);
    box-shadow: inset 0 1px 2px rgba(0,0,0,.3);
  }
  .log div { padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,.07); color: rgba(255,255,255,.72); }
  .log div:last-child { border-bottom: none; }
  .log .ok { color: #7bf0c2; }
  .log .err { color: #ff8a8a; }

  .resume {
    margin-top: 14px; padding: 12px; border-radius: 14px; font-size: 12.5px;
    background: rgba(214,169,76,.15); border: 1px solid rgba(214,169,76,.42);
  }
  .resume button { margin-top: 10px; margin-right: 8px; }

  /* Resize grip, bottom-left because the panel sits on the right. */
  .grip {
    position: absolute; left: 0; bottom: 0; width: 20px; height: 20px;
    cursor: nesw-resize;
    background: linear-gradient(45deg, rgba(255,255,255,.28) 0 2px, transparent 2px 5px,
                rgba(255,255,255,.28) 5px 7px, transparent 7px 10px,
                rgba(255,255,255,.28) 10px 12px, transparent 12px);
  }
  .wrap.collapsed .grip { display: none; }
`;

const PANEL_HTML = `
  <div class="wrap" part="wrap">
    <div class="head">
      <span class="dot" id="dot"></span>
      <h1>List Mailer</h1>
      <button class="icon-btn" id="min" title="Collapse">–</button>
      <button class="icon-btn" id="close" title="Hide">×</button>
    </div>
    <div class="body">
      <label class="lbl">Sending from</label>
      <div id="account" style="font-weight:600">Checking…</div>

      <label class="lbl">Contact list</label>
      <label class="drop"><input type="file" id="csv" accept=".csv"><span id="csvName">Choose CSV file</span></label>
      <p class="hint">Needs an <code>email</code> column. <code>first_name</code> + <code>last_name</code> become <code>{{name}}</code>.</p>
      <p class="hint summary" id="csvInfo"></p>
      <label class="row hidden" id="unvRow"><input type="checkbox" id="unv"> Include unverified / invalid emails</label>

      <div class="rangebar hidden" id="rangeRow">
        <span class="rlbl">Rows</span>
        <input type="number" id="rangeFrom" min="1" value="1">
        <span class="rlbl">to</span>
        <input type="number" id="rangeTo" min="1">
        <span class="summary" id="rangeCount"></span>
      </div>
      <div class="list hidden" id="list"></div>

      <label class="lbl">Template</label>
      <div class="segs" id="segs"></div>
      <p class="hint">Each contact is routed to one of these automatically from its
        <code>vertical</code>, <code>category</code> or <code>segment</code> column. Editing here
        changes only the selected template.</p>

      <label class="lbl">Subject</label>
      <input type="text" id="subject" placeholder="Quick question, {{name}}">

      <label class="lbl">Message</label>
      <textarea id="body" placeholder="Hi {{name}},&#10;&#10;..."></textarea>

      <label class="lbl">Delay between sends (sec)</label>
      <input type="number" id="delay" min="2" value="5">

      <label class="row"><input type="checkbox" id="auto"> Auto-click Send</label>
      <label class="row"><input type="checkbox" id="keep" checked> Keep full speed in a background tab</label>
      <label class="row"><input type="checkbox" id="skipSup" checked> Skip anyone already emailed or opted out</label>

      <label class="lbl">What they'll receive</label>
      <div class="pvbar">
        <button class="icon-btn" id="pvPrev" title="Previous contact">‹</button>
        <span class="summary" id="pvWho">load a CSV to preview</span>
        <button class="icon-btn" id="pvNext" title="Next contact">›</button>
      </div>
      <div class="preview" id="preview"></div>

      <div class="checks hidden" id="checks"></div>

      <div class="resume hidden" id="resume"></div>

      <div class="actions">
        <button class="btn ghost" id="check">Check</button>
        <button class="btn go" id="start">Start</button>
        <button class="btn stop hidden" id="stop">Stop</button>
      </div>

      <label class="lbl">Results</label>
      <div class="stats" id="stats"></div>
      <div class="actions">
        <button class="btn go" id="dashboard">Dashboard</button>
        <button class="btn ghost" id="importSent">Import sent</button>
        <button class="btn ghost" id="scan">Scan inbox</button>
      </div>
      <div class="actions">
        <button class="btn ghost" id="followups">Follow-ups</button>
        <button class="btn ghost" id="purge">Clear personal</button>
        <button class="btn ghost" id="export">Export</button>
      </div>
      <p class="hint">The dashboard opens in a tab and reads this data directly — nothing to
        export. Scanning drives Gmail's own search to find replies and bounces, so the view moves
        while it runs. Export is only for publishing a copy elsewhere.</p>
      <div class="checks hidden" id="scanOut"></div>

      <div class="status" id="status">Ready</div>
      <div class="log" id="log"></div>
    </div>
    <div class="grip" id="grip" title="Drag to resize"></div>
  </div>
`;

let ui = null;
let allRows = [];
let contacts = [];
let running = false;
let stopRequested = false;

// One subject/body pair per segment, seeded from the defaults above and
// overwritten by whatever the user has edited and saved.
let templates = Object.fromEntries(
  SEGMENTS.map((s) => [s.id, { subject: s.subject, body: s.body }])
);
let activeSegment = DEFAULT_SEGMENT;

// Set when the queue was built from the follow-up list rather than a CSV.
// Cleared on the next CSV load so a normal run is never treated as a chase.
let followUpMode = false;

function buildPanel() {
  if (document.getElementById(PANEL_ID)) return ui;

  const host = document.createElement("div");
  host.id = PANEL_ID;
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = PANEL_CSS;
  root.appendChild(style);
  const holder = document.createElement("div");
  holder.innerHTML = PANEL_HTML;
  root.appendChild(holder);
  document.body.appendChild(host);

  const $ = (id) => root.getElementById(id);
  ui = {
    host, root,
    wrap: root.querySelector(".wrap"),
    head: root.querySelector(".head"),
    panelBody: root.querySelector(".body"),
    dot: $("dot"), account: $("account"),
    csv: $("csv"), csvName: $("csvName"), csvInfo: $("csvInfo"),
    unvRow: $("unvRow"), unv: $("unv"),
    rangeRow: $("rangeRow"), rangeFrom: $("rangeFrom"), rangeTo: $("rangeTo"),
    rangeCount: $("rangeCount"), list: $("list"),
    segs: $("segs"),
    subject: $("subject"), body: $("body"), delay: $("delay"), auto: $("auto"),
    keep: $("keep"), skipSup: $("skipSup"),
    checks: $("checks"), preview: $("preview"),
    pvPrev: $("pvPrev"), pvNext: $("pvNext"), pvWho: $("pvWho"),
    stats: $("stats"), scan: $("scan"), followups: $("followups"),
    importSent: $("importSent"), export: $("export"), scanOut: $("scanOut"),
    purge: $("purge"),
    dashboard: $("dashboard"),
    resume: $("resume"),
    check: $("check"), start: $("start"), stop: $("stop"),
    status: $("status"), log: $("log"),
    min: $("min"), close: $("close"), grip: $("grip"),
  };

  wirePanel();
  return ui;
}

function wirePanel() {
  ui.account.textContent = detectAccount() || "Gmail account not detected";

  // Collapsing drops to a narrow bar. A manually resized panel carries an
  // inline width that would outrank the stylesheet, so stash it and put it back.
  let widthBeforeCollapse = "";
  ui.min.addEventListener("click", () => {
    const collapsing = !ui.wrap.classList.contains("collapsed");
    if (collapsing) {
      widthBeforeCollapse = ui.wrap.style.width;
      ui.wrap.style.width = "";
    } else {
      ui.wrap.style.width = widthBeforeCollapse;
    }
    ui.wrap.classList.toggle("collapsed");
  });
  // Dismissing sticks: Gmail reloads often, and a panel that keeps coming back
  // is worse than one you have to click the toolbar icon to reopen.
  ui.close.addEventListener("click", () => {
    ui.host.style.display = "none";
    chrome.storage.local.set({ panelHidden: true });
  });

  // Drag by the header.
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  ui.head.addEventListener("mousedown", (e) => {
    if (e.target.classList.contains("icon-btn")) return;
    const r = ui.wrap.getBoundingClientRect();
    dragging = true;
    sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    e.preventDefault();
  });
  // Resize from the bottom-left grip. The panel is right-anchored, so widening
  // means moving the left edge out while the right edge stays put.
  let sizing = false, rx = 0, ry = 0, rw = 0, rh = 0;
  ui.grip.addEventListener("mousedown", (e) => {
    const r = ui.wrap.getBoundingClientRect();
    sizing = true;
    rx = e.clientX; ry = e.clientY; rw = r.width; rh = r.height;
    e.preventDefault();
    e.stopPropagation();
  });

  window.addEventListener("mousemove", (e) => {
    if (dragging) {
      ui.wrap.style.left = `${ox + e.clientX - sx}px`;
      ui.wrap.style.top = `${oy + e.clientY - sy}px`;
      ui.wrap.style.right = "auto";
    } else if (sizing) {
      ui.wrap.style.width = `${Math.max(400, rw - (e.clientX - rx))}px`;
      ui.panelBody.style.maxHeight = `${Math.max(220, rh + (e.clientY - ry) - 60)}px`;
    }
  });
  window.addEventListener("mouseup", () => {
    if (sizing) saveState();
    dragging = false;
    sizing = false;
  });

  ui.csv.addEventListener("change", () => {
    const file = ui.csv.files[0];
    if (!file) return;
    ui.csvName.textContent = file.name;
    const reader = new FileReader();
    reader.onload = () => {
      const { headers, rows } = parseCsv(reader.result);
      if (!headers.includes("email")) {
        ui.csvInfo.textContent = "CSV must have an 'email' column.";
        allRows = []; contacts = [];
        return;
      }
      allRows = rows;
      followUpMode = false; // a fresh list is a first touch, not a chase
      applyFilters();
      saveState();
    };
    reader.readAsText(file);
  });

  ui.unv.addEventListener("change", applyFilters);

  buildSegmentTabs();
  // Edits belong to the segment on screen, so capture them as they happen
  // rather than only on blur — switching tabs is a click, not a change event.
  [ui.subject, ui.body].forEach((el) =>
    el.addEventListener("input", () => {
      templates[activeSegment] = { subject: ui.subject.value, body: ui.body.value };
      renderPreview();
      saveState();
    })
  );
  ui.pvPrev.addEventListener("click", () => stepPreview(-1));
  ui.pvNext.addEventListener("click", () => stepPreview(1));
  [ui.delay, ui.auto, ui.keep, ui.skipSup].forEach((el) =>
    el.addEventListener("change", () => { renderList(); saveState(); })
  );

  ui.check.addEventListener("click", runPreflight);
  ui.scan.addEventListener("click", runScan);
  ui.importSent.addEventListener("click", runImportSent);
  ui.purge.addEventListener("click", purgePersonal);
  // Opens the extension's own dashboard page, which reads the same storage this
  // panel writes — so it is current without any export step.
  ui.dashboard.addEventListener("click", () =>
    window.open(chrome.runtime.getURL("dashboard.html"), "_blank"));
  ui.followups.addEventListener("click", showFollowUps);
  ui.export.addEventListener("click", exportHistory);

  [ui.rangeFrom, ui.rangeTo].forEach((el) =>
    el.addEventListener("input", () => {
      renderList();
      saveState();
    })
  );

  ui.start.addEventListener("click", () =>
    startCampaign(selectedContacts(), { isFollowUpRun: followUpMode }));
  ui.stop.addEventListener("click", () => {
    stopRequested = true;
    ui.status.textContent = "Stopping after this contact…";
  });

  restoreState();
}

// ------------------------------------------------------------- segment tabs

function buildSegmentTabs() {
  ui.segs.textContent = "";
  for (const seg of SEGMENTS) {
    const b = document.createElement("button");
    b.className = "seg" + (seg.id === activeSegment ? " on" : "");
    b.dataset.seg = seg.id;
    const label = document.createElement("span");
    label.textContent = seg.label;
    const count = document.createElement("span");
    count.className = "cnt";
    count.dataset.count = seg.id;
    count.textContent = "—";
    b.append(label, count);
    b.addEventListener("click", () => selectSegment(seg.id));
    ui.segs.appendChild(b);
  }
  loadEditorFor(activeSegment);
}

function selectSegment(id) {
  // Stash the visible edits before swapping them out from under the user.
  templates[activeSegment] = { subject: ui.subject.value, body: ui.body.value };
  activeSegment = id;
  ui.segs.querySelectorAll(".seg").forEach((b) => b.classList.toggle("on", b.dataset.seg === id));
  loadEditorFor(id);
  saveState();
}

function loadEditorFor(id) {
  const t = templates[id] || { subject: "", body: "" };
  ui.subject.value = t.subject;
  ui.body.value = t.body;
}

function updateSegmentCounts() {
  const tally = Object.fromEntries(SEGMENTS.map((s) => [s.id, 0]));
  for (const c of selectedContacts()) tally[c._segment || routeContact(c)]++;
  ui.segs.querySelectorAll("[data-count]").forEach((el) => {
    el.textContent = `${tally[el.dataset.count] || 0} contacts`;
  });
}

function applyFilters() {
  const hasStatus = allRows.some((r) => "email_status" in r);
  const withEmail = allRows.filter((r) => r.email);
  contacts =
    hasStatus && !ui.unv.checked
      ? withEmail.filter((r) => r.email_status === "valid")
      : withEmail;

  // Route once at load so the list, the counts and the send loop all agree.
  for (const c of contacts) c._segment = routeContact(c);

  ui.unvRow.classList.toggle("hidden", !hasStatus);
  const skipped = allRows.length - contacts.length;
  ui.csvInfo.textContent = skipped > 0
    ? `${contacts.length} ready to send · ${skipped} skipped`
    : `${contacts.length} ready to send`;

  // Row numbers refer to this filtered list, which is what you actually see,
  // not to line numbers in the original file.
  const n = contacts.length;
  ui.rangeRow.classList.toggle("hidden", n === 0);
  ui.list.classList.toggle("hidden", n === 0);
  ui.rangeFrom.max = String(Math.max(1, n));
  ui.rangeTo.max = String(Math.max(1, n));
  if (!ui.rangeTo.value || Number(ui.rangeTo.value) > n) ui.rangeTo.value = String(n);
  if (Number(ui.rangeFrom.value) > n) ui.rangeFrom.value = "1";
  renderList();
}

function selectedRange() {
  const n = contacts.length;
  let from = Math.max(1, Math.min(n, Number(ui.rangeFrom.value) || 1));
  let to = Math.max(1, Math.min(n, Number(ui.rangeTo.value) || n));
  if (to < from) [from, to] = [to, from];
  return { from, to };
}

function selectedContacts() {
  const { from, to } = selectedRange();
  return contacts.slice(from - 1, to);
}

function renderList() {
  const { from, to } = selectedRange();
  ui.rangeCount.textContent = contacts.length
    ? `${to - from + 1} selected`
    : "";

  ui.list.textContent = "";
  contacts.forEach((c, i) => {
    const pos = i + 1;
    const row = document.createElement("div");
    row.className = "c" + (pos < from || pos > to ? " out" : "");

    const n = document.createElement("span");
    n.className = "n";
    n.textContent = pos;

    const who = document.createElement("span");
    who.className = "who";
    who.textContent = c.name || c.first_name || "";

    const addr = document.createElement("span");
    addr.className = "addr";
    addr.textContent = c.email;

    const segId = c._segment || routeContact(c);
    const tag = document.createElement("span");
    tag.className = "seg-tag";
    tag.textContent = (SEGMENTS.find((s) => s.id === segId) || {}).label || segId;

    if (ui.skipSup.checked && suppressed.has(String(c.email).trim().toLowerCase())) {
      row.classList.add("suppressed");
      tag.textContent = "already emailed";
    }

    row.append(n, who, addr, tag);
    ui.list.appendChild(row);
  });

  updateSegmentCounts();
  renderPreview();
}

// -------------------------------------------------------------- live preview

// The panel shows the actual email for a real contact, updating as the template
// is edited. A template is read as a template while you write it; the mistakes
// only become visible once it is rendered against a row — which is the moment
// after sending, unless it is shown here.
let previewIndex = 0;

function renderPreview() {
  if (!ui || !ui.preview) return;
  const list = selectedContacts();

  if (!list.length) {
    ui.pvWho.textContent = "load a CSV to preview";
    ui.preview.textContent = "";
    return;
  }

  previewIndex = Math.max(0, Math.min(previewIndex, list.length - 1));
  const c = list[previewIndex];
  const segId = c._segment || routeContact(c);
  const seg = SEGMENTS.find((s) => s.id === segId);
  // Read the live editor for the segment on screen, so typing shows up here
  // immediately rather than after a save.
  const tpl = segId === activeSegment
    ? { subject: ui.subject.value, body: ui.body.value }
    : (templates[segId] || { subject: "", body: "" });

  ui.pvWho.textContent =
    `${previewIndex + 1} of ${list.length} · ${c.company || c.email} · ${seg ? seg.label : segId}`;

  // Two failures worth seeing before sending: a field the CSV has but left
  // empty, which silently leaves a hole in the sentence, and a field the CSV
  // does not have at all, which sends the literal {{placeholder}}.
  const mark = (text) =>
    escapeHtml(text)
      .replace(/\{\{(\w+)\}\}/g, (m, k) => {
        const v = c[k.toLowerCase()];
        if (v === undefined) return `<span class="missing">${m}</span>`;
        if (!String(v).trim()) return `<span class="gap">&nbsp;&nbsp;</span>`;
        return escapeHtml(String(v));
      });

  ui.preview.innerHTML =
    `<span class="subj">To: ${escapeHtml(c.email)}</span>` +
    `<span class="subj">Subject: ${mark(tpl.subject)}</span>` +
    mark(tpl.body);
}

function stepPreview(delta) {
  previewIndex += delta;
  renderPreview();
}

// ----------------------------------------------------------------- pre-flight

// Renders every selected contact against its template without sending, and
// reports what would have gone wrong. Cold email is unsendable once it is out,
// so the cheap moment to catch a broken merge is before the first one.
function runPreflight() {
  const list = selectedContacts();
  ui.checks.classList.remove("hidden");
  ui.checks.textContent = "";

  if (!list.length) {
    ui.checks.innerHTML = `<span class="bad">No contacts selected.</span>`;
    ui.preview.classList.add("hidden");
    return;
  }

  const issues = preflight(list, templates);
  const blocked = issues.noEmail.length + issues.dupe.length +
    (ui.skipSup.checked ? issues.suppressed.length : 0);
  const sendable = list.length - blocked;

  const line = (cls, text) => `<div class="${cls}">${text}</div>`;
  let html = "";

  html += issues.unfilled.length || issues.blank.length
    ? line("warn", `${issues.unfilled.length + issues.blank.length} of ${list.length} would send with a hole in the text.`)
    : line("ok", `All ${sendable} merge cleanly.`);

  const bullets = [];
  if (issues.unfilled.length) {
    const fields = [...new Set(issues.unfilled.flatMap((u) => u.fields))].join(", ");
    bullets.push(`<span class="bad">${issues.unfilled.length}</span> reference a column that isn't in the CSV: ${fields}`);
  }
  if (issues.blank.length) {
    const fields = [...new Set(issues.blank.flatMap((b) => b.fields))].join(", ");
    bullets.push(`<span class="warn">${issues.blank.length}</span> have an empty value, leaving a gap mid-sentence: ${fields}`);
  }
  if (issues.noEmail.length) bullets.push(`${issues.noEmail.length} have no usable email address`);
  if (issues.dupe.length) bullets.push(`${issues.dupe.length} are duplicates within this list`);
  if (issues.suppressed.length) {
    bullets.push(ui.skipSup.checked
      ? `${issues.suppressed.length} already emailed or opted out — will be skipped`
      : `<span class="bad">${issues.suppressed.length} already emailed</span> and the skip box is off`);
  }
  if (bullets.length) html += `<ul>${bullets.map((b) => `<li>${b}</li>`).join("")}</ul>`;

  const tally = Object.fromEntries(SEGMENTS.map((s) => [s.id, 0]));
  for (const c of list) tally[c._segment || routeContact(c)]++;
  html += line("", SEGMENTS.map((s) => `${s.label}: ${tally[s.id]}`).join(" · "));
  html += line("", `<strong>${sendable}</strong> would actually send.`);
  ui.checks.innerHTML = html;

  // Show the first contact of the segment being edited, so the preview matches
  // the template on screen rather than an unrelated one.
  const sample = list.find((c) => (c._segment || routeContact(c)) === activeSegment) || list[0];
  const tpl = templates[sample._segment || routeContact(sample)] || { subject: "", body: "" };
  ui.preview.classList.remove("hidden");
  ui.preview.textContent = "";
  const subj = document.createElement("span");
  subj.className = "subj";
  subj.textContent = `To ${sample.email} — ${fillTemplate(tpl.subject, sample)}`;
  ui.preview.append(subj, document.createTextNode(fillTemplate(tpl.body, sample)));
}

// ------------------------------------------------------------------- results

function renderStats() {
  const s = historyStats();
  const due = followUpDue().length;
  const cells = [
    ["", s.contacts, "contacted"],
    ["", s.emails, "emails sent"],
    ["good", `${s.replyRate.toFixed(1)}%`, `${s.replied} replied`],
    [s.bounceRate > 3 ? "bad" : "", `${s.bounceRate.toFixed(1)}%`, `${s.bounced} bounced`],
    ["", due, "follow-ups due"],
  ];
  ui.stats.textContent = "";
  for (const [cls, value, label] of cells) {
    const el = document.createElement("div");
    el.className = "stat" + (cls ? ` ${cls}` : "");
    const b = document.createElement("b");
    b.textContent = value;
    const sp = document.createElement("span");
    sp.textContent = label;
    el.append(b, sp);
    ui.stats.appendChild(el);
  }
}

// An earlier version imported all of in:sent, so personal correspondence is
// sitting in the history of anyone who ran it. This removes anything that
// cannot be attributed to a business domain.
async function purgePersonal() {
  const before = Object.keys(history).length;
  const kept = {};
  for (const [email, rec] of Object.entries(history)) {
    if (isBusinessContact(rec)) kept[email] = rec;
  }
  const removed = before - Object.keys(kept).length;
  history = kept;
  await saveHistory();
  ui.scanOut.classList.remove("hidden");
  ui.scanOut.innerHTML = removed
    ? `<div class="ok">Removed ${removed} contact${removed === 1 ? "" : "s"} that came from personal mail.</div>` +
      `<div>${Object.keys(kept).length} business contacts kept.</div>`
    : `<div class="ok">Nothing to remove — every contact is attributed to a business domain.</div>`;
  renderStats();
  renderList();
}

async function runImportSent() {
  if (running) {
    ui.scanOut.classList.remove("hidden");
    ui.scanOut.innerHTML = `<span class="bad">Not while a campaign is running — importing moves the Gmail view.</span>`;
    return;
  }
  ui.importSent.disabled = true;
  ui.scanOut.classList.remove("hidden");
  ui.scanOut.textContent = "Reading your Sent folder…";

  try {
    // Business domains only. An unfiltered read of in:sent would sweep up the
    // account's personal correspondence, which is not outreach and has no place
    // in this history.
    const res = { imported: 0, updated: 0, pages: 0, perDomain: {} };
    for (const domain of BUSINESS_DOMAINS) {
      const r = await importSentMail({
        alias: `@${domain}`,
        onProgress: (pages, imported, updated) => {
          ui.scanOut.textContent = `${domain} · page ${pages} · ${imported} new, ${updated} extra…`;
        },
      });
      res.imported += r.imported;
      res.updated += r.updated;
      res.pages += r.pages;
      res.perDomain[domain] = r.imported;
    }

    ui.scanOut.innerHTML =
      `<div class="ok">Read ${res.pages} page${res.pages === 1 ? "" : "s"} of Sent mail from your business domains.</div>` +
      `<ul>${Object.entries(res.perDomain).map(([d, n]) => `<li>${d}: ${n} contacts</li>`).join("")}` +
      `<li>${res.updated} additional sends recorded</li></ul>` +
      (res.imported ? `<div>Run <strong>Scan inbox</strong> next to find which of them replied.</div>` : "");
    renderStats();
  } catch (err) {
    ui.scanOut.innerHTML = `<span class="bad">Import failed: ${err.message}</span>`;
  } finally {
    ui.importSent.disabled = false;
  }
}

async function runScan() {
  if (running) {
    ui.scanOut.classList.remove("hidden");
    ui.scanOut.innerHTML = `<span class="bad">Not while a campaign is running — scanning moves the Gmail view.</span>`;
    return;
  }
  if (!Object.keys(history).length) {
    ui.scanOut.classList.remove("hidden");
    ui.scanOut.innerHTML = `Nothing sent yet, so there is nothing to scan for.`;
    return;
  }

  ui.scan.disabled = true;
  ui.scanOut.classList.remove("hidden");
  ui.scanOut.textContent = "Scanning for replies…";

  try {
    const replies = await scanForReplies({
      onProgress: (done, total, found) => {
        ui.scanOut.textContent = `Replies: ${done}/${total} checked, ${found} found…`;
      },
    });
    ui.scanOut.textContent = "Scanning for bounces…";
    const bounces = await scanForBounces();

    ui.scanOut.innerHTML =
      `<div class="ok">Scan complete.</div>` +
      `<ul><li>${replies.found} new repl${replies.found === 1 ? "y" : "ies"} across ${replies.scanned} contacts</li>` +
      `<li>${bounces.found} bounce${bounces.found === 1 ? "" : "s"} detected</li></ul>`;
    renderStats();
    renderList();
  } catch (err) {
    ui.scanOut.innerHTML = `<span class="bad">Scan failed: ${err.message}</span>`;
  } finally {
    ui.scan.disabled = false;
  }
}

// The follow-up queue is built from history, not from the loaded CSV — the
// whole point is chasing people whose original list you may no longer have open.
function showFollowUps() {
  const due = followUpDue();
  ui.scanOut.classList.remove("hidden");
  if (!due.length) {
    ui.scanOut.innerHTML = `Nothing due. Contacts appear here 3 days after their last email, unless they replied or bounced.`;
    return;
  }

  const byStage = { 1: 0, 2: 0 };
  for (const h of due) byStage[h.touches?.length || 1] = (byStage[h.touches?.length || 1] || 0) + 1;

  ui.scanOut.innerHTML =
    `<div class="warn">${due.length} contacts due a follow-up.</div>` +
    `<ul><li>${byStage[1] || 0} awaiting a second touch</li>` +
    `<li>${byStage[2] || 0} awaiting a third</li></ul>` +
    `<div>Loads them as the queue, using the template of whichever segment each was originally sent.</div>`;

  const go = document.createElement("button");
  go.className = "btn go";
  go.style.marginTop = "10px";
  go.textContent = `Load ${due.length} follow-ups`;
  go.addEventListener("click", () => {
    // Rebuild contact rows from history so merge fields still resolve.
    contacts = due.map((h) => ({
      email: h.email, company: h.company, name: h.name,
      vertical: h.vertical, country: h.country, city: h.city,
      _segment: h.segment, _touch: (h.touches?.length || 1) + 1,
    }));
    allRows = contacts;
    ui.rangeFrom.value = "1";
    ui.rangeTo.value = String(contacts.length);
    ui.csvInfo.textContent = `${contacts.length} follow-ups loaded from history`;
    ui.rangeRow.classList.remove("hidden");
    ui.list.classList.remove("hidden");
    renderList();
    ui.scanOut.innerHTML = `<div class="ok">${contacts.length} follow-ups loaded. Edit the template, then Start.</div>`;
    ui.status.textContent = "Follow-up queue ready — Start sends in follow-up mode.";
    followUpMode = true;
  });
  ui.scanOut.appendChild(go);
}

// Written as JSON rather than CSV because the dashboard wants the nested touch
// history, and flattening it here would only mean rebuilding it there.
function exportHistory() {
  const payload = {
    exportedAt: new Date().toISOString(),
    account: detectAccount() || "",
    stats: historyStats(),
    segments: SEGMENTS.map((s) => ({ id: s.id, label: s.label })),
    contacts: Object.values(history),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `zemenay-outreach-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  ui.scanOut.classList.remove("hidden");
  ui.scanOut.innerHTML = `<div class="ok">Exported ${Object.keys(history).length} contacts. Drop the file into the dashboard's <code>data/</code> folder.</div>`;
}

// Reflect send progress on the contact list. Rows are matched by identity, so
// a resumed queue still lines up with the rows on screen.
function markRow(contact, state) {
  const idx = contacts.indexOf(contact);
  if (idx < 0) return;
  const row = ui.list.children[idx];
  if (!row) return;
  row.classList.remove("sending", "done", "failed");
  row.classList.add(state);
  if (state === "sending") row.scrollIntoView({ block: "nearest" });
}

function addLog(text, cls) {
  const div = document.createElement("div");
  div.textContent = text;
  if (cls) div.className = cls;
  ui.log.prepend(div);
}

function setRunning(on) {
  running = on;
  ui.dot.classList.toggle("on", on);
  ui.start.classList.toggle("hidden", on);
  ui.stop.classList.toggle("hidden", !on);
}

// --------------------------------------------------------------- keep awake

// Chrome throttles timers in a hidden tab to roughly once a minute, which drags
// a 5 second delay out to a minute. It exempts tabs that are actually playing
// audio, and "actually" is the operative word: a gain of 0.0001 changed nothing
// in testing, while 0.001 lifted the throttling completely (a 100ms timer went
// from 1005ms back to 108ms). So this plays a 40Hz tone at 0.001 — under the
// exemption threshold for Chrome, effectively inaudible for you. It runs only
// while a campaign is active, and the tab shows the usual speaker icon.
let keepAwake = null;

function startKeepAwake() {
  if (keepAwake || !ui.keep.checked) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.001;
    osc.frequency.value = 40;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    // Start is a user gesture, so resume() is allowed here.
    if (ctx.state === "suspended") ctx.resume();
    keepAwake = { ctx, osc };
  } catch {
    keepAwake = null;
  }
}

function stopKeepAwake() {
  if (!keepAwake) return;
  try {
    keepAwake.osc.stop();
    keepAwake.ctx.close();
  } catch {
    /* context already gone */
  }
  keepAwake = null;
}

// ----------------------------------------------------------------- campaign

async function startCampaign(queue, { isFollowUpRun = false } = {}) {
  if (running) return;
  if (!queue.length) {
    ui.status.textContent = "Load a CSV first.";
    return;
  }
  // Capture whatever is on screen before validating — an unsaved edit in the
  // visible tab is still the template the user means to send.
  templates[activeSegment] = { subject: ui.subject.value, body: ui.body.value };

  const needed = [...new Set(queue.map((c) => c._segment || routeContact(c)))];
  const empty = needed.filter((id) => !templates[id]?.subject.trim() || !templates[id]?.body.trim());
  if (empty.length) {
    const names = empty.map((id) => (SEGMENTS.find((s) => s.id === id) || {}).label || id);
    ui.status.textContent = `Fill in the ${names.join(" and ")} template — this list needs it.`;
    return;
  }

  ui.resume.classList.add("hidden");
  stopRequested = false;
  setRunning(true);
  startKeepAwake();

  const skipSuppressed = ui.skipSup.checked;
  const remaining = [...queue];
  const total = remaining.length;
  const delayMs = Math.max(2, Number(ui.delay.value) || 5) * 1000;
  const autoSend = ui.auto.checked;
  let sent = 0, failed = 0;

  let skipped = 0;

  while (remaining.length && !stopRequested) {
    const contact = remaining[0];
    const addr = String(contact.email || "").trim().toLowerCase();

    // Emailing the same person twice is worse than not emailing them, so the
    // check happens here rather than only at load: a list can be reloaded, and
    // a resumed queue was built before the last run added to the history.
    // A follow-up run deliberately targets people already emailed, so the
    // suppression check is inverted there: what must never be re-contacted is
    // someone who replied or whose address bounced.
    const record = history[addr];
    const mustSkip = isFollowUpRun
      ? Boolean(record?.repliedAt || record?.bouncedAt)
      : skipSuppressed && suppressed.has(addr);

    if (mustSkip) {
      remaining.shift();
      skipped++;
      markRow(contact, "done");
      const why = record?.repliedAt ? "already replied"
        : record?.bouncedAt ? `bounced (${record.bounceReason})`
        : "already contacted";
      addLog(`Skipped ${contact.email} — ${why}`, "");
      await saveState(remaining);
      continue;
    }

    const segId = contact._segment || routeContact(contact);
    const tpl = templates[segId] || { subject: "", body: "" };
    ui.status.textContent = `${sent + failed} / ${total} · ${sent} ok, ${failed} failed`;
    markRow(contact, "sending");

    let result;
    let trackingId = null;
    try {
      const subject = fillTemplate(tpl.subject, contact);
      if (TRACKING.baseUrl) {
        trackingId = createTrackingId();
        await registerTracking({ trackingId, contact, segment: segId, subject });
      }
      result = await composeAndSend({
        to: contact.email,
        subject,
        body: fillTemplate(tpl.body, contact),
        autoSend,
        trackingUrl: trackingId
          ? `${TRACKING.baseUrl}/api/open.gif?id=${encodeURIComponent(trackingId)}`
          : "",
      });
    } catch (err) {
      result = { status: "error", message: err.message || String(err) };
    }

    remaining.shift();
    if (result.status === "error") {
      failed++;
      markRow(contact, "failed");
      addLog(`Failed ${contact.email}: ${result.message}`, "err");
    } else {
      sent++;
      markRow(contact, "done");
      // Record it only once Gmail confirmed, so a failure can be retried.
      await addSuppression([addr]);
      recordSend(contact, segId, fillTemplate(tpl.subject, contact), {
        followUp: isFollowUpRun,
        trackingId,
      });
      await saveHistory();
      const label = (SEGMENTS.find((s) => s.id === segId) || {}).label || segId;
      addLog(`${result.status === "sent" ? "Sent to" : "Draft closed for"} ${contact.email} (${label})`, "ok");
    }

    await saveState(remaining);
    if (!remaining.length || stopRequested) break;
    await sleep(delayMs);
  }

  stopKeepAwake();
  setRunning(false);
  const skippedNote = skipped ? `, ${skipped} skipped` : "";
  ui.status.textContent = stopRequested
    ? `Stopped. ${sent} sent, ${failed} failed${skippedNote}, ${remaining.length} left.`
    : `Done. ${sent} sent, ${failed} failed${skippedNote} of ${total}.`;
  await saveState(remaining);
  if (remaining.length) showResume(remaining);
}

function showResume(remaining) {
  ui.resume.classList.remove("hidden");
  ui.resume.innerHTML = `${remaining.length} contact(s) left from the last run.`;
  const go = document.createElement("button");
  go.className = "btn go"; go.textContent = "Resume";
  go.addEventListener("click", () => startCampaign(remaining));
  const drop = document.createElement("button");
  drop.className = "icon-btn"; drop.textContent = "×"; drop.title = "Discard";
  drop.addEventListener("click", () => {
    ui.resume.classList.add("hidden");
    saveState([]);
  });
  ui.resume.appendChild(go);
  ui.resume.appendChild(drop);
}

// -------------------------------------------------------------- persistence

function saveState(remaining) {
  templates[activeSegment] = { subject: ui.subject.value, body: ui.body.value };
  const data = {
    templates,
    activeSegment,
    delay: ui.delay.value,
    auto: ui.auto.checked,
    includeUnverified: ui.unv.checked,
    keepAwake: ui.keep.checked,
    skipSuppressed: ui.skipSup.checked,
    rangeFrom: ui.rangeFrom.value,
    rangeTo: ui.rangeTo.value,
    panelWidth: ui.wrap.style.width || "",
    panelBodyHeight: ui.panelBody.style.maxHeight || "",
  };
  if (remaining !== undefined) data.remaining = remaining;
  return new Promise((r) => chrome.storage.local.set(data, r));
}

function restoreState() {
  chrome.storage.local.get(
    [
      "templates", "activeSegment", "subject", "body", "delay", "auto", "includeUnverified",
      "remaining", "keepAwake", "skipSuppressed", "rangeFrom", "rangeTo",
      "panelWidth", "panelBodyHeight", "suppressed", "history",
    ],
    (d) => {
      suppressed = new Set(Array.isArray(d.suppressed) ? d.suppressed : []);

      // Keep every default that the saved copy doesn't override, so adding a
      // segment in a later version doesn't leave it blank for existing users.
      if (d.templates) {
        for (const seg of SEGMENTS) {
          if (d.templates[seg.id]) templates[seg.id] = d.templates[seg.id];
        }
      } else if (d.subject || d.body) {
        // Upgrade path from the single-template version: whatever was in the
        // one editor becomes the default segment's template.
        templates[DEFAULT_SEGMENT] = {
          subject: d.subject || templates[DEFAULT_SEGMENT].subject,
          body: d.body || templates[DEFAULT_SEGMENT].body,
        };
      }
      if (d.activeSegment && templates[d.activeSegment]) activeSegment = d.activeSegment;

      ui.segs.querySelectorAll(".seg").forEach((b) =>
        b.classList.toggle("on", b.dataset.seg === activeSegment));
      loadEditorFor(activeSegment);

      if (d.delay) ui.delay.value = d.delay;
      if (d.auto) ui.auto.checked = d.auto;
      if (d.includeUnverified) ui.unv.checked = d.includeUnverified;
      if (d.keepAwake !== undefined) ui.keep.checked = d.keepAwake;
      if (d.skipSuppressed !== undefined) ui.skipSup.checked = d.skipSuppressed;
      if (d.rangeFrom) ui.rangeFrom.value = d.rangeFrom;
      if (d.rangeTo) ui.rangeTo.value = d.rangeTo;
      if (d.panelWidth) ui.wrap.style.width = d.panelWidth;
      if (d.panelBodyHeight) ui.panelBody.style.maxHeight = d.panelBodyHeight;
      if (Array.isArray(d.remaining) && d.remaining.length) showResume(d.remaining);
      history = d.history && typeof d.history === "object" ? d.history : {};
      renderList();
      renderStats();
    }
  );
}

// ---------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PING") {
    sendResponse({ ok: true, account: detectAccount() });
    return false;
  }
  // Driven by the dashboard's sync, which walks every signed-in account. These
  // run headless — no panel needed in the tab, because the sync opens accounts
  // the user may never have opened the panel in.
  if (msg.type === "RUN_IMPORT") {
    (async () => {
      await loadHistory();
      const account = detectAccount();
      try {
        // Domains first — one search per domain catches every alias on it,
        // including addresses nobody listed. Then the known exact addresses,
        // which add no new mail but attribute each message to the alias that
        // actually sent it.
        //
        // There is deliberately no unfiltered pass. Searching all of in:sent
        // would pull in the account's personal correspondence, which is not
        // outreach and has no business in this history.
        const totals = { imported: 0, updated: 0, byIdentity: {} };
        const passes = [
          ...(msg.domains || []).map((d) => ({ query: `@${d}`, label: d })),
          ...(msg.aliases || []).map((a) => ({ query: a, label: a })),
        ];
        if (!passes.length) {
          sendResponse({ ok: false, account, error: "No sending domains configured." });
          return;
        }
        for (const p of passes) {
          const res = await importSentMail({ days: msg.days || 180, alias: p.query });
          totals.imported += res.imported;
          totals.updated += res.updated;
          totals.byIdentity[p.label] = res.imported;
        }
        sendResponse({ ok: true, account, ...totals });
      } catch (err) {
        sendResponse({ ok: false, account, error: err.message || String(err) });
      }
    })();
    return true;
  }
  if (msg.type === "RUN_SCAN") {
    (async () => {
      await loadHistory();
      const account = detectAccount();
      try {
        const replies = await scanForReplies({ days: msg.days || 90 });
        const bounces = await scanForBounces({ days: msg.days || 90 });
        sendResponse({ ok: true, account, replies: replies.found, bounces: bounces.found });
      } catch (err) {
        sendResponse({ ok: false, account, error: err.message || String(err) });
      }
    })();
    return true;
  }
  if (msg.type === "SHOW_PANEL") {
    chrome.storage.local.set({ panelHidden: false });
    const panel = buildPanel();
    panel.host.style.display = "";
    panel.wrap.classList.remove("collapsed");
    panel.account.textContent = detectAccount() || "Gmail account not detected";
    sendResponse({ ok: true, account: detectAccount() });
    return false;
  }
  return false;
});

// Gmail builds its UI after load; wait for the Compose button before showing up.
// A run in progress always wins, so an active campaign is never hidden.
waitFor(() => pick(document, SEL.composeButton), 30000).then((btn) => {
  if (!btn) return;
  chrome.storage.local.get(["panelHidden", "remaining"], (d) => {
    const hasUnfinishedRun = Array.isArray(d.remaining) && d.remaining.length > 0;
    if (d.panelHidden && !hasUnfinishedRun) return;
    buildPanel();
  });
});

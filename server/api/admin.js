// POST /api/admin {action, ...} — everything the admin dashboard does.
// Requires the x-admin-password header (ADMIN_PASSWORD, see _auth.js).
// GET /api/admin only says whether sign-in is possible ({adminConfigured, database}).
// Templates themselves are saved through PUT /api/config, so the extension
// picks them up too; this endpoint handles sending, schedule, queue and logs.
//
// Nothing here ever returns or logs an app password; only whether one is set.
import { command, configured } from './_store.js';
import { body, isAdmin, send, teamCors } from './_auth.js';
import { readConfig, cleanConfig, saveConfig, HISTORY_KEY } from './config.js';
import {
  K, readSettings, writeSettings, cleanSettings, readAccountStates, patchAccountState,
  hasPassword, passwordVar, mailServer, serverVar, eatWeekday, nextWeekday, sendingDay, CAP_MAX,
  LANES, LANE_LABEL, laneOf, laneOpts, normLane, contactLane, cleanLanes, FIRST_TEMPLATE_CHOICES,
} from './_settings.js';
import {
  withLock, uploadContacts, queueView, removeFromQueue, clearQueue, ensurePlan, readPlan, invalidatePlans,
  listLog, getLogBody, addLog, health, followUpsDue, scanAccount, scanAll, tick, accountsOf, testBatchPlan, sendTestBatch, testFollowUpPlan, sendTestFollowUps,
  laneAccounts, runStatus, testCountKey, templatesFor, firstTemplateFor, followupTemplateFor, renderOptsFor, personalLines, rowFor, fromHeader, senderOf, previewContact,
  CONTACT_COLUMNS, ROUTING_COLUMNS, WORDING_COLUMNS, SKIP_CATEGORIES,
} from './_engine.js';
import { checkOne, importLists, counts as suppCounts, isRoleAddress } from './_suppress.js';
import { renderEmail, routeContact, newToken, normEmail, EMAIL_RE, TEMPLATE_IDS, SEGMENTS } from './_render.js';
import { transportFor } from './_smtp.js';
import { analytics } from './_analytics.js';
import { inventory, resetData } from './_reset.js';
import { purgePreview, purgeData } from './_purge.js';
import { listReplies, latestReplies } from './_replies.js';

const SAMPLE_ROW = {
  email: 'sample@example.com', company: 'Sample Dental Ltd', first_name: 'Sam', name: 'Sam', vertical: 'dental',
  hours_gap: 'closed weekends', business_type: 'a dental practice', city: 'Leeds', country: 'GB',
};
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
// Upload column mapping from the dashboard: 'auto' or {target: csvHeader}.
const cleanMapping = (m) => {
  if (m === 'auto') return 'auto';
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const out = {};
  for (const [k, v] of Object.entries(m).slice(0, 60)) if (typeof v === 'string' && v.trim()) out[String(k).slice(0, 40)] = v.slice(0, 200);
  return Object.keys(out).length ? out : null;
};

async function pickPreviewRow(templateId, index = 0, email = '', lane = 'regular') {
  if (email) {
    const e = normEmail(email);
    const c = parse(await command('HGET', K.contacts, e));
    if (c) return { row: c.row, source: 'contact', template: c.template };
    const r = parse(await command('HGET', K.sent, e));
    if (r) return { row: r.row || { email: e, company: r.company }, source: 'sent', template: r.template };
  }
  const emails = (await command('LRANGE', K.queueOf(lane), 0, 299)) || [];
  if (emails.length) {
    const recs = (await command('HMGET', K.contacts, ...emails)).map((r) => parse(r)).filter(Boolean);
    const match = !templateId || templateId === 'followup' ? recs : recs.filter((c) => c.template === templateId);
    if (match.length) {
      const i = ((index % match.length) + match.length) % match.length;
      return { row: match[i].row, source: 'queue', template: match[i].template, index: i, of: match.length };
    }
  }
  return { row: SAMPLE_ROW, source: 'sample', template: routeContact(SAMPLE_ROW) };
}

const actions = {
  async overview() {
    const now = Date.now();
    const [settings, config, accounts, supp] = await Promise.all([readSettings(), readConfig(), health(now), suppCounts()]);
    const today = sendingDay(now, settings);
    const tomorrow = nextWeekday(today, settings.weekdays);
    const [queued, contacts, lastTick, fu] = await Promise.all([
      command('LLEN', K.queue), command('HLEN', K.contacts), command('GET', K.lastTick), command('ZCARD', K.fu),
    ]);
    const todayPlan = await readPlan(today);
    const nextAt = Math.min(...todayPlan.items.filter((it) => it.status === 'planned').map((it) => it.at));
    const sum = (items) => items.reduce((m, it) => ((m[it.status] = (m[it.status] || 0) + 1), m), {});
    return {
      now, today, todayIsSendingDay: settings.weekdays.includes(eatWeekday(today)), tomorrow,
      settings, capMax: CAP_MAX, configVersion: config.version || 0,
      accounts, suppression: supp,
      queue: { queued: Number(queued) || 0, contacts: Number(contacts) || 0, followUpCandidates: Number(fu) || 0 },
      todayPlan: { built: Boolean(todayPlan.meta), byStatus: sum(todayPlan.items), total: todayPlan.items.length },
      // Today's run in plain terms (the Sending tab's and Overview's banner).
      run: { ...runStatus(now, settings), plan: { built: Boolean(todayPlan.meta), byStatus: sum(todayPlan.items), total: todayPlan.items.length,
        nextAt: Number.isFinite(nextAt) ? nextAt : null } },
      lastTick: Number(lastTick) || null,
      lastReplyAt: Number(await command('GET', K.lastReply)) || null,
      // Sending lanes: which accounts send for each, how many wait in its
      // queue, and its options. A lane with no account sends nothing.
      lanes: Object.fromEntries(await Promise.all(LANES.map(async (l) => [l, {
        label: LANE_LABEL[l], accounts: laneAccounts(config, settings, l),
        queued: Number(await command('LLEN', K.queueOf(l))) || 0, ...laneOpts(settings, l),
      }]))),
      firstTemplateChoices: FIRST_TEMPLATE_CHOICES,
      env: {
        cronSecret: Boolean(process.env.CRON_SECRET), teamKey: Boolean(process.env.TEAM_KEY),
        passwords: Object.fromEntries(accountsOf(config).map((a) => [a, { set: hasPassword(a), var: passwordVar(a) }])),
      },
    };
  },

  async 'settings.save'(b) {
    return withLock(async () => {
      const prev = await readSettings();
      const next = cleanSettings(b.settings || {}, prev);
      await writeSettings(next);
      await invalidatePlans(Date.now(), { includeUntouchedToday: true });
      return { settings: next };
    });
  },

  // Put a sending account in a lane (Regular, Work or Hot). Only moves the
  // account; the pause and every other setting stay as they are.
  async 'account.lane'(b) {
    const config = await readConfig();
    const a = normEmail(b.account);
    if (config.senders[a] === undefined) throw bad('unknown sending account');
    if (!LANES.includes(b.lane)) throw bad('lane must be regular, work or hot');
    return withLock(async () => {
      const prev = await readSettings();
      const next = cleanSettings({ accountLanes: { [a]: b.lane } }, prev);
      await writeSettings(next);
      await invalidatePlans(Date.now(), { includeUntouchedToday: true });
      return { account: a, lane: laneOf(next, a) };
    });
  },

  // Add a sending account (e.g. the work email) straight into a lane. It is
  // added to the team list (mailer:config senders, a new config version) and
  // sends nothing until its app password env var is set and sending is on.
  async 'account.add'(b) {
    const a = normEmail(b.account);
    if (!EMAIL_RE.test(a)) throw bad('type the full email address of the account');
    const lane = normLane(b.lane);
    return withLock(async () => {
      const prev = await readConfig();
      const exists = prev.senders[a] !== undefined;
      if (!exists) {
        if (Object.keys(prev.senders).length >= 20) throw bad('20 sending accounts is the limit');
        const next = cleanConfig({ ...prev, senders: { ...prev.senders, [a]: String(b.name || '').trim() } }, prev);
        await saveConfig(next, prev);
      }
      const ps = await readSettings();
      const ns = cleanSettings({ accountLanes: { [a]: lane } }, ps);
      await writeSettings(ns);
      await invalidatePlans(Date.now(), { includeUntouchedToday: true });
      return { account: a, lane: laneOf(ns, a), added: !exists, passwordVar: passwordVar(a), hasPassword: hasPassword(a),
        server: mailServer(a).smtp, customServer: mailServer(a).custom, serverVar: serverVar(a) };
    });
  },

  // Per-lane sending options (plain text, opt-out line, cap, templates,
  // follow-ups). Never touches the pause or the schedule.
  async 'lanes.save'(b) {
    return withLock(async () => {
      const prev = await readSettings();
      const next = cleanSettings({ lanes: b.lanes && typeof b.lanes === 'object' ? b.lanes : {} }, prev);
      await writeSettings(next);
      await invalidatePlans(Date.now(), { includeUntouchedToday: true });
      return { lanes: next.lanes };
    });
  },

  // What a lane's first email or follow-up looks like for a contact in its
  // queue (or the sample row), with unsaved lane options if given.
  async 'lane.preview'(b) {
    const lane = normLane(b.lane);
    const config = await readConfig();
    let settings = await readSettings();
    if (b.lanes && typeof b.lanes === 'object') settings = { ...settings, lanes: cleanLanes(b.lanes, settings.lanes) };
    const pick = await pickPreviewRow(null, Number(b.index) || 0, b.email, lane);
    const templateId = b.which === 'followup' ? followupTemplateFor(settings, lane)
      : firstTemplateFor(settings, lane, pick.template || routeContact(pick.row || {}));
    const account = laneAccounts(config, settings, lane)[0] || null;
    const ro = renderOptsFor(settings, lane);
    const r = renderEmail({ contact: { ...rowFor(settings, pick.row), _segment: templateId }, templates: templatesFor(config, settings), templateId,
      ...senderOf(config, account), token: 'preview0000000', footer: ro.plain ? '' : settings.footer, plain: ro.plain, optOut: ro.optOut });
    return { ...r, lane, to: pick.row.email, account, source: pick.source, index: pick.index, of: pick.of };
  },

  async 'account.pause'(b) {
    const a = normEmail(b.account);
    return withLock(async () => {
      const st = await patchAccountState(a, { paused: true, auto: false, at: Date.now(), reason: String(b.reason || 'paused by admin').slice(0, 200) });
      await invalidatePlans(Date.now(), { includeUntouchedToday: true });
      return { account: a, state: st };
    });
  },

  async 'account.resume'(b) {
    const a = normEmail(b.account);
    return withLock(async () => {
      const st = await patchAccountState(a, { paused: false, auto: false, at: Date.now(), reason: '', consecutiveFailures: 0 });
      await invalidatePlans(Date.now(), { includeUntouchedToday: true });
      return { account: a, state: st };
    });
  },

  async 'plan.get'(b) {
    const now = Date.now();
    const settings = await readSettings();
    const today = sendingDay(now, settings);
    const date = b.date === 'tomorrow' || !b.date ? nextWeekday(today, settings.weekdays) : b.date === 'today' ? today : String(b.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('bad date');
    let plan = await readPlan(date);
    if (!plan.meta && date >= today && b.build !== false) plan = await withLock(() => ensurePlan(date, { now }));
    // The personal lines each first email will carry (follow-ups keep their own wording).
    const firsts = plan.items.filter((i) => !i.followUp);
    if (firsts.length) {
      const recs = (await command('HMGET', K.contacts, ...firsts.map((i) => i.email))) || [];
      firsts.forEach((it, j) => Object.assign(it, personalLines(rowFor(settings, parse(recs[j], {}).row))));
    }
    return { plan, today };
  },

  async 'plan.rebuild'(b) {
    const now = Date.now();
    return withLock(async () => {
      const n = await invalidatePlans(now, { includeUntouchedToday: true });
      const settings = await readSettings();
      const date = b.date && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : nextWeekday(sendingDay(now, settings), settings.weekdays);
      return { invalidated: n, plan: await ensurePlan(date, { now }) };
    });
  },

  async analytics(b) { return analytics(Date.now(), { days: Math.min(90, Math.max(7, Number(b.days) || 30)) }); },

  async followups(b) { return { items: await followUpsDue(Date.now(), Math.min(30, Number(b.days) || 7)) }; },

  async 'log.list'(b) {
    return listLog({ q: b.q || '', offset: Math.max(0, Number(b.offset) || 0), limit: Math.min(200, Number(b.limit) || 50),
      account: b.account || '', status: b.status || '' });
  },
  async 'log.get'(b) { return { body: await getLogBody(String(b.id || '')) }; },

  // dryRun: true (or contacts.preview) runs the exact same validation, lane
  // and suppression checks and writes nothing. mapping: {target: csvHeader}
  // or 'auto' renames columns first (e.g. "Email Address" -> email).
  async 'contacts.upload'(b) {
    if (typeof b.csv !== 'string' || !b.csv.trim()) throw bad('no CSV');
    if (b.lane !== undefined && !LANES.includes(b.lane)) throw bad('lane must be regular, work or hot');
    const opts = { includeUnverified: Boolean(b.includeUnverified), lane: normLane(b.lane), mapping: cleanMapping(b.mapping), updateExisting: b.updateExisting === true };
    if (b.dryRun === true || b.dryRun === 'true') return uploadContacts(b.csv, { ...opts, dryRun: true });
    return withLock(() => uploadContacts(b.csv, opts));
  },
  async 'contacts.preview'(b) { return actions['contacts.upload']({ ...b, dryRun: true }); },
  // What an upload CSV can contain, per the server's real parsing and routing,
  // and which template each segment gets in each lane (and whether it is empty).
  async 'contacts.format'() {
    const [config, settings] = await Promise.all([readConfig(), readSettings()]);
    const templates = templatesFor(config, settings);
    const filled = (id) => Boolean(String(templates[id]?.subject || '').trim() && String(templates[id]?.body || '').trim());
    const segments = SEGMENTS.filter((s) => s.id !== 'followup').map((s) => ({ id: s.id, label: s.label,
      lanes: Object.fromEntries(LANES.map((l) => { const t = firstTemplateFor(settings, l, s.id); return [l, { template: t, ok: filled(t) }]; })) }));
    const BUILTIN = new Set(['sender_name', 'nick_name', 'unsubscribe', 'unsubscribe_url', 'business_type', 'pain', ...CONTACT_COLUMNS.map((c) => c.id)]);
    const used = new Set();
    for (const t of Object.values(templates)) for (const m of `${t?.subject || ''}\n${t?.body || ''}`.matchAll(/\{\{(\w+)\}\}/g)) used.add(m[1].toLowerCase());
    for (const m of String(settings.footer || '').matchAll(/\{\{(\w+)\}\}/g)) used.add(m[1].toLowerCase());
    return { columns: CONTACT_COLUMNS, routingColumns: ROUTING_COLUMNS, wordingColumns: WORDING_COLUMNS,
      templateColumns: [...used].filter((c) => !BUILTIN.has(c)).sort(), segments, categories: SKIP_CATEGORIES, maxRows: 5000,
      lanes: Object.fromEntries(LANES.map((l) => [l, { label: LANE_LABEL[l], accounts: laneAccounts(config, settings, l).length }])) };
  },
  async 'queue.list'(b) { return queueView({ offset: Math.max(0, Number(b.offset) || 0), limit: Math.min(500, Number(b.limit) || 200), lane: normLane(b.lane),
    filter: ['personal', 'standard'].includes(b.filter) ? b.filter : 'all' }); },
  // The exact first email a queued or planned contact will get.
  async 'contact.preview'(b) { return previewContact(b.email); },
  async 'queue.remove'(b) {
    return withLock(async () => ({ removed: await removeFromQueue(b.email), invalidated: await invalidatePlans(Date.now()) }));
  },
  async 'queue.clear'(b) { return withLock(async () => { await invalidatePlans(Date.now()); return { lane: normLane(b.lane), removed: await clearQueue(normLane(b.lane)) }; }); },
  async 'contacts.requeue'(b) {
    const e = normEmail(b.email);
    return withLock(async () => {
      const c = parse(await command('HGET', K.contacts, e));
      if (!c) throw bad('no such contact');
      if (!['blocked', 'removed'].includes(c.status)) throw bad(`only blocked or removed contacts can be requeued (this one is ${c.status})`);
      const reason = await checkOne(e, { settings: await readSettings(), firstTouch: true });
      if (reason) throw bad(`suppressed: ${reason}`);
      await command('HSET', K.contacts, e, JSON.stringify({ ...c, status: 'queued', reason: null }));
      await command('RPUSH', K.queueOf(contactLane(c)), e);
      return { requeued: e, lane: contactLane(c) };
    });
  },

  async 'supp.counts'() { return suppCounts(); },
  async 'supp.import'(b) {
    const arr = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,;]+/) : []);
    return importLists({ emails: arr(b.emails), domains: arr(b.domains), optout: arr(b.optout) });
  },
  async 'supp.check'(b) {
    const e = normEmail(b.email);
    const settings = await readSettings();
    return { email: e, firstEmail: await checkOne(e, { settings, firstTouch: true }),
      followUp: await checkOne(e, { settings, firstTouch: false }), role: isRoleAddress(e) };
  },

  async preview(b) {
    const config = await readConfig();
    const settings = await readSettings();
    const templateId = TEMPLATE_IDS.includes(b.templateId) ? b.templateId : 'callcenter';
    const pick = await pickPreviewRow(templateId, Number(b.index) || 0, b.email);
    const templates = { ...config.templates };
    if (b.template) templates[templateId] = { subject: String(b.template.subject || ''), body: String(b.template.body || '') };
    const account = b.account && config.senders[b.account] !== undefined ? b.account : accountsOf(config)[0];
    const r = renderEmail({ contact: { ...rowFor(settings, pick.row), _segment: templateId }, templates, templateId,
      ...senderOf(config, account), token: 'preview0000000', footer: b.footer !== undefined ? String(b.footer) : settings.footer });
    return { ...r, to: pick.row.email, account, source: pick.source, contactTemplate: pick.template, index: pick.index, of: pick.of };
  },

  async 'test.send'(b) {
    const config = await readConfig();
    const settings = await readSettings();
    const account = normEmail(b.account);
    const to = normEmail(b.to);
    if (config.senders[account] === undefined) throw bad('unknown sending account');
    if (!EMAIL_RE.test(to)) throw bad('type the address to send the test to');
    // The account's lane decides plain text vs HTML, and 'lane' / 'lane-followup'
    // pick that lane's own first-email / follow-up template.
    const lane = laneOf(settings, account);
    const laneTpl = b.templateId === 'lane' || b.templateId === 'lane-followup';
    let templateId = TEMPLATE_IDS.includes(b.templateId) ? b.templateId : 'callcenter';
    const dryRun = settings.dryRun || Boolean(b.dryRun);
    if (!dryRun && !hasPassword(account)) throw bad(`no app password set for ${account} (${passwordVar(account)})`);
    const day = testCountKey(sendingDay(Date.now(), settings));
    const n = Number(await command('HINCRBY', day, account, 1));
    await command('EXPIRE', day, 3 * 86400);
    if (n > 10) { await command('HINCRBY', day, account, -1); throw bad('10 test sends per account per day is the limit'); }
    const pick = laneTpl ? await pickPreviewRow(null, Number(b.index) || 0, b.email, lane) : await pickPreviewRow(templateId, Number(b.index) || 0, b.email);
    if (b.templateId === 'lane') templateId = firstTemplateFor(settings, lane, pick.template || routeContact(pick.row || {}));
    if (b.templateId === 'lane-followup') templateId = followupTemplateFor(settings, lane);
    const token = newToken();
    const { senderName, nickName } = senderOf(config, account);
    const ro = renderOptsFor(settings, lane);
    const r = renderEmail({ contact: { ...rowFor(settings, pick.row), _segment: templateId }, templates: templatesFor(config, settings), templateId, senderName, nickName, token,
      footer: ro.plain ? '' : settings.footer, plain: ro.plain, optOut: ro.optOut });
    const mail = r.plain
      ? { from: fromHeader(senderName, account), to, subject: `[TEST] ${r.subject}`, text: r.text }
      : {
        from: fromHeader(senderName, account), to,
        subject: `[TEST] ${r.subject}`, text: r.text, html: r.html,
        headers: settings.listUnsubscribe ? { 'List-Unsubscribe': `<${r.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {},
      };
    const transport = transportFor(account, { dryRun });
    try {
      const info = await transport.sendMail(mail);
      await addLog({ account, to, templateId, subject: mail.subject, status: dryRun ? 'test (dry-run)' : 'test',
        messageId: info.messageId || '', response: String(info.response || '').slice(0, 200), token, renderedFor: pick.row.email,
        ...(lane !== 'regular' ? { lane } : {}), ...(r.plain ? { plain: true } : {}) },
      { subject: mail.subject, text: r.text, html: r.html, from: account, ...(r.plain ? { plain: true } : {}) });
      return { ok: true, dryRun, messageId: info.messageId || '', subject: mail.subject, renderedFor: pick.row.email, problems: r.problems, lane, plain: Boolean(r.plain) };
    } catch (err) {
      const msg = String(err?.response || err?.message || err).slice(0, 300);
      await addLog({ account, to, templateId, subject: mail.subject, status: 'test failed', error: msg });
      throw bad(`send failed: ${msg}`, 502);
    } finally { try { transport.close?.(); } catch { /* ignore */ } }
  },

  async 'config.history'() {
    const list = ((await command('LRANGE', HISTORY_KEY, 0, 19)) || []).map((j) => parse(j)).filter(Boolean);
    return { items: list.map((c, i) => ({ index: i, version: c.version || 0, updatedAt: c.updatedAt || null, replacedAt: c.replacedAt,
      templates: c.templates, dailyLimit: c.dailyLimit, followUpDays: c.followUpDays, maxTouches: c.maxTouches, senders: c.senders })) };
  },
  async 'config.rollback'(b) {
    const list = (await command('LRANGE', HISTORY_KEY, 0, 19)) || [];
    const old = parse(list[Number(b.index)]);
    if (!old) throw bad('no such version');
    const prev = await readConfig();
    const keep = b.keepSenders !== false;
    const next = cleanConfig({ ...old, senders: keep ? prev.senders : old.senders, nicknames: keep ? prev.nicknames : old.nicknames }, prev);
    await saveConfig(next, prev);
    return { config: next, restoredFrom: old.version || 0 };
  },

  async 'scan.now'(b) {
    const a = normEmail(b.account);
    if (!hasPassword(a)) throw bad(`no app password set for ${a}`);
    return withLock(() => scanAccount(a, Date.now()));
  },
  async 'tick.run'() { return tick({ now: Date.now() }); },
  // "Check inboxes now": every account, replies and bounces, right away.
  async 'scan.all'() { return withLock(() => scanAll(Date.now()), { waitMs: 15000 }); },
  async 'replies.list'(b) { return listReplies({ kind: ['replies', 'auto', 'all'].includes(b.kind) ? b.kind : 'replies', q: b.q || '', limit: b.limit }); },
  async 'replies.latest'() { return latestReplies(20); },

  // "Send test batch now": preview (no confirm) lists exactly who would get an
  // email from which account; with confirm: [emails] it sends one per account,
  // now, to allowlisted queued contacts only, ignoring pause and window.
  async 'flow.testNow'(b) {
    const lane = normLane(b.lane);
    if (!Array.isArray(b.confirm)) return { preview: true, ...(await testBatchPlan({ now: Date.now(), lane })) };
    return withLock(() => sendTestBatch({ now: Date.now(), only: b.confirm.map(String), lane }));
  },

  // "Send test follow-up now": preview lists recipient, account and touch;
  // with confirm: [emails] it checks those accounts' inboxes for replies, then
  // sends the next follow-up now, allowlisted contacts only.
  async 'flow.testFollowUp'(b) {
    const lane = normLane(b.lane);
    if (!Array.isArray(b.confirm)) return { preview: true, ...(await testFollowUpPlan({ now: Date.now(), lane })) };
    return withLock(() => sendTestFollowUps({ now: Date.now(), only: b.confirm.map(String), lane }));
  },

  // Empties the sending data (contacts, queue, plans, log, send records,
  // counters, server-mail opens) and keeps every setting and suppression list.
  // Without confirm: 'RESET' it only reports what it would remove.
  // Deletes named addresses (a test upload, your own inboxes) from the sending
  // data and nothing else. Without confirm: 'DELETE' it only reports what it
  // would remove.
  async 'data.purge'(b) {
    if (b.confirm !== 'DELETE') return { dryRun: true, ...(await purgePreview(b.emails)) };
    return withLock(() => purgeData(b.emails, { now: Date.now(), alsoOptout: b.alsoOptout === true }), { waitMs: 15000 });
  },

  async 'data.reset'(b) {
    if (b.confirm !== 'RESET') return { dryRun: true, ...(await inventory()) };
    return withLock(() => resetData({ now: Date.now() }), { waitMs: 15000 });
  },
};

export default async function handler(req, res) {
  teamCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  // GET is the sign-in screen's probe: whether it can work at all. No secrets,
  // no data, no password check.
  if (req.method === 'GET') return send(res, 200, { adminConfigured: Boolean(process.env.ADMIN_PASSWORD), database: configured });
  if (!configured) return send(res, 503, { error: 'no database connected' });
  if (!process.env.ADMIN_PASSWORD) return send(res, 401, { error: 'ADMIN_PASSWORD is not set on the server' });
  if (!isAdmin(req)) return send(res, 401, { error: 'wrong password' });
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const b = body(req);
  const fn = actions[b.action];
  if (!fn) return send(res, 400, { error: `unknown action ${String(b.action).slice(0, 40)}` });
  try {
    return send(res, 200, await fn(b));
  } catch (err) {
    return send(res, err.status || 500, { error: err.message || 'error' });
  }
}

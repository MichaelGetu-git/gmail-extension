// Builds (or reads) today's plan in the local Redis and prints it, plus one
// email rendered exactly as sendItem would. Sends nothing.
//
//   node scripts/local-plan.mjs [--all]
import { useLocal, flag } from './_local.mjs';

await useLocal();
const { readSettings, sendingDay, eatClock, laneOf } = await import('../api/_settings.js');
const { readConfig } = await import('../api/config.js');
const { ensurePlan, senderOf, templatesFor, renderOptsFor, rowFor } = await import('../api/_engine.js');
const { renderEmail } = await import('../api/_render.js');
const { command } = await import('../api/_store.js');

const now = Date.now();
const settings = await readSettings();
const config = await readConfig();
const today = sendingDay(now, settings);
const plan = await ensurePlan(today, { now });
const items = plan.items.sort((a, b) => a.at - b.at);
console.log(`${today}: paused=${settings.paused}, window ${settings.windowStart}-${settings.windowEnd}, cutoff ${settings.lateCutoff}, gaps ${settings.minGapMin}-${settings.maxGapMin} min`);
console.log(`${items.length} emails planned (${items.filter((i) => i.followUp).length} follow-ups), first ${eatClock(items[0]?.at)} EAT, last ${eatClock(items.at(-1)?.at)} EAT`);
const per = {};
for (const i of items) (per[i.account] ||= []).push(eatClock(i.at));
for (const [a, t] of Object.entries(per)) console.log(`  ${a.padEnd(30)} ${t.join('  ')}`);
if (flag('all')) for (const i of items) console.log(`  ${eatClock(i.at)}  ${i.account.padEnd(30)} -> ${i.email}`);

const it = items[0];
if (it) {
  const c = JSON.parse(await command('HGET', 'mailer:srv:contacts', it.email));
  const lane = laneOf(settings, it.account);
  const ro = renderOptsFor(settings, lane);
  const { senderName, nickName } = senderOf(config, it.account);
  const r = renderEmail({ contact: { ...rowFor(settings, c.row), _segment: it.template }, templates: templatesFor(config, settings),
    templateId: it.template, senderName, nickName, token: 'preview', footer: ro.plain ? '' : settings.footer, plain: ro.plain, optOut: ro.optOut });
  console.log(`\n--- first email: ${eatClock(it.at)} EAT, from "${senderName}" <${it.account}> to ${it.email} (plain text: ${Boolean(r.plain)}, placeholders ok: ${r.problems.ok})`);
  console.log(`Subject: ${r.subject}\n\n${r.text}`);
}
process.exit(0);

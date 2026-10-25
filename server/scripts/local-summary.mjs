// Summary of a sending day in the local Redis: the plan's outcome, the send
// log (sent / bounced / failed) and replies found in the inboxes since the
// first send. Sends nothing.
//
//   node scripts/local-summary.mjs [--date 2026-10-23] [--pending]   (--pending: print only how many are still planned)
import { useLocal, arg, flag } from './_local.mjs';

await useLocal();
const { readPlan } = await import('../api/_engine.js');
const { eatClock, eatDate } = await import('../api/_settings.js');
const { command } = await import('../api/_store.js');

const date = arg('date', eatDate(Date.now()));
const items = (await readPlan(date)).items;
const open = items.filter((i) => ['planned', 'sending'].includes(i.status)).length;
if (flag('pending')) { console.log(open); process.exit(0); }

const byStatus = {};
for (const i of items) byStatus[i.status] = (byStatus[i.status] || 0) + 1;
const tried = items.filter((i) => i.attemptedAt).map((i) => i.attemptedAt);
const since = Math.min(...tried, Date.now());

const log = ((await command('LRANGE', 'mailer:srv:log', 0, 999)) || []).map((l) => JSON.parse(l)).filter((l) => (l.at || 0) >= since - 60000);
const count = {};
for (const l of log) count[l.status] = (count[l.status] || 0) + 1;
const replies = ((await command('LRANGE', 'mailer:srv:replies', 0, 499)) || []).map((r) => JSON.parse(r)).filter((r) => (r.at || r.detectedAt || 0) >= since);

console.log(`${date}: ${items.length} planned emails -> ${JSON.stringify(byStatus)}`);
console.log(`first attempt ${eatClock(Math.min(...tried))} EAT, last ${eatClock(Math.max(...tried))} EAT, still open: ${open}`);
console.log(`log since then: ${JSON.stringify(count)}`);
for (const l of log.filter((l) => !['sent', 'auto-reply'].includes(l.status))) {
  console.log(`  ${eatClock(l.at)} ${l.status.padEnd(10)} ${String(l.account || '').padEnd(30)} -> ${l.to || ''}  ${l.error || l.reason || ''}`.slice(0, 220));
}
console.log(`replies / auto-replies detected since the first send: ${replies.length}`);
for (const r of replies) console.log(`  ${eatClock(r.at || r.detectedAt)} ${r.auto ? 'auto ' : 'REPLY'} ${r.account} <- ${r.from || r.email}  ${String(r.subject || '').slice(0, 70)}`);
process.exit(0);

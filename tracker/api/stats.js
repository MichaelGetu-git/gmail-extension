import { db, ensureSchema } from "./_db.js";
import { DASHBOARD_KEY, allowCors, authorized } from "./_config.js";

export default async function handler(req, res) {
  allowCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!authorized(req, DASHBOARD_KEY, "x-dashboard-key")) {
    return res.status(401).json({ error: "Invalid dashboard key" });
  }

  try {
    const sql = db();
    await ensureSchema(sql);
    const rows = await sql`
      SELECT tracking_id, recipient_email, company, segment, subject,
             sent_at, first_opened_at, last_opened_at, open_count
      FROM email_tracking
      ORDER BY sent_at DESC
    `;
    const totals = rows.reduce((out, row) => {
      out.sent++;
      if (row.first_opened_at) out.opened++;
      out.opens += Number(row.open_count || 0);
      return out;
    }, { sent: 0, opened: 0, opens: 0 });
    totals.openRate = totals.sent ? (totals.opened / totals.sent) * 100 : 0;
    return res.status(200).json({ totals, rows });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not read stats" });
  }
}

import { db, ensureSchema } from "./_db.js";
import { DASHBOARD_KEY, allowCors, authorized } from "./_config.js";

export default async function handler(req, res) {
  allowCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "DELETE") return res.status(405).json({ error: "DELETE required" });
  if (!authorized(req, DASHBOARD_KEY, "x-dashboard-key")) {
    return res.status(401).json({ error: "Invalid dashboard key" });
  }

  const id = String(req.query?.id || "");
  if (!id && String(req.query?.all || "") !== "true") {
    return res.status(400).json({ error: "A tracking id or all=true is required" });
  }

  try {
    const sql = db();
    await ensureSchema(sql);
    if (id) await sql`DELETE FROM email_tracking WHERE tracking_id = ${id}`;
    else await sql`DELETE FROM email_tracking`;
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not delete tracking data" });
  }
}

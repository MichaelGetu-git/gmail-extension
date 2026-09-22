import { db, ensureSchema } from "./_db.js";
import { WRITE_KEY, allowCors, authorized } from "./_config.js";

export default async function handler(req, res) {
  allowCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
  if (!authorized(req, WRITE_KEY, "x-write-key")) {
    return res.status(401).json({ error: "Invalid write key" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    if (!body.trackingId || !body.recipientEmail) {
      return res.status(400).json({ error: "trackingId and recipientEmail are required" });
    }

    const sql = db();
    await ensureSchema(sql);
    await sql`
      INSERT INTO email_tracking
        (tracking_id, recipient_email, company, segment, subject, sent_at)
      VALUES
        (${String(body.trackingId)}, ${String(body.recipientEmail).toLowerCase()},
         ${String(body.company || "")}, ${String(body.segment || "")},
         ${String(body.subject || "")}, NOW())
      ON CONFLICT (tracking_id) DO UPDATE SET
        recipient_email = EXCLUDED.recipient_email,
        company = EXCLUDED.company,
        segment = EXCLUDED.segment,
        subject = EXCLUDED.subject
    `;
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Registration failed" });
  }
}

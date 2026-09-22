import { db, ensureSchema } from "./_db.js";
import { allowCors } from "./_config.js";

const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

export default async function handler(req, res) {
  allowCors(res);
  const id = String(req.query?.id || "");

  if (id) {
    try {
      const sql = db();
      await ensureSchema(sql);
      await sql`
        UPDATE email_tracking
        SET first_opened_at = COALESCE(first_opened_at, NOW()),
            last_opened_at = NOW(),
            open_count = open_count + 1
        WHERE tracking_id = ${id}
      `;
    } catch {
     
    }
  }

  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  return res.status(200).send(PIXEL);
}

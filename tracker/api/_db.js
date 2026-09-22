import { neon } from "@neondatabase/serverless";
import { DATABASE_URL } from "./_config.js";

export function db() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  return neon(DATABASE_URL);
}

export async function ensureSchema(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS email_tracking (
      tracking_id TEXT PRIMARY KEY,
      recipient_email TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      segment TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      first_opened_at TIMESTAMPTZ,
      last_opened_at TIMESTAMPTZ,
      open_count INTEGER NOT NULL DEFAULT 0
    )
  `;
}

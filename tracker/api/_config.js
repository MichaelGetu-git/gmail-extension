
export const DASHBOARD_KEY = process.env.DASHBOARD_KEY || "change-this-dashboard-key";
export const WRITE_KEY = process.env.WRITE_KEY || "change-this-write-key";
export const DATABASE_URL = process.env.DATABASE_URL || "";

export function allowCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Write-Key, X-Dashboard-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
}

export function authorized(req, expected, header) {
  return String(req.headers[header] || req.query?.key || "") === expected;
}

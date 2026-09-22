const API = "/api/stats";
const DELETE_API = "/api/delete";
const PAGE_SIZE = 10;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const date = (s) => s ? new Date(s).toLocaleString() : "—";

let dashboardKey = "";
let allRows = [];
let filteredRows = [];
let currentPage = 1;

function normalizedRows(rows) {
  return rows.map((row) => ({
    ...row,
    recipient_open_count: Math.max(0, Number(row.open_count || 0) - 1),
    recipient_opened: Number(row.open_count || 0) > 1,
  }));
}

function renderTiles() {
  const t = allRows.reduce((out, row) => {
    out.sent++;
    if (row.recipient_opened) out.opened++;
    out.opens += row.recipient_open_count;
    return out;
  }, { sent: 0, opened: 0, opens: 0 });
  const rate = t.sent ? (t.opened / t.sent) * 100 : 0;
  $("tiles").innerHTML = [
    [t.sent, "Tracked emails"], [t.opened, "Unique opens"],
    [`${rate.toFixed(1)}%`, "Open rate"], [t.opens, "Recipient image loads"],
  ].map(([value, label]) => `<div class="tile"><div class="value">${esc(value)}</div><div class="label">${esc(label)}</div></div>`).join("");
}

function renderRows() {
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, totalPages);
  const pageRows = filteredRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  $("rows").innerHTML = pageRows.length ? pageRows.map((r) => `<tr>
    <td><strong>${esc(r.recipient_email)}</strong><small>${esc(r.company || "")}</small></td>
    <td>${esc(r.segment)}</td><td>${date(r.sent_at)}</td>
    <td class="${r.recipient_opened ? "yes" : "muted"}">${r.recipient_opened ? date(r.last_opened_at) : "Not opened"}</td>
    <td>${esc(r.recipient_open_count)}</td>
    <td><button class="delete-one" data-id="${esc(r.tracking_id)}">Delete</button></td>
  </tr>`).join("") : `<tr><td class="empty" colspan="6">No matching tracking records.</td></tr>`;
  $("pageInfo").textContent = `Page ${currentPage} of ${totalPages} · ${filteredRows.length} record${filteredRows.length === 1 ? "" : "s"}`;
  $("previous").disabled = currentPage <= 1;
  $("next").disabled = currentPage >= totalPages;
}

function applySearch() {
  const query = $("search").value.trim().toLowerCase();
  const state = $("stateFilter").value;
  filteredRows = allRows.filter((row) => [row.recipient_email, row.company, row.segment, row.subject]
    .some((value) => String(value || "").toLowerCase().includes(query))
    && (state === "all" || (state === "opened" && row.recipient_opened) || (state === "not-opened" && !row.recipient_opened)));
  currentPage = 1;
  renderRows();
}

async function load() {
  dashboardKey = $("key").value.trim();
  if (!dashboardKey) return $("status").textContent = "Enter the dashboard key.";
  $("status").textContent = "Loading…";
  try {
    const res = await fetch(API, { headers: { "X-Dashboard-Key": dashboardKey } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    allRows = normalizedRows(data.rows || []);
    renderTiles();
    applySearch();
    $("status").textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) { $("status").textContent = error.message; }
}

async function deleteRecord(id) {
  const row = allRows.find((item) => item.tracking_id === id);
  if (!row || !confirm(`Delete tracking data for ${row.recipient_email}?`)) return;
  const res = await fetch(`${DELETE_API}?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-Dashboard-Key": dashboardKey } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Delete failed");
  allRows = allRows.filter((item) => item.tracking_id !== id);
  renderTiles(); applySearch();
  $("status").textContent = "Record deleted.";
}

$("load").addEventListener("click", load);
$("key").addEventListener("keydown", (event) => { if (event.key === "Enter") load(); });
$("search").addEventListener("input", applySearch);
$("stateFilter").addEventListener("change", applySearch);
$("previous").addEventListener("click", () => { currentPage--; renderRows(); });
$("next").addEventListener("click", () => { currentPage++; renderRows(); });
$("rows").addEventListener("click", async (event) => {
  const button = event.target.closest(".delete-one");
  if (!button) return;
  try { await deleteRecord(button.dataset.id); } catch (error) { $("status").textContent = error.message; }
});
$("clearAll").addEventListener("click", async () => {
  if (!dashboardKey || !allRows.length || !confirm("Delete ALL tracking data? This cannot be undone.")) return;
  try {
    const res = await fetch(`${DELETE_API}?all=true`, { method: "DELETE", headers: { "X-Dashboard-Key": dashboardKey } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Delete failed");
    allRows = []; renderTiles(); applySearch();
    $("status").textContent = "All tracking data deleted.";
  } catch (error) { $("status").textContent = error.message; }
});

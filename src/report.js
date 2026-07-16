/**
 * report.js — monthly conversation statistics from the Supabase
 * `conversations` table: "bu ay 340 satış sorusu, 27 şikayet, 12 devir".
 *
 * Served on GET /report?month=YYYY-MM (see index.js) and emailed
 * automatically on the 1st of each month for the previous month.
 */

const db = require('./db');

/** @param {string} month  'YYYY-MM' */
function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error(`Invalid month "${month}" — expected YYYY-MM`);
  const start = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const end = new Date(Date.UTC(y, m, 1)).toISOString();
  return { start, end };
}

/**
 * @returns {Promise<{month, totalIncoming, uniqueCustomers, byIntent, handovers}>}
 */
async function buildMonthlyReport(month) {
  const { start, end } = monthRange(month);
  const rows = await db.getMonthIncoming(start, end);

  const byIntent = {};
  const customers = new Set();
  let handovers = 0;
  for (const r of rows) {
    const intent = r.intent || 'diger';
    byIntent[intent] = (byIntent[intent] || 0) + 1;
    if (r.needs_human) handovers++;
    if (r.session_id) customers.add(r.session_id);
  }

  return {
    month,
    totalIncoming: rows.length,
    uniqueCustomers: customers.size,
    byIntent,
    handovers,
  };
}

/** Human-readable text version (used for the report email). */
function formatReportText(r) {
  const lines = [
    `ALWA aylık rapor — ${r.month}`,
    ``,
    `Toplam gelen mesaj: ${r.totalIncoming}`,
    `Tekil müşteri: ${r.uniqueCustomers}`,
    `İnsana devir: ${r.handovers}`,
    ``,
    `Niyet dağılımı:`,
    ...Object.entries(r.byIntent)
      .sort((a, b) => b[1] - a[1])
      .map(([intent, count]) => `  - ${intent}: ${count}`),
  ];
  return lines.join('\n');
}

module.exports = { buildMonthlyReport, formatReportText, monthRange };

/**
 * logger.js — Layer 1 of error tracking: structured step logging.
 *
 * Every significant step of the message flow calls step()/fail() so the
 * live server console (Railway/Render logs) reads like a play-by-play:
 *
 *   2026-07-07T10:15:01.123Z [OK]   +905551112233 | message received | "how much is..."
 *   2026-07-07T10:15:02.456Z [OK]   +905551112233 | AI responded (1.3s)
 *   2026-07-07T10:15:03.001Z [FAIL] +905551112233 | reply sent to WhatsApp | Error: 401 ...
 */

function line(status, phone, stepName, detail) {
  const ts = new Date().toISOString();
  const parts = [ts, `[${status}]`.padEnd(6), phone || '-', '|', stepName];
  if (detail) parts.push('|', detail);
  return parts.join(' ');
}

/** Log a successful (or informational) step. */
function step(phone, stepName, detail) {
  console.log(line('OK', phone, stepName, truncate(detail)));
}

/** Log a failed step. (errorTracker calls this — prefer errorTracker.record) */
function fail(phone, stepName, detail) {
  console.error(line('FAIL', phone, stepName, truncate(detail)));
}

/** General non-flow info (startup, config, etc.). */
function info(message) {
  console.log(`${new Date().toISOString()} [INFO] ${message}`);
}

function truncate(text, max = 200) {
  if (!text) return text;
  const s = String(text).replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

module.exports = { step, fail, info, truncate };

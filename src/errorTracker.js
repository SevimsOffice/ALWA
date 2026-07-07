/**
 * errorTracker.js — Layers 2+3 of error tracking.
 *
 * Every risky operation in the flow is wrapped in try/catch by the
 * caller (handler.js); on failure the caller calls record(). record()
 * NEVER throws and the process NEVER crashes because of a tracked
 * error:
 *
 *   1. writes a [FAIL] line to the console        (live visibility)
 *   2. appends a row to the "errors" Sheet tab    (human-readable history)
 *   3. on severity 'critical', fires the email /  (proactive alerting)
 *      optional-channel notifications
 *
 * If the error sheet or the notification THEMSELVES fail, that is
 * logged to the console only — the one place that can't fail.
 */

const logger = require('./logger');

/**
 * @param {object} e
 * @param {string} e.step      one of: message-receive / intent / AI / WhatsApp / Sheet / handover / apps-script / webhook
 * @param {string} [e.phone]   customer phone if known
 * @param {Error|string} e.error
 * @param {'warning'|'error'|'critical'} [e.severity]  critical => also notify staff
 */
async function record({ step, phone, error, severity = 'error' }) {
  const message = error instanceof Error ? error.message : String(error);

  // Layer 1/console — this can never fail.
  logger.fail(phone, step, `[${severity}] ${message}`);

  // Layer 3a — errors sheet. Lazy require avoids a circular import.
  try {
    const sheets = require('./sheets');
    await sheets.logError({ phone, step, message, severity });
  } catch (sheetErr) {
    logger.fail(phone, 'error-sheet write', sheetErr.message);
  }

  // Layer 3b — notification on critical failures.
  if (severity === 'critical') {
    try {
      const notify = require('./notify');
      await notify.sendErrorAlert(phone, step, message);
    } catch (notifyErr) {
      logger.fail(phone, 'error notification', notifyErr.message);
    }
  }
}

module.exports = { record };

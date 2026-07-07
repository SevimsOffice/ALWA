/**
 * sheets.js — Google Sheets logging via a service account.
 *
 * Two tabs in ONE spreadsheet (created automatically on startup if
 * missing):
 *   - "messages": one row per message, incoming AND outgoing, grouped
 *     by session_id (= customer phone number) so a whole conversation
 *     can be filtered with one click.
 *   - "errors":   one row per caught error — the human-readable error
 *     dashboard (Layer 3 of error tracking).
 *
 * Uses the Sheets REST API directly with a google-auth-library JWT
 * client — no heavyweight googleapis dependency.
 */

const { JWT } = require('google-auth-library');
const { env } = require('./config');
const logger = require('./logger');
const mocks = require('./mocks');

const MESSAGES_SHEET = 'messages';
const ERRORS_SHEET = 'errors';

const MESSAGES_HEADER = [
  'timestamp', 'session_id', 'direction', 'sender_phone', 'message_text',
  'ai_response', 'detected_intent', 'needs_human', 'status',
];
const ERRORS_HEADER = [
  'timestamp', 'phone_number', 'step', 'error_message', 'severity',
];

let jwtClient = null;

function getClient() {
  if (!jwtClient) {
    jwtClient = new JWT({
      email: env.googleServiceAccountEmail,
      key: env.googlePrivateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  return jwtClient;
}

async function sheetsRequest(method, path, body) {
  const client = getClient();
  const { token } = await client.getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.googleSheetId}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sheets API ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function appendRow(sheetName, row) {
  if (env.mockMode) {
    mocks.state.sheetRows.push({ sheet: sheetName, row });
    return { mocked: true };
  }
  const range = encodeURIComponent(`${sheetName}!A1`);
  await sheetsRequest(
    'POST',
    `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { values: [row] }
  );
}

/**
 * Log one message row. Called for every incoming and outgoing message.
 * @param {object} m
 * @param {string} m.sessionId       customer phone number (the session key)
 * @param {'incoming'|'outgoing'} m.direction
 * @param {string} m.senderPhone     who wrote this message (customer phone or 'bot')
 * @param {string} m.messageText     the message content
 * @param {string} [m.aiResponse]    for incoming rows: the AI's reply to it
 * @param {string} [m.detectedIntent]
 * @param {boolean} [m.needsHuman]
 * @param {string} [m.status]        e.g. 'ok', 'muted', 'ai_failed'
 */
async function logMessage(m) {
  await appendRow(MESSAGES_SHEET, [
    new Date().toISOString(),
    m.sessionId,
    m.direction,
    m.senderPhone,
    m.messageText || '',
    m.aiResponse || '',
    m.detectedIntent || '',
    m.needsHuman ? 'yes' : 'no',
    m.status || 'ok',
  ]);
}

/** Log one error row to the "errors" tab. */
async function logError(e) {
  await appendRow(ERRORS_SHEET, [
    new Date().toISOString(),
    e.phone || '-',
    e.step,
    logger.truncate(e.message, 500),
    e.severity || 'error',
  ]);
}

/**
 * Startup task: make sure both tabs exist and have header rows.
 * Safe to run every boot; does nothing if already set up.
 */
async function ensureSheetsExist() {
  if (env.mockMode) {
    logger.info('MOCK: skipping Google Sheets setup');
    return;
  }
  const meta = await sheetsRequest('GET', '?fields=sheets.properties.title');
  const existing = (meta.sheets || []).map((s) => s.properties.title);

  const toCreate = [MESSAGES_SHEET, ERRORS_SHEET].filter((t) => !existing.includes(t));
  if (toCreate.length > 0) {
    await sheetsRequest('POST', ':batchUpdate', {
      requests: toCreate.map((title) => ({ addSheet: { properties: { title } } })),
    });
  }
  for (const [title, header] of [
    [MESSAGES_SHEET, MESSAGES_HEADER],
    [ERRORS_SHEET, ERRORS_HEADER],
  ]) {
    const range = encodeURIComponent(`${title}!A1:Z1`);
    const firstRow = await sheetsRequest('GET', `/values/${range}`);
    if (!firstRow.values || firstRow.values.length === 0) {
      await sheetsRequest('PUT', `/values/${range}?valueInputOption=RAW`, {
        range: `${title}!A1:Z1`,
        values: [header],
      });
    }
  }
  logger.info(`Google Sheets ready (tabs: ${MESSAGES_SHEET}, ${ERRORS_SHEET})`);
}

module.exports = { logMessage, logError, ensureSheetsExist };

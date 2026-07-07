/**
 * config.js — single place that loads environment variables (.env)
 * and the editable config files (faq.md, system prompt, keyword lists,
 * recipients). Nothing else in the codebase reads process.env or the
 * config files directly.
 *
 * Editable files are re-read at most every CONFIG_RELOAD_MS, so edits
 * made on a running server are picked up without a restart (and a
 * GitHub edit + redeploy always picks them up).
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_RELOAD_MS = 60 * 1000; // re-read editable files at most once a minute

const env = {
  port: parseInt(process.env.PORT || '3000', 10),
  mockMode: process.env.MOCK_MODE === 'true',

  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',

  whatsappToken: process.env.WHATSAPP_TOKEN || '',
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',

  googleSheetId: process.env.GOOGLE_SHEET_ID || '',
  googleServiceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
  // .env files store the key with literal "\n" sequences; restore real newlines.
  googlePrivateKey: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),

  appsScriptUrl: process.env.APPS_SCRIPT_URL || '',
  appsScriptSecret: process.env.APPS_SCRIPT_SECRET || '',

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatIds: (process.env.TELEGRAM_CHAT_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),

  // "phone1:apikey1,phone2:apikey2"
  callmebotRecipients: (process.env.CALLMEBOT_RECIPIENTS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((pair) => {
      const [phone, apiKey] = pair.split(':').map((s) => s.trim());
      return { phone, apiKey };
    })
    .filter((r) => r.phone && r.apiKey),

  testEndpointEnabled: process.env.TEST_ENDPOINT_ENABLED === 'true',
};

// ---- editable-file loading with a small time-based cache ----

const cache = new Map(); // file -> { readAt, value }

function readCached(relPath, parser) {
  const now = Date.now();
  const hit = cache.get(relPath);
  if (hit && now - hit.readAt < CONFIG_RELOAD_MS) return hit.value;
  const raw = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const value = parser ? parser(raw) : raw;
  cache.set(relPath, { readAt: now, value });
  return value;
}

/** Full FAQ text — injected into the system prompt on every AI call. */
function getFaq() {
  return readCached('faq.md');
}

/** System prompt body (the part after the first `---` separator). */
function getSystemPrompt() {
  return readCached('config/system-prompt.md', (raw) => {
    const sep = raw.indexOf('\n---');
    if (sep === -1) return raw.trim();
    // skip past the '---' line itself
    return raw.slice(raw.indexOf('\n', sep + 2) + 1).trim();
  });
}

function getNegativeKeywords() {
  return readCached('config/negative-keywords.json', JSON.parse);
}

function getHandoverKeywords() {
  return readCached('config/handover-keywords.json', JSON.parse);
}

function getRecipients() {
  return readCached('config/recipients.json', JSON.parse);
}

/** Test hook: force re-reading all editable files on next access. */
function clearConfigCache() {
  cache.clear();
}

module.exports = {
  env,
  getFaq,
  getSystemPrompt,
  getNegativeKeywords,
  getHandoverKeywords,
  getRecipients,
  clearConfigCache,
};

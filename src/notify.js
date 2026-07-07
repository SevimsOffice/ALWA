/**
 * notify.js — staff notifications (handover alerts + error alerts).
 *
 * Channel priority:
 *   1. EMAIL (required): POST to a Google Apps Script web app, which
 *      sends the mail for free from the school's own Google account.
 *      No SMTP library, no paid mail service. See /apps-script.
 *   2. Telegram (optional, best-effort): a separate bot for internal
 *      alerts. Skipped silently if not configured/enabled.
 *   3. CallMeBot WhatsApp (optional, best-effort): a lightweight
 *      third-party notifier. Deliberately NOT the customer-facing
 *      WhatsApp Business number — internal alerts must never share the
 *      customer channel.
 *
 * Optional channels failing NEVER breaks the flow: failures are logged
 * and email remains the source of truth.
 */

const { env, getRecipients } = require('./config');
const logger = require('./logger');
const mocks = require('./mocks');

const NOTIFY_TIMEOUT_MS = 15_000;

// ---------- channel senders ----------

async function sendEmail(subject, body, extraRecipients = []) {
  const recipients = [
    ...new Set([...(getRecipients().emailRecipients || []), ...extraRecipients]),
  ].filter(Boolean);
  if (recipients.length === 0) throw new Error('No email recipients configured (config/recipients.json)');

  const payload = { secret: env.appsScriptSecret, recipients, subject, body };

  if (env.mockMode) {
    mocks.state.emails.push(payload);
    return;
  }
  if (!env.appsScriptUrl) throw new Error('APPS_SCRIPT_URL is not set');

  const res = await fetch(env.appsScriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    // Apps Script replies with a redirect; follow it.
    redirect: 'follow',
    signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Apps Script email webhook failed: ${res.status}`);
  }
}

async function sendTelegram(text, extraChatIds = []) {
  if (!env.telegramBotToken) return; // unconfigured -> silently skip
  const chatIds = [...new Set([...env.telegramChatIds, ...extraChatIds])].filter(Boolean);
  for (const chatId of chatIds) {
    if (env.mockMode) {
      mocks.state.telegrams.push({ chatId, text });
      continue;
    }
    const res = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Telegram send to ${chatId} failed: ${res.status}`);
  }
}

async function sendCallMeBot(text, extraRecipients = []) {
  const all = [...env.callmebotRecipients, ...extraRecipients]
    .filter((r) => r && r.phone && r.apiKey);
  for (const { phone, apiKey } of all) {
    if (env.mockMode) {
      mocks.state.callmebots.push({ phone, text });
      continue;
    }
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}` +
      `&apikey=${encodeURIComponent(apiKey)}&text=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`CallMeBot send to ${phone} failed: ${res.status}`);
  }
}

// ---------- high-level alerts ----------

/**
 * Send an alert through every enabled channel. Email errors are thrown
 * (the caller records them); optional-channel errors are only logged.
 *
 * @param {object} a
 * @param {string} a.subject
 * @param {string} a.body
 * @param {object[]} [a.staff]  matched staff entries (adds their personal
 *                              email/telegram/callmebot on top of the global lists)
 */
async function sendAlert({ subject, body, staff = [] }) {
  const channels = getRecipients().channels || { email: true };

  if (channels.email !== false) {
    await sendEmail(subject, body, staff.map((s) => s.email).filter(Boolean));
  }

  if (channels.telegram) {
    try {
      await sendTelegram(`${subject}\n\n${body}`, staff.map((s) => s.telegramChatId).filter(Boolean));
    } catch (err) {
      logger.fail('-', 'telegram alert (optional)', err.message);
    }
  }

  if (channels.callmebot) {
    try {
      await sendCallMeBot(
        `${subject} — ${body}`,
        staff.map((s) => ({ phone: s.callmebotPhone, apiKey: s.callmebotApiKey }))
      );
    } catch (err) {
      logger.fail('-', 'callmebot alert (optional)', err.message);
    }
  }
}

/** Staff entries whose topics include this topic (or '*'). */
function staffForTopic(topic) {
  return (getRecipients().staff || []).filter(
    (s) => (s.topics || []).includes('*') || (s.topics || []).includes(topic)
  );
}

/** "Customer wants a human" alert. */
async function sendHandoverAlert(phone, topic, lastMessage) {
  await sendAlert({
    subject: `📞 ALWA: customer ${phone} wants to be contacted (${topic})`,
    body:
      `Customer ${phone} wants to be contacted.\n` +
      `Topic: ${topic}\n` +
      `Last message: "${lastMessage}"\n\n` +
      `Full conversation: filter session_id = ${phone} in the messages sheet.`,
    staff: staffForTopic(topic),
  });
}

/** Critical-error alert (bot could not respond, etc.). */
async function sendErrorAlert(phone, step, message) {
  await sendAlert({
    subject: `🚨 ALWA error in step "${step}"`,
    body:
      `An error occurred.\n` +
      `Customer: ${phone || '-'}\n` +
      `Step: ${step}\n` +
      `Error: ${message}\n\n` +
      `See the "errors" tab of the logging sheet for history.`,
  });
}

module.exports = { sendAlert, sendHandoverAlert, sendErrorAlert, staffForTopic };

/**
 * whatsapp.js — sending replies via the WhatsApp Business Cloud API
 * (Meta Graph API). This module only SENDS; receiving happens through
 * the webhook in index.js.
 *
 * NOTE: this is the CUSTOMER-FACING number only. Internal staff alerts
 * deliberately do NOT go through here (see notify.js) so alert traffic
 * can never interfere with the customer channel.
 */

const { env } = require('./config');
const mocks = require('./mocks');

const GRAPH_VERSION = 'v20.0';
const SEND_TIMEOUT_MS = 15_000;

async function post(payload) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${env.whatsappPhoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.whatsappToken}`,
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WhatsApp send failed ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Send a plain-text WhatsApp message to a customer.
 * @param {string} to    recipient phone in international format, digits only (e.g. "905551112233")
 * @param {string} text  message body
 */
async function sendMessage(to, text) {
  if (env.mockMode) {
    mocks.state.sentWhatsapp.push({ to, text });
    return { mocked: true };
  }
  return post({ to, type: 'text', text: { body: text } });
}

/**
 * Send an interactive reply-button message (max 3 buttons, titles max
 * 20 chars — WhatsApp platform limits). Used for the clarification menu.
 * @param {string} to
 * @param {string} bodyText
 * @param {Array<{id: string, title: string}>} buttons
 */
async function sendButtons(to, bodyText, buttons) {
  if (env.mockMode) {
    mocks.state.sentWhatsapp.push({ to, text: bodyText, buttons });
    return { mocked: true };
  }
  return post({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  });
}

module.exports = { sendMessage, sendButtons };

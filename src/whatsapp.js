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

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${env.whatsappPhoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.whatsappToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WhatsApp send failed ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

module.exports = { sendMessage };

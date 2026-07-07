/**
 * handler.js — the main pipeline for one incoming customer message.
 *
 * Flow (every step is logged; every risky step is try/caught so one
 * failure never crashes the process or silently kills the reply):
 *
 *   message received
 *     └─ muted? -> log only, stop (customer asked us to stop)
 *     └─ intent detected (negative / handover / question)
 *          ├─ negative  -> one polite closing message, mute, log
 *          └─ otherwise -> sent to AI -> AI responded
 *                           -> reply sent to WhatsApp
 *                           -> logged to Sheet
 *                           -> handover? notify staff
 */

const { getNegativeKeywords } = require('./config');
const logger = require('./logger');
const memory = require('./memory');
const intentDetector = require('./intent');
const ai = require('./ai');
const whatsapp = require('./whatsapp');
const sheets = require('./sheets');
const notify = require('./notify');
const errorTracker = require('./errorTracker');

/** Pick the closing message in (roughly) the customer's language. */
function closingMessageFor(text) {
  const cfg = getNegativeKeywords();
  const msgs = cfg.closingMessage || {};
  // crude heuristic: Turkish characters or common Turkish words -> Turkish
  const looksTurkish = /[çğıöşü]|(\b(merhaba|fiyat|istemiyorum|yazma|kurs)\b)/i.test(text || '');
  return (looksTurkish ? msgs.tr : msgs.en) || msgs.tr || msgs.en ||
    'Thank you, have a great day!';
}

/**
 * Handle one incoming customer message end-to-end.
 * Never throws — all failures are recorded via errorTracker.
 *
 * @param {object} msg
 * @param {string} msg.from  customer phone number (session ID)
 * @param {string} msg.text  message body
 * @returns {Promise<{reply: string|null, intent: string, needsHuman: boolean}>}
 */
async function handleIncomingMessage({ from, text }) {
  const phone = from;
  logger.step(phone, 'message received', `"${text}"`);

  // --- 0. Customer previously asked us to stop -> stay silent, log only.
  if (memory.isMuted(phone)) {
    logger.step(phone, 'session muted', 'customer opted out earlier — not replying');
    try {
      await sheets.logMessage({
        sessionId: phone, direction: 'incoming', senderPhone: phone,
        messageText: text, detectedIntent: 'muted', status: 'muted',
      });
    } catch (err) {
      await errorTracker.record({ step: 'Sheet', phone, error: err });
    }
    return { reply: null, intent: 'muted', needsHuman: false };
  }

  // --- 1. Intent detection (pure keyword matching; can't really fail,
  //        but guard anyway so a bad regex in a config edit can't kill the bot).
  let intent = { intent: 'question' };
  try {
    intent = intentDetector.detectIntent(text);
    logger.step(phone, 'intent detected', intent.intent + (intent.matched ? ` (matched: "${intent.matched}")` : ''));
  } catch (err) {
    await errorTracker.record({ step: 'intent', phone, error: err });
  }

  const needsHuman = intent.intent === 'handover';

  // --- 2. Negative/stop message: one polite goodbye, then silence.
  if (intent.intent === 'negative') {
    const closing = closingMessageFor(text);
    memory.mute(phone, getNegativeKeywords().muteHours || 72);

    try {
      await whatsapp.sendMessage(phone, closing);
      logger.step(phone, 'reply sent to WhatsApp', '(polite closing, conversation ended)');
    } catch (err) {
      await errorTracker.record({ step: 'WhatsApp', phone, error: err, severity: 'critical' });
    }
    try {
      await sheets.logMessage({
        sessionId: phone, direction: 'incoming', senderPhone: phone,
        messageText: text, aiResponse: closing,
        detectedIntent: 'negative', status: 'closed-politely',
      });
      await sheets.logMessage({
        sessionId: phone, direction: 'outgoing', senderPhone: 'bot',
        messageText: closing, detectedIntent: 'negative', status: 'closed-politely',
      });
      logger.step(phone, 'logged to Sheet');
    } catch (err) {
      await errorTracker.record({ step: 'Sheet', phone, error: err });
    }
    return { reply: closing, intent: 'negative', needsHuman: false };
  }

  // --- 3. Ask the AI (with this customer's own conversation memory).
  let reply = null;
  let status = 'ok';
  try {
    logger.step(phone, 'sent to AI');
    const t0 = Date.now();
    reply = await ai.getAiReply(phone, memory.getHistory(phone), text);
    logger.step(phone, 'AI responded', `(${((Date.now() - t0) / 1000).toFixed(1)}s) "${reply}"`);
    memory.addMessage(phone, 'user', text);
    memory.addMessage(phone, 'assistant', reply);
  } catch (err) {
    status = 'ai_failed';
    // The bot can't answer at all -> critical, wake somebody up.
    await errorTracker.record({ step: 'AI', phone, error: err, severity: 'critical' });
    // Graceful fallback so the customer isn't left on read.
    reply = 'Şu anda küçük bir teknik sorun yaşıyoruz 🙏 En kısa sürede bir arkadaşımız size buradan dönecek. / We are having a small technical issue — a team member will get back to you here shortly.';
  }

  // --- 4. Send the reply to the customer.
  try {
    await whatsapp.sendMessage(phone, reply);
    logger.step(phone, 'reply sent to WhatsApp');
  } catch (err) {
    status = status === 'ok' ? 'send_failed' : status;
    await errorTracker.record({ step: 'WhatsApp', phone, error: err, severity: 'critical' });
  }

  // --- 5. Log both messages to the Sheet.
  try {
    await sheets.logMessage({
      sessionId: phone, direction: 'incoming', senderPhone: phone,
      messageText: text, aiResponse: reply,
      detectedIntent: intent.intent, needsHuman, status,
    });
    await sheets.logMessage({
      sessionId: phone, direction: 'outgoing', senderPhone: 'bot',
      messageText: reply, detectedIntent: intent.intent, needsHuman, status,
    });
    logger.step(phone, 'logged to Sheet');
  } catch (err) {
    await errorTracker.record({ step: 'Sheet', phone, error: err });
  }

  // --- 6. Handover: notify the right staff.
  if (needsHuman) {
    try {
      await notify.sendHandoverAlert(phone, intent.topic || 'sales', text);
      logger.step(phone, 'handover triggered', `staff notified (topic: ${intent.topic || 'sales'})`);
    } catch (err) {
      // Staff missing a lead is critical for the business.
      await errorTracker.record({ step: 'handover', phone, error: err, severity: 'critical' });
    }
  }

  return { reply, intent: intent.intent, needsHuman };
}

module.exports = { handleIncomingMessage };

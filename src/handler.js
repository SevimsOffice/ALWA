/**
 * handler.js — the ROUTER: the main pipeline for one incoming message.
 *
 * Three layers, per the target architecture:
 *
 *   Layer 1 — IDENTITY (first second):
 *     phone number looked up in Supabase `students` → registered
 *     student/parent (support mode) vs unknown number (sales mode).
 *     Survey button replies (template context ID) split off here and
 *     never enter the sales/complaint flow.
 *
 *   Layer 2 — INTENT (per message, not per conversation):
 *     keyword pre-filter (negative/stop, handover fast-path), then the
 *     AI returns { reply, intent, confidence, wants_human } in one
 *     call. Low confidence → clarification button menu.
 *
 *   Layer 3 — ACTION:
 *     sales/info → AI reply (+ lead row on handover)
 *     complaint  → complaints table row + staff alert + SLA confirmation
 *     human      → handover alert to staff
 *     Everything, whatever the intent, lands in the `conversations`
 *     table (and its Google Sheets mirror) for reporting.
 *
 * Every step is logged; every risky step is try/caught so one failure
 * never crashes the process or silently kills the reply.
 */

const { getNegativeKeywords, getIntents, getButtons } = require('./config');
const logger = require('./logger');
const memory = require('./memory');
const intentDetector = require('./intent');
const ai = require('./ai');
const whatsapp = require('./whatsapp');
const sheets = require('./sheets');
const db = require('./db');
const notify = require('./notify');
const complaints = require('./complaints');
const errorTracker = require('./errorTracker');

/** Log one message row to Supabase (primary) AND Sheets (mirror). */
async function logBoth(phone, m) {
  try {
    await db.logConversation(m);
  } catch (err) {
    await errorTracker.record({ step: 'Sheet', phone, error: new Error(`Supabase log: ${err.message}`) });
  }
  try {
    await sheets.logMessage(m);
  } catch (err) {
    await errorTracker.record({ step: 'Sheet', phone, error: err });
  }
}

/** Pick the closing message in (roughly) the customer's language. */
function closingMessageFor(text) {
  const cfg = getNegativeKeywords();
  const msgs = cfg.closingMessage || {};
  const looksTurkish = /[çğıöşü]|(\b(merhaba|fiyat|istemiyorum|yazma|kurs)\b)/i.test(text || '');
  return (looksTurkish ? msgs.tr : msgs.en) || msgs.tr || msgs.en ||
    'Thank you, have a great day!';
}

/**
 * Restart resilience: seed a fresh in-RAM session from the DB (last
 * messages + mute state derived from the last negative-intent row).
 */
async function hydrateFromDb(phone) {
  if (!memory.needsHydration(phone)) return;
  let history = [];
  let mutedUntil = 0;
  try {
    const rows = await db.getRecentConversations(phone, 10);
    history = rows
      .filter((r) => r.text)
      .map((r) => ({ role: r.direction === 'incoming' ? 'user' : 'assistant', content: r.text }));
    const lastNegative = [...rows].reverse()
      .find((r) => r.direction === 'incoming' && r.intent === 'negative');
    if (lastNegative) {
      const muteHours = getNegativeKeywords().muteHours || 72;
      mutedUntil = new Date(lastNegative.ts).getTime() + muteHours * 60 * 60 * 1000;
    }
  } catch (err) {
    await errorTracker.record({ step: 'message-receive', phone, error: new Error(`hydrate: ${err.message}`) });
  }
  memory.hydrate(phone, { history, mutedUntil });
}

/**
 * Handle one incoming customer message end-to-end. Never throws.
 *
 * @param {object} msg
 * @param {string} msg.from       customer phone number (session ID)
 * @param {string} msg.text       message body (or button title)
 * @param {string} [msg.buttonId]  set when the customer tapped a button
 * @param {string} [msg.contextId] WhatsApp id of the message the button belongs to
 * @returns {Promise<{reply: string|null, intent: string, needsHuman: boolean, customerType: string}>}
 */
async function handleIncomingMessage({ from, text, buttonId, contextId }) {
  const phone = from;
  logger.step(phone, 'message received', `"${text}"${buttonId ? ` [button: ${buttonId}]` : ''}`);

  // ============ SURVEY BRANCH ============
  // A button reply that is NOT our clarification menu is a survey/template
  // answer — it routes by its context ID, never through sales/complaints.
  if (buttonId && !buttonId.startsWith('menu:')) {
    return handleSurveyResponse({ phone, text, buttonId, contextId });
  }

  await hydrateFromDb(phone);

  // ---- Customer previously asked us to stop -> stay silent, log only.
  if (memory.isMuted(phone)) {
    logger.step(phone, 'session muted', 'customer opted out earlier — not replying');
    await logBoth(phone, {
      sessionId: phone, direction: 'incoming', senderPhone: phone,
      messageText: text, detectedIntent: 'muted', status: 'muted',
    });
    return { reply: null, intent: 'muted', needsHuman: false, customerType: 'unknown' };
  }

  // ============ LAYER 1 — IDENTITY ============
  let customerType = 'prospect';
  let student = null;
  try {
    student = await db.findStudent(phone);
    if (student) customerType = 'student';
    logger.step(phone, 'identity checked', customerType + (student?.name ? ` (${student.name})` : ''));
  } catch (err) {
    await errorTracker.record({ step: 'message-receive', phone, error: new Error(`identity: ${err.message}`) });
  }

  // ============ LAYER 2 — INTENT ============
  // 2a. keyword pre-filter (transparent, editable, instant)
  let keyword = { intent: 'question' };
  try {
    keyword = intentDetector.detectIntent(text);
    if (keyword.intent !== 'question') {
      logger.step(phone, 'intent detected', `${keyword.intent} (keyword: "${keyword.matched}")`);
    }
  } catch (err) {
    await errorTracker.record({ step: 'intent', phone, error: err });
  }

  // Negative/stop message: one polite goodbye, then silence. The AI is
  // never even asked to respond to abuse.
  if (keyword.intent === 'negative') {
    const closing = closingMessageFor(text);
    memory.mute(phone, getNegativeKeywords().muteHours || 72);
    try {
      await whatsapp.sendMessage(phone, closing);
      logger.step(phone, 'reply sent to WhatsApp', '(polite closing, conversation ended)');
    } catch (err) {
      await errorTracker.record({ step: 'WhatsApp', phone, error: err, severity: 'critical' });
    }
    await logBoth(phone, {
      sessionId: phone, direction: 'incoming', senderPhone: phone,
      messageText: text, aiResponse: closing,
      detectedIntent: 'negative', status: 'closed-politely',
    });
    await logBoth(phone, {
      sessionId: phone, direction: 'outgoing', senderPhone: 'bot',
      messageText: closing, detectedIntent: 'negative', status: 'closed-politely',
    });
    logger.step(phone, 'logged to Sheet');
    return { reply: closing, intent: 'negative', needsHuman: false, customerType };
  }

  // Menu button replies force the chosen intent with full confidence.
  const forcedIntent = buttonId?.startsWith('menu:') ? buttonId.slice('menu:'.length) : null;

  // 2b. the AI call: reply + intent in one shot, per message.
  let aiResult = null;
  let status = 'ok';
  try {
    logger.step(phone, 'sent to AI');
    const t0 = Date.now();
    aiResult = await ai.getAiReply(phone, memory.getHistory(phone), text, {
      customerType, studentName: student?.name,
    });
    if (forcedIntent) {
      aiResult.intent = forcedIntent;
      aiResult.confidence = 1;
    }
    logger.step(phone, 'AI responded',
      `(${((Date.now() - t0) / 1000).toFixed(1)}s) intent=${aiResult.intent} conf=${aiResult.confidence} "${aiResult.reply}"`);
    memory.addMessage(phone, 'user', text);
    memory.addMessage(phone, 'assistant', aiResult.reply);
  } catch (err) {
    status = 'ai_failed';
    await errorTracker.record({ step: 'AI', phone, error: err, severity: 'critical' });
    aiResult = {
      reply: 'Şu anda küçük bir teknik sorun yaşıyoruz 🙏 En kısa sürede bir arkadaşımız size buradan dönecek. / We are having a small technical issue — a team member will get back to you here shortly.',
      intent: 'diger', confidence: 1, wantsHuman: false,
    };
  }

  // Uncertain? Send the clarification button menu instead of guessing.
  const threshold = getIntents().confidenceThreshold ?? 0.55;
  if (status === 'ok' && !forcedIntent && keyword.intent === 'question'
      && aiResult.confidence < threshold) {
    const menu = getButtons();
    try {
      await whatsapp.sendButtons(phone, menu.menuBody, menu.buttons);
      logger.step(phone, 'clarification menu sent', `confidence ${aiResult.confidence} < ${threshold}`);
    } catch (err) {
      await errorTracker.record({ step: 'WhatsApp', phone, error: err, severity: 'critical' });
    }
    await logBoth(phone, {
      sessionId: phone, direction: 'incoming', senderPhone: phone,
      messageText: text, aiResponse: menu.menuBody,
      detectedIntent: 'belirsiz', status: 'menu_sent',
    });
    await logBoth(phone, {
      sessionId: phone, direction: 'outgoing', senderPhone: 'bot',
      messageText: menu.menuBody, detectedIntent: 'belirsiz', status: 'menu_sent',
    });
    return { reply: menu.menuBody, intent: 'belirsiz', needsHuman: false, customerType };
  }

  // Final intent: complaints always report as "sikayet"; an explicit
  // keyword hit wins over the AI's classification otherwise.
  const isComplaint = aiResult.intent === 'sikayet' || keyword.topic === 'complaints';
  const finalIntent = isComplaint ? 'sikayet'
    : keyword.intent === 'handover' ? 'handover' : aiResult.intent;
  const needsHuman = isComplaint || aiResult.wantsHuman
    || keyword.intent === 'handover' || aiResult.intent === 'insan';

  // ============ LAYER 3 — ACTION ============

  // 3a. send the AI reply
  try {
    await whatsapp.sendMessage(phone, aiResult.reply);
    logger.step(phone, 'reply sent to WhatsApp');
  } catch (err) {
    status = status === 'ok' ? 'send_failed' : status;
    await errorTracker.record({ step: 'WhatsApp', phone, error: err, severity: 'critical' });
  }

  // 3b. complaint: DB record + staff alert + SLA confirmation message
  let slaMessage = null;
  if (isComplaint) {
    try {
      slaMessage = await complaints.openComplaint({ phone, summary: text, customerType });
      await whatsapp.sendMessage(phone, slaMessage);
      logger.step(phone, 'handover triggered', 'complaint recorded, staff notified, SLA confirmation sent');
    } catch (err) {
      await errorTracker.record({ step: 'handover', phone, error: err, severity: 'critical' });
    }
  }

  // 3c. sales/human handover: staff alert + lead row
  if (needsHuman && !isComplaint) {
    const topic = keyword.topic || 'sales';
    try {
      await notify.sendHandoverAlert(phone, topic, text);
      logger.step(phone, 'handover triggered', `staff notified (topic: ${topic})`);
    } catch (err) {
      await errorTracker.record({ step: 'handover', phone, error: err, severity: 'critical' });
    }
    try {
      await db.insert('leads', {
        phone, name: student?.name || null, topic,
        last_message: String(text).slice(0, 500), status: 'new',
      });
      logger.step(phone, 'lead recorded');
    } catch (err) {
      await errorTracker.record({ step: 'handover', phone, error: new Error(`lead: ${err.message}`) });
    }
  }

  // 3d. log everything (incoming + outgoing) to DB + Sheets mirror
  await logBoth(phone, {
    sessionId: phone, direction: 'incoming', senderPhone: phone,
    messageText: text, aiResponse: aiResult.reply,
    detectedIntent: finalIntent, needsHuman, status,
  });
  await logBoth(phone, {
    sessionId: phone, direction: 'outgoing', senderPhone: 'bot',
    messageText: aiResult.reply, detectedIntent: finalIntent, needsHuman, status,
  });
  if (slaMessage) {
    await logBoth(phone, {
      sessionId: phone, direction: 'outgoing', senderPhone: 'bot',
      messageText: slaMessage, detectedIntent: finalIntent, needsHuman, status,
    });
  }
  logger.step(phone, 'logged to Sheet');

  return { reply: aiResult.reply, intent: finalIntent, needsHuman, customerType };
}

/** Survey/template button answers: record + thank, no AI involved. */
async function handleSurveyResponse({ phone, text, buttonId, contextId }) {
  logger.step(phone, 'survey response', `answer="${text}" survey=${contextId || buttonId}`);
  try {
    await db.insert('survey_responses', {
      phone, survey_id: contextId || buttonId, answer: String(text).slice(0, 500),
    });
  } catch (err) {
    await errorTracker.record({ step: 'Sheet', phone, error: new Error(`survey: ${err.message}`) });
  }
  const thanks = getButtons().surveyThanks || 'Teşekkürler! 🙏';
  try {
    await whatsapp.sendMessage(phone, thanks);
  } catch (err) {
    await errorTracker.record({ step: 'WhatsApp', phone, error: err });
  }
  await logBoth(phone, {
    sessionId: phone, direction: 'incoming', senderPhone: phone,
    messageText: text, aiResponse: thanks, detectedIntent: 'anket', status: 'survey',
  });
  return { reply: thanks, intent: 'anket', needsHuman: false, customerType: 'unknown' };
}

module.exports = { handleIncomingMessage };

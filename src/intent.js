/**
 * intent.js — keyword-based intent detection on the CUSTOMER's message.
 *
 * Two intents matter operationally:
 *   - "handover":  customer wants to enroll / be called / talk to a human
 *                  → flag needs_human, notify staff (config/handover-keywords.json)
 *   - "negative":  hostile / profanity / "stop messaging me"
 *                  → one polite closing message, then mute (config/negative-keywords.json)
 *
 * Everything else is "question" (answered by the AI from the FAQ).
 *
 * Matching is deliberately simple and transparent — the school edits
 * plain keyword lists on GitHub, no ML involved. Matching is
 * case-insensitive and Turkish-accent-insensitive (ş→s, ı→i, ...), so
 * "KAYIT", "kayıt" and "kayit" all match the same entry.
 */

const { getNegativeKeywords, getHandoverKeywords } = require('./config');

/** Lowercase + fold Turkish characters to ASCII so keyword lists stay simple. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ı/g, 'i').replace(/i̇/g, 'i')
    .replace(/ş/g, 's').replace(/ç/g, 'c')
    .replace(/ğ/g, 'g').replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip any remaining accents
    .replace(/\s+/g, ' ')
    .trim();
}

function containsWholeWord(haystack, word) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(word)}([^a-z0-9]|$)`).test(haystack);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Classify a customer message.
 * @returns {{ intent: 'negative'|'handover'|'question', topic?: string, matched?: string }}
 */
function detectIntent(text) {
  const msg = normalize(text);

  // Negative/stop takes priority — never keep selling to these messages.
  const neg = getNegativeKeywords();
  for (const phrase of neg.phrases || []) {
    if (msg.includes(normalize(phrase))) {
      return { intent: 'negative', matched: phrase };
    }
  }
  for (const word of neg.words || []) {
    if (containsWholeWord(msg, normalize(word))) {
      return { intent: 'negative', matched: word };
    }
  }

  const handover = getHandoverKeywords();
  for (const entry of handover.keywords || []) {
    if (msg.includes(normalize(entry.match))) {
      return { intent: 'handover', topic: entry.topic || 'sales', matched: entry.match };
    }
  }

  return { intent: 'question' };
}

module.exports = { detectIntent, normalize };

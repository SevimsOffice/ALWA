/**
 * ai.js — the OpenAI-powered agent (v2: reply + intent in ONE call).
 *
 * Design decisions (deliberate, see README):
 *  - NO vector database / RAG: the whole faq.md is injected into the
 *    system prompt on every request. Knowledge updates = edit one file.
 *  - NO separate classifier call: the model returns a strict-JSON
 *    object { reply, intent, confidence, wants_human } via structured
 *    outputs, so intent classification costs zero extra tokens and is
 *    evaluated PER MESSAGE — a complaint in the middle of a sales chat
 *    is caught immediately.
 *  - Identity-aware: the caller passes customerType (registered
 *    student/parent vs unknown prospect) and the system prompt adapts.
 *
 * Conversation memory is passed in per phone number (see memory.js).
 */

const { env, getFaq, getSystemPrompt, getIntents } = require('./config');
const mocks = require('./mocks');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const AI_TIMEOUT_MS = 30_000;
const MAX_REPLY_TOKENS = 500;

function buildSystemMessage(customerType, studentName) {
  const intents = getIntents().intents || [];
  const intentList = intents.map((i) => `- "${i.id}": ${i.description}`).join('\n');

  const identityNote = customerType === 'student'
    ? `Bu kişi kayıtlı bir öğrenci/veli/müşteri${studentName ? ` (adı: ${studentName})` : ''}. ` +
      'Destek ve şikayet moduna öncelik ver; satış konuşması yapma, sorununu çözmeye odaklan.'
    : 'Bu numara kayıtlı listede yok — büyük ihtimalle potansiyel bir müşteri. ' +
      'Yardımcı ve bilgilendirici ol; satış modunda ama asla baskıcı değil.';

  return [
    getSystemPrompt(),
    '',
    '## Müşteri bağlamı',
    identityNote,
    '',
    '## Çıktı formatı (zorunlu)',
    'Her cevabında şu alanları doldur:',
    '- reply: müşteriye gidecek mesaj metni (kurallarına uygun, kısa ve doğal)',
    '- intent: müşterinin SON mesajının niyeti. Seçenekler:',
    intentList,
    '- confidence: niyet tahminine güvenin (0-1). Mesaj belirsizse düşük ver.',
    '- wants_human: müşteri bir insanla görüşmek/aranmak/kaydolmak istiyorsa VEYA ciddi bir şikayet bildiriyorsa true.',
    '',
    '=== BİLGİ TABANI (FAQ) — tek gerçek kaynağın ===',
    getFaq(),
  ].join('\n');
}

function responseSchema() {
  const ids = (getIntents().intents || []).map((i) => i.id);
  return {
    type: 'json_schema',
    json_schema: {
      name: 'alwa_reply',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['reply', 'intent', 'confidence', 'wants_human'],
        properties: {
          reply: { type: 'string' },
          intent: { type: 'string', enum: ids.length ? ids : ['diger'] },
          confidence: { type: 'number' },
          wants_human: { type: 'boolean' },
        },
      },
    },
  };
}

/**
 * Ask the AI for a reply + intent classification.
 * @param {string} phone
 * @param {Array<{role, content}>} history  this customer's prior turns
 * @param {string} userText
 * @param {object} [opts]  { customerType: 'student'|'prospect', studentName }
 * @returns {Promise<{reply: string, intent: string, confidence: number, wantsHuman: boolean}>}
 */
async function getAiReply(phone, history, userText, opts = {}) {
  const messages = [
    { role: 'system', content: buildSystemMessage(opts.customerType || 'prospect', opts.studentName) },
    ...history,
    { role: 'user', content: userText },
  ];

  if (env.mockMode) {
    mocks.state.aiCalls.push({ phone, messages });
    const r = mocks.mockAiReply(userText);
    return { reply: r.reply, intent: r.intent, confidence: r.confidence, wantsHuman: r.wants_human };
  }

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: env.openaiModel,
      messages,
      max_tokens: MAX_REPLY_TOKENS,
      temperature: 0.7,
      response_format: responseSchema(),
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('OpenAI returned an empty reply');

  // Parse the structured output; if a model ever returns plain text
  // (e.g. a model without json_schema support), degrade gracefully to
  // "just a reply" instead of failing the customer.
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed.reply !== 'string' || !parsed.reply) throw new Error('missing reply field');
    return {
      reply: parsed.reply,
      intent: parsed.intent || 'diger',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 1,
      wantsHuman: Boolean(parsed.wants_human),
    };
  } catch {
    return { reply: content, intent: 'diger', confidence: 1, wantsHuman: false };
  }
}

module.exports = { getAiReply };

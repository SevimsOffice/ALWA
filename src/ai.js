/**
 * ai.js — the OpenAI-powered agent.
 *
 * Design decision (deliberate, see README): NO vector database / RAG.
 * The FAQ is small, so the ENTIRE faq.md is injected into the system
 * prompt on every request. The model handles paraphrases ("how much",
 * "fiyat", "ne kadar") natively, and the school can update knowledge by
 * editing one Markdown file on GitHub.
 *
 * Conversation memory is passed in per phone number (see memory.js),
 * so the model remembers earlier messages of the SAME customer only.
 */

const { env, getFaq, getSystemPrompt } = require('./config');
const mocks = require('./mocks');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const AI_TIMEOUT_MS = 30_000;
const MAX_REPLY_TOKENS = 400; // WhatsApp answers should be short anyway

function buildSystemMessage() {
  return [
    getSystemPrompt(),
    '',
    '=== SCHOOL KNOWLEDGE BASE (FAQ) — your ONLY source of facts ===',
    getFaq(),
  ].join('\n');
}

/**
 * Ask the AI for a reply.
 * @param {string} phone   customer phone (used only for mock bookkeeping/logs)
 * @param {Array<{role:string, content:string}>} history  this customer's prior turns
 * @param {string} userText  the new incoming message
 * @returns {Promise<string>} the assistant's reply text
 */
async function getAiReply(phone, history, userText) {
  const messages = [
    { role: 'system', content: buildSystemMessage() },
    ...history,
    { role: 'user', content: userText },
  ];

  if (env.mockMode) {
    mocks.state.aiCalls.push({ phone, messages });
    return mocks.mockAiReply(userText);
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
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error('OpenAI returned an empty reply');
  return reply;
}

module.exports = { getAiReply };

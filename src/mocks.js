/**
 * mocks.js — in-memory stand-ins for every external service, used when
 * MOCK_MODE=true. Lets you (and the test suite) run the full message
 * flow locally with zero credentials: no OpenAI, no Meta, no Google.
 *
 * Each module (ai, whatsapp, sheets, notify) checks env.mockMode and
 * delegates here instead of calling the real API. Everything that
 * "happened" is recorded so tests can assert on it and you can inspect
 * it via GET /mock-state while running `npm run mock`.
 */

const state = {
  sentWhatsapp: [],   // { to, text }
  sheetRows: [],      // { sheet: 'messages'|'errors', row: [...] }
  emails: [],         // payloads POSTed to the (mock) Apps Script
  telegrams: [],      // { chatId, text }
  callmebots: [],     // { phone, text }
  aiCalls: [],        // { phone, messages }
};

/** Deterministic fake AI reply so the flow is testable offline. */
function mockAiReply(userText) {
  const t = (userText || '').toLowerCase();
  if (t.includes('price') || t.includes('fiyat') || t.includes('kaç para') || t.includes('ne kadar')) {
    return 'General English kuru bir seviye için 14.900 TL 🙂 Taksit imkânımız da var. Başka merak ettiğiniz bir şey var mı? [MOCK]';
  }
  return `Merhaba! Size nasıl yardımcı olabilirim? (mock reply to: "${String(userText).slice(0, 60)}") [MOCK]`;
}

function reset() {
  for (const key of Object.keys(state)) state[key].length = 0;
}

module.exports = { state, mockAiReply, reset };

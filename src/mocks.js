/**
 * mocks.js — in-memory stand-ins for every external service, used when
 * MOCK_MODE=true. Lets you (and the test suite) run the full message
 * flow locally with zero credentials: no OpenAI, no Meta, no Google,
 * no Supabase.
 *
 * Each module (ai, whatsapp, sheets, notify, db) checks env.mockMode
 * and delegates here instead of calling the real API. Everything that
 * "happened" is recorded so tests can assert on it and you can inspect
 * it via GET /mock-state while running `npm run mock`.
 */

const state = {
  sentWhatsapp: [],   // { to, text, buttons? }
  sheetRows: [],      // { sheet: 'messages'|'errors', row: [...] }
  dbRows: [],         // { table, row } — the mock Supabase
  students: [],       // mock students table for identity lookups
  emails: [],         // payloads POSTed to the (mock) Apps Script
  telegrams: [],      // { chatId, text }
  callmebots: [],     // { phone, text }
  aiCalls: [],        // { phone, messages }
};

/**
 * Deterministic fake AI result (same shape the real structured-output
 * call returns) so the whole router is testable offline:
 *   - price words        -> intent "fiyat"
 *   - complaint phrasing -> intent "sikayet" + wants_human
 *   - human/agent words  -> intent "insan" + wants_human
 *   - "???"              -> low confidence (triggers the button menu)
 */
function mockAiReply(userText) {
  const t = String(userText || '')
    .toLowerCase()
    .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ç/g, 'c')
    .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o');

  if (t.includes('???')) {
    return { reply: 'Tam anlayamadım 🙂 [MOCK]', intent: 'diger', confidence: 0.2, wants_human: false };
  }
  if (t.includes('memnun kalmad') || t.includes('sikayet') || t.includes('complaint') || t.includes('iade')) {
    return {
      reply: 'Bunu duyduğuma çok üzüldüm, hemen ilgileniyoruz. [MOCK]',
      intent: 'sikayet', confidence: 0.9, wants_human: true,
    };
  }
  if (t.includes('temsilci') || t.includes('insanla') || t.includes('human')) {
    return { reply: 'Tabii, sizi hemen bir arkadaşımıza aktarıyorum. [MOCK]', intent: 'insan', confidence: 0.9, wants_human: true };
  }
  if (t.includes('price') || t.includes('fiyat') || t.includes('kac para') || t.includes('ne kadar')) {
    return {
      reply: 'Fiyatlar ihtiyaca göre değişiyor; kısa bir görüşmeyle net teklif çıkarıyoruz 🙂 [MOCK]',
      intent: 'fiyat', confidence: 0.95, wants_human: false,
    };
  }
  return {
    reply: `Merhaba! Size nasıl yardımcı olabilirim? (mock reply to: "${String(userText).slice(0, 60)}") [MOCK]`,
    intent: 'diger', confidence: 0.9, wants_human: false,
  };
}

function reset() {
  for (const key of Object.keys(state)) state[key].length = 0;
}

module.exports = { state, mockAiReply, reset };

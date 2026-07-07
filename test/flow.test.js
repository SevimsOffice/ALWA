/**
 * flow.test.js — end-to-end tests of the message pipeline in MOCK_MODE.
 * No live APIs are touched. Run with: npm test
 */

process.env.MOCK_MODE = 'true';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const mocks = require('../src/mocks');
const memory = require('../src/memory');
const handler = require('../src/handler');
const { detectIntent, normalize } = require('../src/intent');
const { extractTextMessages } = require('../src/index');
const errorTracker = require('../src/errorTracker');

beforeEach(() => {
  mocks.reset();
  memory.resetAll();
});

// ---------- basic Q&A flow ----------

test('a normal question gets an AI reply, a WhatsApp send, and two sheet rows', async () => {
  const result = await handler.handleIncomingMessage({
    from: '905551112233',
    text: 'Kurs fiyatları ne kadar?',
  });

  assert.ok(result.reply, 'should produce a reply');
  assert.strictEqual(result.intent, 'question');
  assert.strictEqual(result.needsHuman, false);

  // reply actually "sent" on WhatsApp
  assert.strictEqual(mocks.state.sentWhatsapp.length, 1);
  assert.strictEqual(mocks.state.sentWhatsapp[0].to, '905551112233');
  assert.strictEqual(mocks.state.sentWhatsapp[0].text, result.reply);

  // one incoming + one outgoing row in the messages sheet
  const rows = mocks.state.sheetRows.filter((r) => r.sheet === 'messages');
  assert.strictEqual(rows.length, 2);
  const [incoming, outgoing] = rows.map((r) => r.row);
  assert.strictEqual(incoming[1], '905551112233'); // session_id
  assert.strictEqual(incoming[2], 'incoming');
  assert.strictEqual(incoming[4], 'Kurs fiyatları ne kadar?');
  assert.strictEqual(outgoing[2], 'outgoing');
  assert.strictEqual(outgoing[3], 'bot');

  // no staff alert for a plain question
  assert.strictEqual(mocks.state.emails.length, 0);
});

test('conversation memory is scoped per phone number', async () => {
  await handler.handleIncomingMessage({ from: '905551111111', text: 'Merhaba' });
  await handler.handleIncomingMessage({ from: '905551111111', text: 'Fiyat ne kadar?' });
  await handler.handleIncomingMessage({ from: '905552222222', text: 'Hello' });

  // customer 1's second AI call must contain their first exchange...
  const call2 = mocks.state.aiCalls[1];
  const historyTexts = call2.messages.map((m) => m.content).join('\n');
  assert.ok(historyTexts.includes('Merhaba'), 'history should include earlier message');

  // ...and customer 2's call must NOT contain customer 1's messages
  const call3 = mocks.state.aiCalls[2];
  const otherTexts = call3.messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n');
  assert.ok(!otherTexts.includes('Merhaba'), 'sessions must not leak between phone numbers');
});

test('the FAQ content is injected into the system prompt', async () => {
  await handler.handleIncomingMessage({ from: '905551112233', text: 'test' });
  const systemMsg = mocks.state.aiCalls[0].messages[0];
  assert.strictEqual(systemMsg.role, 'system');
  assert.ok(systemMsg.content.includes('American Life'), 'system prompt present');
  assert.ok(systemMsg.content.includes('14.900 TL'), 'FAQ content injected');
});

// ---------- handover ----------

test('enrollment intent flags needs_human and notifies staff', async () => {
  const result = await handler.handleIncomingMessage({
    from: '905553334455',
    text: 'Kayıt olmak istiyorum, beni arayın lütfen',
  });

  assert.strictEqual(result.needsHuman, true);
  assert.strictEqual(result.intent, 'handover');

  // sheet row flagged
  const incoming = mocks.state.sheetRows.find(
    (r) => r.sheet === 'messages' && r.row[2] === 'incoming'
  );
  assert.strictEqual(incoming.row[7], 'yes', 'needs_human column must be yes');

  // email alert fired, mentioning the phone and the message
  assert.strictEqual(mocks.state.emails.length, 1);
  const email = mocks.state.emails[0];
  assert.ok(email.subject.includes('905553334455'));
  assert.ok(email.body.includes('Kayıt olmak istiyorum'));
  assert.ok(email.recipients.length > 0);

  // the customer still got a normal reply
  assert.strictEqual(mocks.state.sentWhatsapp.length, 1);
});

test('handover works with English keywords too', async () => {
  const result = await handler.handleIncomingMessage({
    from: '905550001122',
    text: 'I want to enroll in the English course',
  });
  assert.strictEqual(result.needsHuman, true);
  assert.strictEqual(mocks.state.emails.length, 1);
});

// ---------- negative / stop handling ----------

test('a stop message gets ONE polite closing and mutes the customer', async () => {
  const first = await handler.handleIncomingMessage({
    from: '905556667788',
    text: 'İlgilenmiyorum, bir daha yazmayın',
  });

  assert.strictEqual(first.intent, 'negative');
  assert.strictEqual(mocks.state.sentWhatsapp.length, 1, 'exactly one closing message');
  const closing = mocks.state.sentWhatsapp[0].text;
  assert.ok(closing.length > 0);

  // a follow-up message must get NO reply (muted) but still be logged
  mocks.reset();
  const second = await handler.handleIncomingMessage({
    from: '905556667788',
    text: 'hâlâ orada mısınız',
  });
  assert.strictEqual(second.reply, null);
  assert.strictEqual(mocks.state.sentWhatsapp.length, 0, 'no reply while muted');
  const mutedRow = mocks.state.sheetRows.find((r) => r.sheet === 'messages');
  assert.ok(mutedRow, 'muted messages are still logged');
  assert.strictEqual(mutedRow.row[8], 'muted');

  // no AI call, no sales pitch, no staff alert
  assert.strictEqual(mocks.state.aiCalls.length, 0);
  assert.strictEqual(mocks.state.emails.length, 0);
});

test('profanity triggers the polite close, not an argument', async () => {
  const result = await handler.handleIncomingMessage({
    from: '905559990000',
    text: 'siktir git basımdan',
  });
  assert.strictEqual(result.intent, 'negative');
  assert.strictEqual(mocks.state.aiCalls.length, 0, 'AI must not be asked to respond to abuse');
});

// ---------- intent unit tests ----------

test('intent matching is case- and Turkish-accent-insensitive', () => {
  assert.strictEqual(detectIntent('KAYIT OLMAK istiyorum').intent, 'handover');
  assert.strictEqual(detectIntent('kayıt olmak istiyorum').intent, 'handover');
  assert.strictEqual(detectIntent('İLGİLENMİYORUM').intent, 'negative');
  assert.strictEqual(detectIntent('Fiyatlar nedir?').intent, 'question');
  assert.strictEqual(normalize('ŞÇĞÜÖİ'), 'scguoi');
});

test('whole-word matching: "mal" does not fire inside "maliyet"', () => {
  assert.strictEqual(detectIntent('maliyet nedir').intent, 'question');
  assert.strictEqual(detectIntent('complaint about the course').intent, 'handover');
  assert.strictEqual(detectIntent('complaint about the course').topic, 'complaints');
});

// ---------- webhook envelope parsing ----------

test('extractTextMessages parses the Meta webhook payload', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messages: [
            { id: 'wamid.1', from: '905551112233', type: 'text', text: { body: 'hello' } },
            { id: 'wamid.2', from: '905551112233', type: 'image' }, // ignored
          ],
        },
      }],
    }],
  };
  const msgs = extractTextMessages(payload);
  assert.strictEqual(msgs.length, 1);
  assert.deepStrictEqual(msgs[0], { id: 'wamid.1', from: '905551112233', text: 'hello' });

  // status-only payloads and foreign objects produce nothing
  assert.strictEqual(extractTextMessages({ object: 'something_else' }).length, 0);
  assert.strictEqual(extractTextMessages({}).length, 0);
});

// ---------- error tracking ----------

test('errorTracker writes to the errors sheet, and criticals send an email', async () => {
  await errorTracker.record({
    step: 'AI', phone: '905551112233',
    error: new Error('model exploded'), severity: 'critical',
  });

  const errRow = mocks.state.sheetRows.find((r) => r.sheet === 'errors');
  assert.ok(errRow, 'error row written');
  assert.strictEqual(errRow.row[1], '905551112233');
  assert.strictEqual(errRow.row[2], 'AI');
  assert.ok(errRow.row[3].includes('model exploded'));
  assert.strictEqual(errRow.row[4], 'critical');

  assert.strictEqual(mocks.state.emails.length, 1, 'critical error emails staff');
  assert.ok(mocks.state.emails[0].subject.includes('error'));
});

test('non-critical errors go to the sheet but do not email anyone', async () => {
  await errorTracker.record({ step: 'Sheet', phone: 'x', error: 'minor hiccup' });
  assert.ok(mocks.state.sheetRows.some((r) => r.sheet === 'errors'));
  assert.strictEqual(mocks.state.emails.length, 0);
});

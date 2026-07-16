/**
 * v2.test.js — router architecture tests: identity layer, AI intent
 * classification, button menu, complaint module, leads, surveys,
 * DB-backed memory hydration, and reporting. All in MOCK_MODE.
 */

process.env.MOCK_MODE = 'true';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const mocks = require('../src/mocks');
const memory = require('../src/memory');
const handler = require('../src/handler');
const report = require('../src/report');
const complaints = require('../src/complaints');
const { extractTextMessages } = require('../src/index');

beforeEach(() => {
  mocks.reset();
  memory.resetAll();
});

function dbRows(table) {
  return mocks.state.dbRows.filter((r) => r.table === table).map((r) => r.row);
}

// ---------- Layer 1: identity ----------

test('a registered student is recognized and the AI is told', async () => {
  mocks.state.students.push({ phone: '905551112233', name: 'Ali Veli' });

  const result = await handler.handleIncomingMessage({
    from: '905551112233', text: 'Merhaba',
  });

  assert.strictEqual(result.customerType, 'student');
  const systemMsg = mocks.state.aiCalls[0].messages[0].content;
  assert.ok(systemMsg.includes('kayıtlı bir öğrenci'), 'support-mode note in prompt');
  assert.ok(systemMsg.includes('Ali Veli'), 'student name passed to AI');
});

test('an unknown number is treated as a prospect (sales mode)', async () => {
  const result = await handler.handleIncomingMessage({
    from: '905559998877', text: 'Merhaba',
  });
  assert.strictEqual(result.customerType, 'prospect');
  const systemMsg = mocks.state.aiCalls[0].messages[0].content;
  assert.ok(systemMsg.includes('potansiyel'), 'sales-mode note in prompt');
});

// ---------- Layer 2: AI classification ----------

test('a free-form complaint mid-conversation is caught without keywords', async () => {
  // start as a sales chat...
  await handler.handleIncomingMessage({ from: '905551110000', text: 'Fiyatlar ne kadar?' });
  mocks.state.emails.length = 0;

  // ...then the complaint appears (no keyword from the lists matches this)
  const result = await handler.handleIncomingMessage({
    from: '905551110000',
    text: 'Geçen dönem hizmetten hiç memnun kalmadık açıkçası',
  });

  assert.strictEqual(result.intent, 'sikayet');
  assert.strictEqual(result.needsHuman, true);

  // complaint record with a deadline
  const complaintRows = dbRows('complaints');
  assert.strictEqual(complaintRows.length, 1);
  assert.strictEqual(complaintRows[0].status, 'open');
  assert.ok(complaintRows[0].deadline > new Date().toISOString(), 'deadline in the future');

  // staff alerted
  assert.strictEqual(mocks.state.emails.length, 1);
  assert.ok(mocks.state.emails[0].subject.includes('şikayet'));

  // customer got the AI empathy reply AND the SLA confirmation
  const sent = mocks.state.sentWhatsapp.filter((m) => m.to === '905551110000');
  assert.strictEqual(sent.length, 3); // fiyat reply + complaint reply + SLA confirmation
  assert.ok(sent[2].text.includes('24 saat'), 'SLA hours in confirmation');
});

test('low AI confidence sends the clarification button menu', async () => {
  const result = await handler.handleIncomingMessage({
    from: '905552221100', text: 'asdf ???',
  });

  assert.strictEqual(result.intent, 'belirsiz');
  const sent = mocks.state.sentWhatsapp[0];
  assert.ok(Array.isArray(sent.buttons), 'an interactive message was sent');
  assert.strictEqual(sent.buttons.length, 3);
  assert.ok(sent.buttons.every((b) => b.id.startsWith('menu:')));

  const convo = dbRows('conversations').find((r) => r.direction === 'incoming');
  assert.strictEqual(convo.status, 'menu_sent');
});

test('a menu button tap forces that intent (no second menu loop)', async () => {
  const result = await handler.handleIncomingMessage({
    from: '905552221100',
    text: '📚 Eğitim bilgisi',
    buttonId: 'menu:kurs_bilgisi',
    contextId: 'wamid.menu.1',
  });

  assert.strictEqual(result.intent, 'kurs_bilgisi');
  assert.strictEqual(mocks.state.aiCalls.length, 1, 'AI answers the chosen topic');
  assert.ok(!mocks.state.sentWhatsapp.some((m) => m.buttons), 'no menu re-sent');
});

// ---------- Layer 3: actions ----------

test('sales handover records a lead', async () => {
  await handler.handleIncomingMessage({
    from: '905553334455', text: 'I want to enroll, call me',
  });

  const leads = dbRows('leads');
  assert.strictEqual(leads.length, 1);
  assert.strictEqual(leads[0].phone, '905553334455');
  assert.strictEqual(leads[0].topic, 'sales');
  assert.strictEqual(leads[0].status, 'new');
  assert.strictEqual(mocks.state.emails.length, 1, 'staff alerted');
});

test('survey button replies are recorded and never enter the sales flow', async () => {
  const result = await handler.handleIncomingMessage({
    from: '905554443322',
    text: 'Çok memnunum',
    buttonId: 'CSAT_5',
    contextId: 'wamid.survey.42',
  });

  assert.strictEqual(result.intent, 'anket');
  const responses = dbRows('survey_responses');
  assert.strictEqual(responses.length, 1);
  assert.strictEqual(responses[0].survey_id, 'wamid.survey.42');
  assert.strictEqual(responses[0].answer, 'Çok memnunum');

  assert.strictEqual(mocks.state.aiCalls.length, 0, 'AI not involved');
  assert.ok(mocks.state.sentWhatsapp[0].text.includes('Teşekkür'), 'thank-you sent');
});

test('overdue open complaints trigger one reminder email each', async () => {
  mocks.state.dbRows.push({
    table: 'complaints',
    row: {
      id: 99, phone: '905550001111', summary: 'test şikayet',
      deadline: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h overdue
      status: 'open', reminder_sent: false, ts: new Date().toISOString(),
    },
  });

  await complaints.checkOverdue();
  assert.strictEqual(mocks.state.emails.length, 1);
  assert.ok(mocks.state.emails[0].subject.includes('SLA'));

  // second run: reminder_sent is now true -> no duplicate email
  await complaints.checkOverdue();
  assert.strictEqual(mocks.state.emails.length, 1);
});

// ---------- restart resilience (DB-backed memory) ----------

test('conversation memory survives a "restart" via DB hydration', async () => {
  await handler.handleIncomingMessage({ from: '905556660000', text: 'Merhaba, ben Ayşe' });

  memory.resetAll(); // simulate a redeploy: RAM gone, DB rows remain

  await handler.handleIncomingMessage({ from: '905556660000', text: 'Fiyat ne kadar?' });
  const secondCall = mocks.state.aiCalls[1];
  const historyText = secondCall.messages.filter((m) => m.role !== 'system')
    .map((m) => m.content).join('\n');
  assert.ok(historyText.includes('Merhaba, ben Ayşe'), 'history reloaded from DB');
});

test('mute state survives a "restart" via DB hydration', async () => {
  await handler.handleIncomingMessage({ from: '905557770000', text: 'İlgilenmiyorum, yazmayın' });
  memory.resetAll();
  mocks.state.sentWhatsapp.length = 0;

  const result = await handler.handleIncomingMessage({ from: '905557770000', text: 'test' });
  assert.strictEqual(result.reply, null, 'still muted after restart');
  assert.strictEqual(mocks.state.sentWhatsapp.length, 0);
});

// ---------- webhook parsing of interactive messages ----------

test('extractTextMessages handles interactive and template button replies', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messages: [
            {
              id: 'wamid.1', from: '90555', type: 'interactive',
              context: { id: 'wamid.menu' },
              interactive: { type: 'button_reply', button_reply: { id: 'menu:sikayet', title: '📝 Şikayet / öneri' } },
            },
            {
              id: 'wamid.2', from: '90555', type: 'button',
              context: { id: 'wamid.survey' },
              button: { payload: 'CSAT_4', text: 'Memnunum' },
            },
          ],
        },
      }],
    }],
  };
  const msgs = extractTextMessages(payload);
  assert.strictEqual(msgs.length, 2);
  assert.deepStrictEqual(msgs[0], {
    id: 'wamid.1', from: '90555', text: '📝 Şikayet / öneri',
    buttonId: 'menu:sikayet', contextId: 'wamid.menu',
  });
  assert.deepStrictEqual(msgs[1], {
    id: 'wamid.2', from: '90555', text: 'Memnunum',
    buttonId: 'CSAT_4', contextId: 'wamid.survey',
  });
});

// ---------- reporting ----------

test('monthly report counts intents, customers and handovers', async () => {
  await handler.handleIncomingMessage({ from: '905551000001', text: 'Fiyat ne kadar?' });
  await handler.handleIncomingMessage({ from: '905551000002', text: 'Hiç memnun kalmadık' });
  await handler.handleIncomingMessage({ from: '905551000003', text: 'I want to enroll' });
  await handler.handleIncomingMessage({ from: '905551000001', text: 'Peki indirim var mı fiyatta?' });

  const month = new Date().toISOString().slice(0, 7);
  const r = await report.buildMonthlyReport(month);

  assert.strictEqual(r.month, month);
  assert.strictEqual(r.totalIncoming, 4);
  assert.strictEqual(r.uniqueCustomers, 3);
  assert.strictEqual(r.byIntent.fiyat, 2);
  assert.strictEqual(r.byIntent.sikayet, 1);
  assert.ok(r.handovers >= 2, 'complaint + enroll both count as handover');

  const text = report.formatReportText(r);
  assert.ok(text.includes('fiyat: 2'));
});

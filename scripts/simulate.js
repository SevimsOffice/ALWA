/**
 * simulate.js — post a fake Meta webhook payload to your local server,
 * exactly as WhatsApp would. Use it to test the real /webhook route.
 *
 * Usage (with `npm run mock` running in another terminal):
 *   node scripts/simulate.js "Kurs fiyatları ne kadar?"
 *   node scripts/simulate.js "I want to enroll" 905559998877
 *   node scripts/simulate.js --url http://localhost:3000 "call me please"
 */

const args = process.argv.slice(2);
let url = 'http://localhost:3000';
const urlIdx = args.indexOf('--url');
if (urlIdx !== -1) {
  url = args[urlIdx + 1];
  args.splice(urlIdx, 2);
}

const text = args[0] || 'Merhaba, kurs fiyatları ne kadar?';
const from = args[1] || '905551112233';

// This is the exact envelope shape Meta sends for an incoming text.
const payload = {
  object: 'whatsapp_business_account',
  entry: [{
    id: 'ENTRY_ID',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '905550000000', phone_number_id: 'PHONE_NUMBER_ID' },
        contacts: [{ profile: { name: 'Test Customer' }, wa_id: from }],
        messages: [{
          from,
          id: 'wamid.TEST.' + Date.now(),
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text',
          text: { body: text },
        }],
      },
    }],
  }],
};

(async () => {
  console.log(`POST ${url}/webhook  from=${from}  text="${text}"`);
  const res = await fetch(`${url}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  console.log(`Webhook responded: ${res.status} (processing is async — watch the server logs)`);
  console.log(`Tip: GET ${url}/mock-state shows what was "sent" in mock mode.`);
})().catch((err) => {
  console.error('Failed:', err.message);
  console.error('Is the server running? Start it with: npm run mock');
  process.exit(1);
});

/**
 * index.js — the Express webhook server.
 *
 * Endpoints:
 *   GET  /            liveness ping (used by Railway/Render health checks)
 *   GET  /health      health check with a bit of detail
 *   GET  /webhook     Meta webhook verification handshake
 *   POST /webhook     incoming WhatsApp messages
 *   POST /test-message  simulate an incoming message without WhatsApp
 *                       (enabled in MOCK_MODE or with TEST_ENDPOINT_ENABLED=true)
 *   GET  /mock-state  inspect everything the mocks recorded (MOCK_MODE only)
 */

const express = require('express');
const { env, getFaq, getSla } = require('./config');
const logger = require('./logger');
const handler = require('./handler');
const sheets = require('./sheets');
const complaints = require('./complaints');
const report = require('./report');
const notify = require('./notify');
const errorTracker = require('./errorTracker');
const mocks = require('./mocks');

const app = express();
app.use(express.json());

// Meta retries webhook deliveries; remember recent message IDs so a
// retry never produces a duplicate AI reply. (In-memory is fine: Meta's
// retry window is short.)
const seenMessageIds = new Set();
const SEEN_MAX = 5000;

function markSeen(id) {
  seenMessageIds.add(id);
  if (seenMessageIds.size > SEEN_MAX) {
    // drop the oldest half — Sets iterate in insertion order
    let i = 0;
    for (const v of seenMessageIds) {
      seenMessageIds.delete(v);
      if (++i >= SEEN_MAX / 2) break;
    }
  }
}

// ---------- health ----------

app.get('/', (_req, res) => res.send('ALWA is running'));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    mockMode: env.mockMode,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ---------- Meta webhook verification (GET) ----------
// Meta calls this once when you configure the webhook URL in the app
// dashboard. It must echo hub.challenge if the verify token matches.

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && token === env.whatsappVerifyToken) {
    logger.info('Webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  logger.fail('-', 'webhook verification', 'verify token mismatch');
  return res.sendStatus(403);
});

// ---------- incoming WhatsApp messages (POST) ----------

app.post('/webhook', (req, res) => {
  // Always ACK immediately — Meta expects a fast 200 and will retry
  // (and eventually disable the webhook) if we're slow. Actual work
  // happens asynchronously after the response.
  res.sendStatus(200);

  let messages = [];
  try {
    messages = extractTextMessages(req.body);
  } catch (err) {
    errorTracker.record({ step: 'message-receive', error: err });
    return;
  }

  for (const msg of messages) {
    if (msg.id && seenMessageIds.has(msg.id)) {
      logger.step(msg.from, 'duplicate webhook delivery ignored', msg.id);
      continue;
    }
    if (msg.id) markSeen(msg.id);

    // fire-and-forget; handler catches everything internally
    handler.handleIncomingMessage(msg).catch((err) =>
      errorTracker.record({ step: 'webhook', phone: msg.from, error: err, severity: 'critical' })
    );
  }
});

/**
 * Pull customer messages out of Meta's webhook envelope. Handles:
 *  - type "text"        → plain messages
 *  - type "interactive" → reply-button / list taps (our clarification menu)
 *  - type "button"      → quick-reply taps on TEMPLATE messages (surveys);
 *                         context.id links the answer back to the survey
 * Statuses/read-receipts and media messages are ignored (logged).
 */
function extractTextMessages(body) {
  const out = [];
  if (body?.object !== 'whatsapp_business_account') return out;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      for (const m of change.value?.messages || []) {
        if (m.type === 'text' && m.text?.body) {
          out.push({ id: m.id, from: m.from, text: m.text.body });
        } else if (m.type === 'interactive' && m.interactive) {
          const r = m.interactive.button_reply || m.interactive.list_reply;
          if (r) {
            out.push({
              id: m.id, from: m.from, text: r.title,
              buttonId: r.id, contextId: m.context?.id,
            });
          }
        } else if (m.type === 'button' && m.button) {
          out.push({
            id: m.id, from: m.from, text: m.button.text,
            buttonId: m.button.payload || 'template-reply', contextId: m.context?.id,
          });
        } else if (m.from) {
          logger.step(m.from, 'non-text message ignored', `type=${m.type}`);
        }
      }
    }
  }
  return out;
}

// ---------- shared knowledge base ----------

// The single source of truth for answers, served as plain text so the
// ManyChat/Instagram flow can pull the SAME faq.md this bot uses —
// prices/details never live in two places.
app.get('/faq', (_req, res) => {
  res.type('text/plain; charset=utf-8').send(getFaq());
});

// ---------- reporting ----------

// Monthly stats: GET /report?month=2026-07&secret=REPORT_SECRET
// -> { totalIncoming, uniqueCustomers, byIntent, handovers }
app.get('/report', async (req, res) => {
  if (!env.mockMode) {
    if (!env.reportSecret) return res.status(403).json({ error: 'Set REPORT_SECRET to enable this endpoint.' });
    if (req.query.secret !== env.reportSecret) return res.status(403).json({ error: 'Wrong secret.' });
  }
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  try {
    res.json(await report.buildMonthlyReport(month));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- local testing helpers ----------

// Simulate a customer message without WhatsApp:
//   curl -X POST localhost:3000/test-message \
//     -H 'Content-Type: application/json' \
//     -d '{"from":"905551112233","text":"Kurs fiyatları ne kadar?"}'
app.post('/test-message', async (req, res) => {
  if (!env.mockMode && !env.testEndpointEnabled) {
    return res.status(403).json({ error: 'Enable MOCK_MODE or TEST_ENDPOINT_ENABLED to use this.' });
  }
  const { from, text, buttonId, contextId } = req.body || {};
  if (!from || !text) {
    return res.status(400).json({ error: 'Body must be {"from": "<phone>", "text": "<message>"} (optional: buttonId, contextId)' });
  }
  const result = await handler.handleIncomingMessage({
    from: String(from), text: String(text),
    buttonId: buttonId ? String(buttonId) : undefined,
    contextId: contextId ? String(contextId) : undefined,
  });
  res.json(result);
});

app.get('/mock-state', (_req, res) => {
  if (!env.mockMode) return res.status(403).json({ error: 'Only available in MOCK_MODE' });
  res.json(mocks.state);
});

// ---------- startup ----------

// Last-resort safety nets: log, never die silently.
process.on('unhandledRejection', (err) => {
  errorTracker.record({ step: 'unhandled-rejection', error: err, severity: 'critical' });
});
process.on('uncaughtException', (err) => {
  errorTracker.record({ step: 'uncaught-exception', error: err, severity: 'critical' });
});

// Periodic jobs (single Railway instance -> in-process timers suffice):
//  - overdue-complaint SLA reminders
//  - monthly report email on the 1st (for the previous month)
let lastReportMonth = '';
function startPeriodicJobs() {
  const minutes = getSla().reminderCheckMinutes || 60;
  setInterval(() => complaints.checkOverdue(), minutes * 60 * 1000).unref();

  setInterval(async () => {
    const now = new Date();
    if (now.getUTCDate() !== 1) return;
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const month = prev.toISOString().slice(0, 7);
    if (lastReportMonth === month) return;
    lastReportMonth = month;
    try {
      const r = await report.buildMonthlyReport(month);
      await notify.sendAlert({
        subject: `📊 ALWA aylık rapor — ${month}`,
        body: report.formatReportText(r),
      });
      logger.info(`Monthly report for ${month} emailed`);
    } catch (err) {
      await errorTracker.record({ step: 'apps-script', error: new Error(`monthly report: ${err.message}`) });
    }
  }, 60 * 60 * 1000).unref();
}

// Only start the server when run directly (tests import the app instead).
if (require.main === module) {
  app.listen(env.port, async () => {
    logger.info(`ALWA listening on port ${env.port}${env.mockMode ? ' (MOCK MODE — no live APIs)' : ''}`);
    try {
      await sheets.ensureSheetsExist();
    } catch (err) {
      // Don't crash: the bot can still answer customers; sheet writes
      // will keep erroring visibly until credentials are fixed.
      await errorTracker.record({ step: 'Sheet', error: err, severity: 'critical' });
    }
    startPeriodicJobs();
  });
}

module.exports = { app, extractTextMessages };

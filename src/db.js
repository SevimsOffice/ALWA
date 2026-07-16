/**
 * db.js — Supabase (PostgREST) data layer. The primary store for
 * conversations, identity (students), leads, complaints and survey
 * responses. Google Sheets stays as a human-readable mirror.
 *
 * Uses the Supabase REST API directly with fetch — same zero-heavy-deps
 * pattern as sheets.js. Auth is the service-role key (server-side only,
 * never exposed to clients).
 *
 * GRACEFUL DEGRADATION: if SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
 * not set, every function becomes a no-op (returning null/[]) and the
 * bot keeps working exactly like v1 (Sheets-only). This means the
 * Supabase upgrade can be deployed before the database exists.
 */

const { env } = require('./config');
const logger = require('./logger');
const mocks = require('./mocks');

const DB_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 1000; // PostgREST default max rows per request

let warnedUnconfigured = false;

function isEnabled() {
  if (env.mockMode) return true;
  const ok = Boolean(env.supabaseUrl && env.supabaseServiceKey);
  if (!ok && !warnedUnconfigured) {
    warnedUnconfigured = true;
    logger.info('Supabase not configured — running Sheets-only (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to enable)');
  }
  return ok;
}

async function request(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${env.supabaseUrl}/rest/v1${path}`, {
    method,
    headers: {
      apikey: env.supabaseServiceKey,
      Authorization: `Bearer ${env.supabaseServiceKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(DB_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  const raw = await res.text();
  return raw ? JSON.parse(raw) : null;
}

// ---------- generic insert ----------

/** Insert one row; returns the created row (with id) or null when disabled. */
async function insert(table, row) {
  if (!isEnabled()) return null;
  if (env.mockMode) {
    const withId = { id: mocks.state.dbRows.length + 1, ts: new Date().toISOString(), ...row };
    mocks.state.dbRows.push({ table, row: withId });
    return withId;
  }
  const created = await request('POST', `/${table}`, row, { Prefer: 'return=representation' });
  return Array.isArray(created) ? created[0] : created;
}

// ---------- identity ----------

/** Look up a phone number in the students table. null = unknown = prospect. */
async function findStudent(phone) {
  if (!isEnabled()) return null;
  if (env.mockMode) {
    return mocks.state.students.find((s) => s.phone === phone) || null;
  }
  const rows = await request('GET', `/students?phone=eq.${encodeURIComponent(phone)}&limit=1`);
  return rows && rows[0] ? rows[0] : null;
}

// ---------- conversations ----------

/** Persist one message row (same shape the Sheets mirror uses). */
async function logConversation(m) {
  return insert('conversations', {
    session_id: m.sessionId,
    direction: m.direction,
    sender: m.senderPhone,
    text: m.messageText || '',
    intent: m.detectedIntent || null,
    needs_human: Boolean(m.needsHuman),
    status: m.status || 'ok',
  });
}

/**
 * Last `limit` messages of one customer, oldest first — used to re-seed
 * the in-RAM conversation memory after a server restart.
 */
async function getRecentConversations(phone, limit = 10) {
  if (!isEnabled()) return [];
  if (env.mockMode) {
    return mocks.state.dbRows
      .filter((r) => r.table === 'conversations' && r.row.session_id === phone)
      .map((r) => r.row)
      .slice(-limit);
  }
  const rows = await request(
    'GET',
    `/conversations?session_id=eq.${encodeURIComponent(phone)}&order=ts.desc&limit=${limit}`
  );
  return (rows || []).reverse();
}

/** All incoming rows of one calendar month (paginated) — for reporting. */
async function getMonthIncoming(monthStartIso, monthEndIso) {
  if (!isEnabled()) return [];
  if (env.mockMode) {
    return mocks.state.dbRows
      .filter((r) => r.table === 'conversations' && r.row.direction === 'incoming'
        && r.row.ts >= monthStartIso && r.row.ts < monthEndIso)
      .map((r) => r.row);
  }
  const all = [];
  for (let page = 0; page < 20; page++) { // safety cap: 20k rows/month
    const rows = await request(
      'GET',
      `/conversations?direction=eq.incoming&ts=gte.${monthStartIso}&ts=lt.${monthEndIso}` +
      `&select=intent,needs_human,session_id&order=ts.asc&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`
    );
    all.push(...(rows || []));
    if (!rows || rows.length < PAGE_SIZE) break;
  }
  return all;
}

// ---------- complaints ----------

/** Open complaints whose deadline has passed and no reminder sent yet. */
async function getOverdueComplaints() {
  if (!isEnabled()) return [];
  const nowIso = new Date().toISOString();
  if (env.mockMode) {
    return mocks.state.dbRows
      .filter((r) => r.table === 'complaints' && r.row.status === 'open'
        && !r.row.reminder_sent && r.row.deadline < nowIso)
      .map((r) => r.row);
  }
  return (await request(
    'GET',
    `/complaints?status=eq.open&reminder_sent=eq.false&deadline=lt.${nowIso}&order=deadline.asc&limit=50`
  )) || [];
}

async function markComplaintReminded(id) {
  if (!isEnabled()) return;
  if (env.mockMode) {
    const hit = mocks.state.dbRows.find((r) => r.table === 'complaints' && r.row.id === id);
    if (hit) hit.row.reminder_sent = true;
    return;
  }
  await request('PATCH', `/complaints?id=eq.${id}`, { reminder_sent: true });
}

module.exports = {
  isEnabled,
  insert,
  findStudent,
  logConversation,
  getRecentConversations,
  getMonthIncoming,
  getOverdueComplaints,
  markComplaintReminded,
};

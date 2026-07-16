/**
 * memory.js — per-phone-number conversation memory.
 *
 * Each customer (identified by their phone number = session ID) gets
 * their OWN message history and their own state. There is deliberately
 * no shared/global session — that's a known failure mode where the bot
 * mixes up customers.
 *
 * Storage is in-process (a Map). Trade-off, documented in the README:
 * a server restart/redeploy clears short-term memory, but every message
 * is still permanently logged in the Google Sheet. For this use case
 * (short pre-sales chats) that's acceptable and keeps the system free
 * of a database dependency.
 */

const MAX_TURNS = 20;                    // messages kept per customer (user+assistant combined)
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // forget conversations idle for 12h

const sessions = new Map(); // phone -> { history: [{role, content}], lastSeen, mutedUntil, hydrated }

function getSession(phone) {
  let s = sessions.get(phone);
  const now = Date.now();
  if (!s || now - s.lastSeen > SESSION_TTL_MS) {
    s = { history: [], lastSeen: now, mutedUntil: 0, hydrated: false };
    sessions.set(phone, s);
  }
  s.lastSeen = now;
  return s;
}

/**
 * Restart resilience: true when this session has never been seeded from
 * the database (fresh process or expired session). The handler then
 * loads the customer's recent rows from Supabase and calls hydrate().
 */
function needsHydration(phone) {
  return !getSession(phone).hydrated;
}

/** Seed a fresh session with history/mute state recovered from the DB. */
function hydrate(phone, { history = [], mutedUntil = 0 } = {}) {
  const s = getSession(phone);
  if (s.hydrated) return;
  if (s.history.length === 0 && history.length > 0) {
    s.history.push(...history.slice(-MAX_TURNS));
  }
  if (mutedUntil > s.mutedUntil) s.mutedUntil = mutedUntil;
  s.hydrated = true;
}

/** Conversation history for the AI, scoped to this phone number only. */
function getHistory(phone) {
  return getSession(phone).history;
}

function addMessage(phone, role, content) {
  const s = getSession(phone);
  s.history.push({ role, content });
  if (s.history.length > MAX_TURNS) s.history.splice(0, s.history.length - MAX_TURNS);
}

/**
 * Mute a customer (after a negative/stop message): the bot sends one
 * polite closing message and then stays silent for `hours`.
 */
function mute(phone, hours) {
  getSession(phone).mutedUntil = Date.now() + hours * 60 * 60 * 1000;
}

function isMuted(phone) {
  return getSession(phone).mutedUntil > Date.now();
}

/** Test hook. */
function resetAll() {
  sessions.clear();
}

module.exports = { getHistory, addMessage, mute, isMuted, needsHydration, hydrate, resetAll };

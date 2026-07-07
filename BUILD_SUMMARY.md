# BUILD_SUMMARY — what was built, what's left for you

_Build date: 2026-07-07. Everything below was built and tested
autonomously in mock mode; nothing has touched a live API yet._

## ✅ Code-complete and verified (via automated tests + mock run)

- **Express webhook server** (`src/index.js`): Meta verification
  handshake (GET /webhook), incoming messages (POST /webhook, ACKs
  immediately and processes async as Meta requires), `/health`,
  `/test-message`, `/mock-state`. Duplicate webhook deliveries are
  deduped by message ID.
- **AI agent** (`src/ai.js`): OpenAI chat completions, model set by
  `OPENAI_MODEL` (default `gpt-4.1-mini`). The ENTIRE `faq.md` +
  `config/system-prompt.md` are injected on every call — deliberately
  **no vector DB/RAG** (FAQ is small; a Markdown file on GitHub is the
  whole knowledge-update workflow).
- **Per-phone conversation memory** (`src/memory.js`): each phone
  number = its own session and history (20 msgs, 12h TTL). Verified by
  a test that two customers' histories don't leak into each other.
- **Google Sheets logging** (`src/sheets.js`): one row per message
  (incoming and outgoing) in a `messages` tab with exactly the columns
  from the spec; tabs + headers are auto-created on first boot. Uses
  the Sheets REST API with a service-account JWT (light
  `google-auth-library` dep, no bulky `googleapis`).
- **Intent detection** (`src/intent.js`): transparent, editable keyword
  matching, case- and Turkish-accent-insensitive (KAYIT = kayıt =
  kayit). Handover keywords carry a `topic` (sales/complaints) used to
  route staff alerts.
- **Negative/stop handling**: hostile / profane / "stop messaging me"
  messages get ONE polite closing message (TR or EN, matched to the
  customer), then the number is muted for 72h — no re-offers, no
  argument, the AI is never even asked to respond to abuse. All
  configurable in `config/negative-keywords.json`.
- **Handover**: flags `needs_human=yes` in the sheet and alerts staff
  with the phone + last message ("Customer X wants to be contacted").
  Recipients and topic routing live in `config/recipients.json` —
  nothing hard-coded.
- **Notifications** (`src/notify.js`): email via a Google Apps Script
  web app (script + step-by-step guide in `/apps-script`); optional
  best-effort Telegram and CallMeBot channels, fully decoupled from the
  customer WhatsApp number, silently skipped when unconfigured, and
  their failures never break the flow.
- **Three-layer error tracking**: (1) step-by-step console logs
  (`message received` → `intent detected` → `sent to AI` → `AI
  responded` → `reply sent to WhatsApp` → `logged to Sheet` →
  `handover triggered`); (2) every risky call try/caught — an AI
  failure still sends the customer a graceful fallback and the process
  never crashes; (3) every caught error appended to an `errors` sheet
  tab (timestamp / phone / step / message / severity), with critical
  errors also firing the email alert.
- **Mock mode + tests**: `MOCK_MODE=true` replaces OpenAI, WhatsApp,
  Sheets, and all notifiers with in-memory fakes. `npm test` runs 12
  tests covering the Q&A flow, memory isolation, FAQ injection,
  handover (TR+EN), mute-after-negative, profanity handling, webhook
  parsing, and error tracking — **all passing**. `scripts/simulate.js`
  posts a byte-accurate Meta webhook payload for manual testing.

## 🔧 Decisions I made for you (and why)

| Decision | Why |
|---|---|
| Node.js + Express, CommonJS, only 3 deps (express, dotenv, google-auth-library) | Richest ecosystem for this stack; tiny dependency surface = fewer breakages |
| No database — memory in-process, permanent log in Sheets | Short pre-sales chats don't justify DB ops; restart cost documented |
| Keyword-based intent detection instead of an extra AI classification call | Transparent, free, instantly editable by non-devs on GitHub; the AI still handles the *reply* nuance |
| Webhook ACKs 200 immediately, work continues async | Meta disables slow webhooks; this is the required pattern |
| Fallback apology message if the AI call fails | Customer is never left on read; you get a critical alert simultaneously |
| Apps Script gets recipients per-request from `config/recipients.json` | One editable file controls all alert recipients; the script never needs redeploying to change them |
| Shared secret on the Apps Script webhook | It must be world-reachable; the secret stops strangers sending mail as you |

## 🖐️ NOT done — requires your hands (credentials/accounts I can't create)

Nothing below is code work; it's all account setup, walked through
click-by-click in `README.md`:

1. **OpenAI**: create key, add billing → 2 env vars. (README §1)
2. **Meta/WhatsApp**: create the app, get permanent token + phone
   number ID, later point the webhook at your deployed URL. The
   longest step. (README §2)
3. **Google Sheet + service account**: create sheet, enable Sheets API,
   create service-account key, **share the sheet with the service
   account** → 3 env vars. (README §3)
4. **Apps Script**: paste `apps-script/Code.gs`, set the secret, deploy
   as web app → 2 env vars. (README §4 / `apps-script/README.md`)
5. **Deploy on Railway** (or Render): connect the repo, paste env vars,
   generate the domain, then complete the Meta webhook config. (README §6)
6. **Replace placeholder content**: `faq.md` (dummy prices/courses/
   address) and `config/recipients.json` (example.com addresses).
7. Optional: Telegram bot / CallMeBot keys if you want instant pings on
   top of email. (README §5)

## ⚠️ Honest limitations

- **Never run against live APIs yet** — the HTTP request shapes for
  OpenAI / Meta Graph / Sheets / Telegram / CallMeBot follow their
  current documented formats, but expect the usual first-contact
  friction (a 401 from a mistyped key, the sheet not shared with the
  service account, etc.). The error tracking exists precisely to make
  those visible: check the Railway logs and the `errors` tab.
- Memory and mutes reset on redeploy (documented above; acceptable
  trade-off, no DB to babysit).
- Only text messages are answered; media is ignored (logged to console).
- Webhook payload signature (`X-Hub-Signature-256`) is not verified —
  standard practice for small bots; the verify-token handshake plus an
  unguessable URL is the protection. Can be added later if wanted.
- Intent detection is keyword-based: a very creatively phrased "please
  have someone call me" that matches no keyword would not flag
  handover (the AI will still answer helpfully). Extend the keyword
  files as you see real conversations.

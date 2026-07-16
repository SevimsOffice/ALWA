# ALWA — American Life WhatsApp Agent

An AI customer-support agent for WhatsApp. A customer messages the
school's WhatsApp number; ALWA answers from the school's FAQ in a
natural, human tone, logs every message to a Google Sheet, detects when
someone wants to enroll or talk to a human and alerts staff, and tracks
every error step-by-step.

```
Customer on WhatsApp
        │
        ▼
Meta WhatsApp Cloud API ──webhook──▶ ALWA (Node/Express server)
                                        │
        ┌───────────────┬───────────────┼─────────────────┐
        ▼               ▼               ▼                 ▼
     OpenAI        Google Sheet     Apps Script      Telegram/CallMeBot
  (answers from   (messages tab +  (email alerts:      (optional extra
   faq.md, per-    errors tab)      handover+errors)     alert channel)
   phone memory)
```

## What's in the box

| Path | What it is | You edit it? |
|---|---|---|
| `faq.md` | Everything the AI knows. Edit on GitHub to update answers. Also served at `GET /faq` so your ManyChat/Instagram flow can use the same source. | **Yes — often** |
| `config/system-prompt.md` | The AI's personality & rules (business-neutral; company facts live in faq.md) | Yes |
| `config/intents.json` | The intent categories the AI classifies every message into + confidence threshold | Yes |
| `config/buttons.json` | The clarification button menu + survey thank-you text | Yes |
| `config/sla.json` | Complaint response-time promise + confirmation message | Yes |
| `config/handover-keywords.json` | Words that mean "I want a human" | Yes |
| `config/negative-keywords.json` | Words that politely end the conversation | Yes |
| `config/recipients.json` | Who gets email/Telegram/WhatsApp alerts | **Yes** |
| `supabase/schema.sql` | Database tables (paste once into Supabase SQL Editor) | Run once |
| `apps-script/` | The free email-sending script + its setup guide | Deploy once |
| `src/` | The server code | No (unless developing) |
| `.env.example` | Every secret/credential you need to provide | Copy to `.env` |

## How a message is routed (v2 architecture)

Every message enters through the same webhook and is routed in software:

1. **Identity (Layer 1):** the phone number is looked up in the Supabase
   `students` table. Known number → support mode; unknown → sales mode.
   Survey button replies split off here (by template context ID) and
   never touch the sales flow.
2. **Intent (Layer 2):** keyword pre-filter (hostile/stop messages,
   explicit "temsilci" requests), then ONE OpenAI call returns both the
   reply and a per-message intent label (`kurs_bilgisi / fiyat / sikayet
   / oneri / insan / diger`) with a confidence score. A complaint in the
   middle of a sales chat is caught, because intent is per message. Low
   confidence → a 3-button clarification menu instead of a guess.
3. **Action (Layer 3):** sales/info → AI reply (+ a `leads` row on
   handover); complaint → `complaints` row with a deadline + staff
   alert + "your complaint is recorded, we'll reply within X hours"
   confirmation (overdue complaints trigger reminder emails); human
   request → staff handover alert. Everything lands in `conversations`
   (+ the Google Sheets mirror), which feeds `GET /report?month=YYYY-MM`
   and the automatic monthly report email.

Key design decisions and honest completion status: see
[`BUILD_SUMMARY.md`](BUILD_SUMMARY.md).

---

## Try it right now (no credentials needed)

```bash
npm install
npm test        # 12 automated tests of the whole flow
npm run mock    # start the server with all external APIs mocked
```

In a second terminal:

```bash
# simulate a customer message arriving exactly like Meta sends it:
node scripts/simulate.js "Kurs fiyatları ne kadar?"
node scripts/simulate.js "Kayıt olmak istiyorum, beni arayın"   # triggers handover
node scripts/simulate.js "İlgilenmiyorum, yazmayın"             # triggers polite close + mute

# or call the test endpoint directly and see the reply:
curl -X POST localhost:3000/test-message -H 'Content-Type: application/json' \
  -d '{"from":"905551112233","text":"Do you have online courses?"}'

# see everything that "happened" (sent messages, sheet rows, emails):
curl localhost:3000/mock-state
```

Watch the first terminal — you'll see the step-by-step log lines
(`message received`, `intent detected`, `AI responded`, ...).

---

# Going live — full setup guide

You need 5 things. Do them in this order; each section tells you exactly
which `.env` values it produces. Budget ~1–2 hours the first time.

## 1. OpenAI API key (~5 min)

1. Go to <https://platform.openai.com> and sign in / create an account.
2. Add a payment method under **Settings → Billing** (a few dollars of
   credit is plenty to start — this bot uses a cheap model and short
   messages).
3. Go to <https://platform.openai.com/api-keys> → **Create new secret
   key**. Copy it immediately (it's shown once).

➡ `.env`: `OPENAI_API_KEY=sk-...`
➡ `.env`: `OPENAI_MODEL=gpt-4.1-mini` (default; change any time)

## 2. WhatsApp Business Cloud API (~30 min, the fiddliest one)

1. Go to <https://developers.facebook.com> → **My Apps** → **Create
   App** → type **Business**.
2. In the app dashboard, find **WhatsApp** and click **Set up**. This
   creates a test number you can use immediately.
3. On the **API Setup** page you'll see:
   - **Temporary access token** → this works for ~24h. For production,
     create a **System User** (Business Settings → Users → System
     users), assign it the app + WhatsApp permissions, and generate a
     **permanent token**. (Meta's UI moves around; search "WhatsApp
     permanent access token system user" for a current walkthrough.)
   - **Phone number ID** (a long number under the phone dropdown —
     NOT the phone number itself).
4. To use your REAL business number instead of the test number: **API
   Setup → Add phone number** and follow the verification steps.
   ⚠️ A number currently registered on the WhatsApp (Business) app must
   be deleted from the app before it can move to the Cloud API.
5. Webhook configuration — do this AFTER you deploy (step 6 below),
   because you need your server URL first:
   - App dashboard → WhatsApp → **Configuration** → Webhook → **Edit**.
   - Callback URL: `https://YOUR-DEPLOYED-URL/webhook`
   - Verify token: the exact string you chose for
     `WHATSAPP_VERIFY_TOKEN` in `.env` (you invent it).
   - Click **Verify and save** — your server must already be running.
   - Under **Webhook fields**, subscribe to **messages**.

➡ `.env`: `WHATSAPP_TOKEN=` (the permanent token)
➡ `.env`: `WHATSAPP_PHONE_NUMBER_ID=` (from API Setup)
➡ `.env`: `WHATSAPP_VERIFY_TOKEN=` (any string you invent)

## 3. Google Sheet + service account (~15 min)

The sheet is your conversation log and error dashboard.

1. Create a new Google Sheet at <https://sheets.new>. Name it e.g.
   "ALWA logs". Copy the **spreadsheet ID** from the URL:
   `docs.google.com/spreadsheets/d/`**`THIS_LONG_PART`**`/edit`.
   (Don't create any tabs — ALWA creates `messages` and `errors`
   with headers automatically on first start.)
2. Create a service account (a robot Google user for the server):
   1. Go to <https://console.cloud.google.com> → create a project
      (name: anything, e.g. "alwa").
   2. **APIs & Services → Library** → search **Google Sheets API** →
      **Enable**.
   3. **APIs & Services → Credentials → Create credentials → Service
      account**. Name it `alwa-logger`, click through with defaults.
   4. Open the created service account → **Keys** tab → **Add key →
      Create new key → JSON**. A JSON file downloads.
3. Open that JSON file. You need two values:
   - `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → `GOOGLE_PRIVATE_KEY` (keep the `\n` sequences and
     wrap it in double quotes in `.env`; on Railway/Render paste the
     value as-is)
4. **Share the Sheet with the robot**: in the Sheet click **Share** and
   add the `client_email` address as an **Editor**. (Forgetting this is
   the #1 cause of Sheet errors.)

➡ `.env`: `GOOGLE_SHEET_ID=`, `GOOGLE_SERVICE_ACCOUNT_EMAIL=`, `GOOGLE_PRIVATE_KEY=`

## 3b. Supabase — database for identity, complaints, leads (~10 min)

Optional but strongly recommended: without it the bot still works
(Sheets-only), but you lose the student lookup, complaint records,
leads, surveys, reports, and restart-proof memory.

1. Go to <https://supabase.com> → sign in with GitHub → **New project**
   (free tier is plenty). Pick any name/region, set a database password
   (you won't need it day-to-day).
2. In the left sidebar open **SQL Editor** → **New query** → paste the
   ENTIRE contents of `supabase/schema.sql` from this repo → **Run**.
   This creates the `students`, `conversations`, `leads`, `complaints`
   and `survey_responses` tables.
3. **Project Settings → API**: copy
   - **Project URL** → `SUPABASE_URL`
   - **service_role key** (under "Project API keys" — NOT the anon key)
     → `SUPABASE_SERVICE_ROLE_KEY`
4. Load your existing student/customer list: **Table Editor →
   students → Insert → Import data from CSV**. The `phone` column must
   be international format, digits only (e.g. `905551112233`).
5. Day-to-day: complaints are managed in **Table Editor → complaints**
   — when a complaint is handled, change its `status` to `resolved`.
   Leads appear in the `leads` table.

➡ `.env`: `SUPABASE_URL=`, `SUPABASE_SERVICE_ROLE_KEY=`
➡ `.env`: `REPORT_SECRET=` (any random string — protects `GET /report`)

## 4. Email alerts — Google Apps Script (~5 min)

Follow **[`apps-script/README.md`](apps-script/README.md)** — copy one
file into script.google.com, set a secret, deploy as a web app, test
with one curl command.

➡ `.env`: `APPS_SCRIPT_URL=`, `APPS_SCRIPT_SECRET=`

Then put the real alert recipient addresses in
`config/recipients.json` (`emailRecipients` + per-staff emails).

## 5. Optional: Telegram / WhatsApp alerts for staff

Email always works. If you also want instant pings:

**Telegram** (recommended of the two):
1. In Telegram, message **@BotFather** → `/newbot` → follow prompts →
   copy the bot token.
2. Each staff member messages the new bot once (press Start), then gets
   their chat ID from **@userinfobot**.
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_IDS` in `.env`, and set
   `"telegram": true` under `channels` in `config/recipients.json`.

**CallMeBot (WhatsApp)** — a free third-party notifier, deliberately
separate from your customer-facing number:
1. Each recipient follows <https://www.callmebot.com/blog/free-api-whatsapp-messages/>
   to get a personal API key.
2. Set `CALLMEBOT_RECIPIENTS=90555xxxxxxx:apikey1,...` in `.env` and
   `"callmebot": true` in `config/recipients.json`.

If these are off or unconfigured, everything still works on email alone.

## 6. Deploy (Railway — ~10 min)

Railway is the simplest for this kind of webhook service. (Render works
the same way; the project is a plain Node app with `npm start`, nothing
platform-specific.)

1. Go to <https://railway.app> → sign in with GitHub.
2. **New Project → Deploy from GitHub repo** → pick `SevimsOffice/ALWA`.
3. Open the service → **Variables** → add every variable from
   `.env.example` with your real values (skip the optional ones you
   don't use; leave `MOCK_MODE` unset or `false`).
4. **Settings → Networking → Generate Domain**. Copy the URL, e.g.
   `https://alwa-production.up.railway.app`.
5. Check it's alive: open `https://YOUR-URL/health` in a browser →
   you should see `{"status":"ok",...}`.
6. Now go back to **step 2.5** and configure the Meta webhook with
   `https://YOUR-URL/webhook`.

Railway auto-redeploys on every push to the repo — so editing `faq.md`
on GitHub updates the bot's knowledge within a couple of minutes.

## 7. Test the live system

1. **Health**: `https://YOUR-URL/health` → `{"status":"ok"}`.
2. **Email**: the curl test in `apps-script/README.md` §4.
3. **End to end**: from a phone, message the WhatsApp number
   (with Meta's test number you must first add your phone as a
   recipient on the API Setup page):
   - "Kurs fiyatları ne kadar?" → should get an FAQ answer, and two
     rows should appear in the `messages` sheet tab.
   - "Kayıt olmak istiyorum" → answer + `needs_human=yes` in the sheet
     + alert email arrives.
4. **Watch it live**: Railway → your service → **Deployments → View
   logs** — you'll see every step (`message received`, `sent to AI`,
   `AI responded`, ...). Any failure also lands in the `errors` sheet
   tab, and critical ones email you.

---

## Day-to-day operation

- **Update answers** → edit `faq.md` on GitHub → commit → done.
- **Change who gets alerts** → edit `config/recipients.json`.
- **Change the bot's tone/rules** → edit `config/system-prompt.md`.
- **Add stop-words / handover words** → edit the two keyword JSON files.
- **See conversations** → `messages` tab; filter the `session_id`
  column by a phone number to read one customer's whole thread.
- **See failures** → `errors` tab (timestamp, phone, step, message,
  severity). Critical failures also email you.
- **Handle a complaint** → Supabase → Table Editor → `complaints` →
  set `status` to `resolved`. Unresolved past-deadline complaints
  trigger reminder emails automatically.
- **See/export leads** → Supabase `leads` table.
- **Monthly numbers** → `https://YOUR-URL/report?month=2026-07&secret=REPORT_SECRET`,
  and the same report is emailed automatically on the 1st of each month.
- **Point ManyChat at the same answers** → fetch `https://YOUR-URL/faq`.

## Behavior notes & limitations

- **Conversation memory** is per phone number (last 20 messages, 12h
  idle timeout), cached in RAM. With Supabase configured, a restart
  re-seeds each conversation (and mute state) from the `conversations`
  table on the customer's next message; without Supabase, restarts
  clear short-term memory (the permanent record is still in the Sheet).
- **Muting**: after a hostile/"stop" message the bot sends one polite
  goodbye and ignores that number for 72h (configurable in
  `negative-keywords.json`). Messages are still logged.
- **24-hour window**: WhatsApp only lets businesses send free-form
  replies within 24h of the customer's last message. ALWA only ever
  replies to incoming messages, so this is automatically satisfied.
- Only **text** messages are answered; images/voice notes are logged in
  the console and ignored.

# Email alerts via Google Apps Script — setup

This folder contains the small script that sends ALWA's alert emails
(handover alerts + error alerts) for free from your own Google account.
The Node server never sends mail itself — it just POSTs the alert here.

Takes about 5 minutes. Do this in the **same Google account** that owns
the logging spreadsheet.

## 1. Create the script

1. Go to <https://script.google.com> and click **New project**.
2. Delete the placeholder code in the editor.
3. Copy ALL of `Code.gs` from this folder and paste it in.
4. Rename the project (top-left) to something like `ALWA email webhook`.

## 2. Set the shared secret

1. In the left sidebar click **Project Settings** (gear icon).
2. Scroll to **Script Properties** → **Add script property**.
3. Property name: `SHARED_SECRET`
   Value: a long random string you invent (e.g. 30+ random characters).
4. Put the **same value** in your `.env` / deploy platform as
   `APPS_SCRIPT_SECRET`. This stops strangers from using your webhook
   to send email.

## 3. Deploy as a web app

1. Click **Deploy** (top-right) → **New deployment**.
2. Click the gear next to "Select type" → choose **Web app**.
3. Settings:
   - Description: anything
   - **Execute as: Me** (your account — this is what lets it send mail)
   - **Who has access: Anyone** (required so the server can reach it;
     the shared secret is what protects it)
4. Click **Deploy**, approve the permission prompts
   ("...wants to send email as you" → Allow).
5. Copy the **Web app URL** (ends in `/exec`) and put it in your `.env`
   / deploy platform as `APPS_SCRIPT_URL`.

## 4. Test it

Option A — from the Apps Script editor: open `Code.gs`, select the
function `sendTestEmail` in the toolbar dropdown, press **Run**. You
should get a test email at your own address.

Option B — end to end from your machine:

```bash
curl -X POST "YOUR_WEB_APP_URL" \
  -H "Content-Type: application/json" \
  -L \
  -d '{"secret":"YOUR_SHARED_SECRET","recipients":["you@example.com"],"subject":"ALWA test","body":"Hello from ALWA"}'
```

You should receive the email within seconds and see `{"ok":true,...}`.

## Notes & limits

- Free Gmail accounts can send ~100 recipients/day via Apps Script
  (Workspace accounts: ~1500/day). Far more than alert volume needs.
- If you later edit `Code.gs`, you must create a **new deployment
  version** (Deploy → Manage deployments → edit → new version),
  otherwise the old code keeps running.
- Alert recipient addresses are NOT configured here — they live in
  `config/recipients.json` in the repo and are sent with each request.

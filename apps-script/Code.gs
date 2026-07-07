/**
 * ALWA — email alert web app for Google Apps Script.
 *
 * The Node server POSTs alert payloads here; this script sends the
 * emails using the Google account it's deployed under (free, no SMTP
 * service needed). Deploy it in the SAME Google account that owns the
 * logging spreadsheet. Full setup steps: apps-script/README.md.
 *
 * Expected POST body (JSON):
 *   {
 *     "secret":     "<must match the SHARED_SECRET script property>",
 *     "recipients": ["a@example.com", "b@example.com"],
 *     "subject":    "📞 ALWA: customer +90555... wants to be contacted",
 *     "body":       "Customer +90555... wants to be contacted. Last message: ..."
 *   }
 */

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    // Shared-secret check so random internet traffic can't send mail as you.
    var expected = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
    if (!expected || data.secret !== expected) {
      return jsonResponse({ ok: false, error: 'unauthorized' });
    }

    var recipients = (data.recipients || []).filter(function (r) { return r; });
    if (recipients.length === 0) {
      return jsonResponse({ ok: false, error: 'no recipients' });
    }

    MailApp.sendEmail({
      to: recipients.join(','),
      subject: data.subject || 'ALWA alert',
      body: (data.body || '') + '\n\n— ALWA (American Life WhatsApp Agent)',
    });

    return jsonResponse({ ok: true, sent: recipients.length });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

// Simple GET so you can check the deployment is alive in a browser.
function doGet() {
  return jsonResponse({ ok: true, service: 'ALWA email webhook' });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * OPTIONAL helper: run this once from the Apps Script editor to send
 * yourself a test email and trigger the permission prompt.
 */
function sendTestEmail() {
  MailApp.sendEmail({
    to: Session.getActiveUser().getEmail(),
    subject: 'ALWA test email',
    body: 'If you can read this, the Apps Script email channel works.',
  });
}

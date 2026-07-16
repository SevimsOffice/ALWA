/**
 * complaints.js — the complaint module.
 *
 * On a complaint-intent message:
 *   1. a row is opened in the Supabase `complaints` table with a
 *      deadline (now + config/sla.json complaintResponseHours),
 *   2. the responsible staff (topic "complaints" in recipients.json)
 *      are notified immediately,
 *   3. the customer gets the SLA confirmation message ("kaydınız
 *      alındı, {hours} saat içinde dönüş yapılacak").
 *
 * A periodic check (started in index.js) emails a reminder for any
 * complaint still open past its deadline — the "panel" is the
 * complaints table in Supabase's Table Editor; staff flip status to
 * 'resolved' there when done.
 */

const { getSla } = require('./config');
const db = require('./db');
const notify = require('./notify');
const logger = require('./logger');
const errorTracker = require('./errorTracker');

/**
 * Open a complaint record + notify staff.
 * Returns the SLA confirmation message to send to the customer.
 */
async function openComplaint({ phone, summary, customerType }) {
  const sla = getSla();
  const hours = sla.complaintResponseHours || 24;
  const deadline = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  const row = await db.insert('complaints', {
    phone,
    summary: String(summary || '').slice(0, 1000),
    deadline,
    status: 'open',
    reminder_sent: false,
  });
  logger.step(phone, 'complaint recorded', row ? `id=${row.id}, deadline=${deadline}` : '(db disabled — alert only)');

  await notify.sendAlert({
    subject: `📝 ALWA: yeni şikayet — ${phone}`,
    body:
      `Yeni şikayet kaydı açıldı.\n` +
      `Müşteri: ${phone} (${customerType === 'student' ? 'kayıtlı öğrenci/veli' : 'kayıtlı değil'})\n` +
      `Mesaj: "${summary}"\n` +
      `Son dönüş tarihi (SLA): ${deadline}\n\n` +
      `Kaydı kapatmak için Supabase > complaints tablosunda status = resolved yapın.`,
    staff: notify.staffForTopic('complaints'),
  });

  return (sla.confirmationMessage || 'Kaydınız alındı, {hours} saat içinde dönüş yapılacak.')
    .replace('{hours}', String(hours));
}

/**
 * Periodic job: email a reminder for every open complaint past its
 * deadline (once per complaint). Never throws.
 */
async function checkOverdue() {
  try {
    const overdue = await db.getOverdueComplaints();
    for (const c of overdue) {
      await notify.sendAlert({
        subject: `⏰ ALWA: şikayet SLA süresi doldu — ${c.phone}`,
        body:
          `Bu şikayete hâlâ dönüş yapılmadı ve söz verilen süre geçti!\n` +
          `Müşteri: ${c.phone}\n` +
          `Şikayet: "${c.summary}"\n` +
          `Açılış: ${c.ts}\nDeadline: ${c.deadline}\n\n` +
          `Lütfen hemen dönüş yapın ve Supabase > complaints tablosunda status = resolved işaretleyin.`,
        staff: notify.staffForTopic('complaints'),
      });
      await db.markComplaintReminded(c.id);
      logger.step(c.phone, 'complaint SLA reminder sent', `id=${c.id}`);
    }
  } catch (err) {
    await errorTracker.record({ step: 'handover', error: err });
  }
}

module.exports = { openComplaint, checkOverdue };

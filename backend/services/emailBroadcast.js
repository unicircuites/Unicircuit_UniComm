/**
 * Email Broadcast Service — Nodemailer + Office 365 SMTP
 * Sends bulk emails with rate limiting to avoid spam filters
 */
const nodemailer = require('nodemailer');

// ── TRANSPORTER ───────────────────────────────────────────────────────────
function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.office365.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false, // STARTTLS
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: { ciphers: 'SSLv3', rejectUnauthorized: false },
  });
}

// ── VERIFY CONNECTION ─────────────────────────────────────────────────────
async function verifyConnection() {
  const t = createTransporter();
  await t.verify();
  return true;
}

// ── SEND SINGLE EMAIL ─────────────────────────────────────────────────────
function normalizeAttachments(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  return list.map((att, index) => {
    const rawBytes = String(att && att.contentBytes || '').replace(/^data:[^,]+,/, '').replace(/\s/g, '');
    const filename = String(att && att.name || `attachment-${index + 1}`)
      .replace(/[\\/:*?"<>|]+/g, '_')
      .slice(0, 180);
    if (!rawBytes || !/^[A-Za-z0-9+/=]+$/.test(rawBytes)) {
      console.warn('[Broadcast] Skipping invalid attachment:', filename);
      return null;
    }
    const mailAttachment = {
      filename,
      contentType: String(att.contentType || 'application/octet-stream'),
      content: Buffer.from(rawBytes, 'base64'),
    };
    if (att.isInline && att.contentId) {
      mailAttachment.cid = String(att.contentId).replace(/^<|>$/g, '');
    }
    return mailAttachment;
  }).filter(Boolean);
}

async function sendOne(to, subject, html, text, attachments) {
  const t = createTransporter();
  const info = await t.sendMail({
    from:    `"${process.env.SMTP_FROM_NAME || 'Unicircuit'}" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    text: text || html.replace(/<[^>]+>/g, ''),
    attachments: normalizeAttachments(attachments),
  });
  return info;
}

// ── SEND BROADCAST ────────────────────────────────────────────────────────
// recipients: [{email, name}] or ['email1', 'email2']
// onProgress: callback(sent, failed, current) for real-time updates
async function sendBroadcast(recipients, subject, html, onProgress, delayMs = 2000, attachments = []) {
  const results = { sent: 0, failed: 0, errors: [], deliveries: [] };

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const email = typeof r === 'string' ? r : r.email;
    const name  = typeof r === 'object' ? (r.name || '') : '';

    if (!email || !email.includes('@')) {
      results.failed++;
      results.errors.push({ email, error: 'Invalid email' });
      results.deliveries.push({ email, name, status: 'failed', error: 'Invalid email', sent_at: new Date().toISOString() });
      if (onProgress) onProgress(results.sent, results.failed, email);
      continue;
    }

    // Personalise HTML — replace {{name}} placeholder
    const personalHtml = html.replace(/\{\{name\}\}/gi, name || email.split('@')[0]);

    const sentAt = new Date().toISOString();
    try {
      await sendOne(email, subject, personalHtml, null, attachments);
      results.sent++;
      results.deliveries.push({ email, name, status: 'sent', sent_at: sentAt });
      console.log(`[Broadcast] Sent ${i+1}/${recipients.length} → ${email} @ ${sentAt}`);
    } catch (err) {
      results.failed++;
      results.errors.push({ email, error: err.message });
      results.deliveries.push({ email, name, status: 'failed', error: err.message, sent_at: sentAt });
      console.error(`[Broadcast] Failed → ${email}:`, err.message);
    }

    if (onProgress) onProgress(results.sent, results.failed, email);

    // Delay between sends to avoid rate limiting
    if (i < recipients.length - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return results;
}

module.exports = { sendOne, sendBroadcast, verifyConnection, normalizeAttachments };

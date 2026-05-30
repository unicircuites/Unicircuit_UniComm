/**
 * Email Broadcast Service — Nodemailer + Office 365 SMTP
 * Sends bulk emails with rate limiting to avoid spam filters
 */
const nodemailer = require('nodemailer');
const {
  normalizeFieldDefs,
  buildRecipientMap,
  substitute,
} = require('./emailTemplateVars');

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

// ── UNSUBSCRIBE FOOTER (CAN-SPAM / GDPR compliance) ──────────────────────
function appendUnsubscribeFooter(html, recipientEmail) {
  // Skip if footer already present
  if (html && html.includes('unsubscribe')) return html;
  const fromName = process.env.SMTP_FROM_NAME || 'Unicircuit Engineering Services LLP';
  const footer = `
<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif;font-size:11px;color:#9ca3af;text-align:center;line-height:1.6;">
  <p style="margin:0 0 4px;">You are receiving this email from <strong>${fromName}</strong>.</p>
  <p style="margin:0;">If you do not wish to receive any further communications, please
    <a href="https://link.email.tatatelebusiness.com/report/unsubscribe/6a1536d82945ed20fe8b4567/6a15371f51a11dfb78a30740" style="color:#9ca3af;">click here.</a>
  </p>
</div>`;
  // Inject before </body> if present, otherwise append
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, footer + '</body>');
  }
  return html + footer;
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

async function reportProgress(onProgress, results, email) {
  if (!onProgress) return;
  try {
    await onProgress(results.sent, results.failed, email, results);
  } catch (err) {
    console.error(`[Broadcast] Progress log update failed for ${email}:`, err.message);
  }
}

// ── SEND BROADCAST ────────────────────────────────────────────────────────
// recipients: [{email, name}] or ['email1', 'email2']
// onProgress: callback(sent, failed, current) for real-time updates
async function sendBroadcast(recipients, subject, html, onProgress, delayMs = 2000, attachments = [], batchSize = 1, variableFields = []) {
  const fieldDefs = normalizeFieldDefs(variableFields);
  const results = { sent: 0, failed: 0, errors: [], deliveries: [] };
  const safeBatchSize = Math.max(1, parseInt(batchSize || 1, 10) || 1);

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const email = typeof r === 'string' ? r : r.email;
    const name  = typeof r === 'object' ? (r.name || '') : '';

    if (!email || !email.includes('@')) {
      results.failed++;
      results.errors.push({ email, error: 'Invalid email' });
      results.deliveries.push({ email, name, status: 'failed', error: 'Invalid email', sent_at: new Date().toISOString() });
      await reportProgress(onProgress, results, email);
      continue;
    }

    const recipientObj = typeof r === 'object'
      ? { email, name, company: r.company || '' }
      : { email, name: '', company: '' };
    const varMap = buildRecipientMap(recipientObj, fieldDefs);
    const personalSubject = substitute(subject, varMap);
    const personalHtml = appendUnsubscribeFooter(substitute(html, varMap), email);

    const sentAt = new Date().toISOString();
    try {
      const info = await sendOne(email, personalSubject, personalHtml, null, attachments);
      const accepted = Array.isArray(info.accepted) ? info.accepted.map(v => String(v).toLowerCase()) : [];
      const rejected = Array.isArray(info.rejected) ? info.rejected.map(v => String(v).toLowerCase()) : [];
      const lowerEmail = String(email).toLowerCase();
      if (rejected.includes(lowerEmail) && !accepted.includes(lowerEmail)) {
        throw new Error('SMTP rejected recipient');
      }
      results.sent++;
      results.deliveries.push({ email, name, status: 'sent', sent_at: sentAt, message_id: info.messageId || null, smtp_accepted: accepted });
      console.log(`[Broadcast] Sent ${i+1}/${recipients.length} → ${email} @ ${sentAt}`);
    } catch (err) {
      results.failed++;
      results.errors.push({ email, error: err.message });
      results.deliveries.push({ email, name, status: 'failed', error: err.message, sent_at: sentAt });
      console.error(`[Broadcast] Failed → ${email}:`, err.message);
    }

    await reportProgress(onProgress, results, email);

    // Delay after each batch to avoid rate limiting.
    if (i < recipients.length - 1 && (i + 1) % safeBatchSize === 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return results;
}

module.exports = { sendOne, sendBroadcast, verifyConnection, normalizeAttachments };

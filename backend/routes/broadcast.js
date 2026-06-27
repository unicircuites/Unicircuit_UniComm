/**
 * Email Broadcast Routes
 */
const express = require('express');
const pool = require('../db/pool');
const eb = require('../services/emailBroadcast');
const {
  parseJsonField,
  buildUndeliveredEmailRecipients,
  mergeEmailDeliveries,
  tallyDeliveries,
  finalBroadcastStatus,
  acquireEmailBroadcastJob,
  releaseEmailBroadcastJob,
} = require('../services/broadcastHelpers');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_broadcasts (
      id           SERIAL PRIMARY KEY,
      subject      VARCHAR(500) NOT NULL,
      html_body    TEXT NOT NULL,
      recipients   JSONB NOT NULL DEFAULT '[]',
      from_email   VARCHAR(200),
      total        INT DEFAULT 0,
      sent         INT DEFAULT 0,
      failed       INT DEFAULT 0,
      status       VARCHAR(20) DEFAULT 'draft',
      errors       JSONB DEFAULT '[]',
      deliveries   JSONB DEFAULT '[]',
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      sent_at      TIMESTAMPTZ
    )
  `);
  await pool.query(`ALTER TABLE email_broadcasts ADD COLUMN IF NOT EXISTS from_email VARCHAR(200)`);
  await pool.query(`ALTER TABLE email_broadcasts ADD COLUMN IF NOT EXISTS deliveries JSONB DEFAULT '[]'`);
  await pool.query(`ALTER TABLE email_broadcasts ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'`);
  await pool.query(`ALTER TABLE email_broadcasts ADD COLUMN IF NOT EXISTS delay_ms INT DEFAULT 2000`);
  await pool.query(`ALTER TABLE email_broadcasts ADD COLUMN IF NOT EXISTS batch_size INT DEFAULT 1`);
  await pool.query(`ALTER TABLE email_broadcasts ADD COLUMN IF NOT EXISTS variable_fields JSONB DEFAULT '[]'`);
}
ensureTable().catch((e) => console.error('[Broadcast] Table init error:', e.message));

function buildPendingDeliveries(recipients) {
  return recipients.map((r) => {
    const email = typeof r === 'string' ? r : r.email;
    const name = typeof r === 'object' ? (r.name || '') : '';
    return { email, name, status: 'pending', sent_at: null };
  });
}

async function finalizeEmailBroadcastJob(broadcastId, batchResults, baseDeliveries, total) {
  const mergedDeliveries = mergeEmailDeliveries(baseDeliveries, batchResults.deliveries);
  const stats = tallyDeliveries(mergedDeliveries);
  const status = finalBroadcastStatus(mergedDeliveries, total);
  await pool.query(
    `UPDATE email_broadcasts SET sent=$1, failed=$2, status=$3, sent_at=CASE WHEN $4 IN ('sent','partial') THEN NOW() ELSE sent_at END, errors=$5, deliveries=$6 WHERE id=$7`,
    [stats.sent, stats.failed, status, status, JSON.stringify(batchResults.errors), JSON.stringify(mergedDeliveries), broadcastId]
  );
  return { ...stats, status, mergedDeliveries };
}

function startEmailBroadcastJob(options) {
  const {
    broadcastId,
    recipients,
    subject,
    html,
    attachments,
    delay,
    batchSize,
    variable_fields,
    baseDeliveries,
    total,
  } = options;

  if (!acquireEmailBroadcastJob(broadcastId)) {
    return Promise.reject(new Error('Broadcast is already running'));
  }

  let mergedDeliveries = [...baseDeliveries];
  let lastDeliverySnapshotAt = 0;
  const deliverySnapshotEvery = Math.max(1, parseInt(process.env.BROADCAST_DELIVERY_SNAPSHOT_EVERY || '10', 10) || 10);

  return pool.query(`UPDATE email_broadcasts SET status='sending' WHERE id=$1`, [broadcastId])
    .then(() => eb.sendBroadcast(
      recipients,
      subject,
      html,
      async (_sent, _failed, _current, results) => {
        mergedDeliveries = mergeEmailDeliveries(baseDeliveries, results.deliveries);
        const stats = tallyDeliveries(mergedDeliveries);
        await pool.query(
          `UPDATE email_broadcasts SET sent=$1, failed=$2 WHERE id=$3`,
          [stats.sent, stats.failed, broadcastId]
        );
        const done = stats.sent + stats.failed;
        if (done - lastDeliverySnapshotAt >= deliverySnapshotEvery || done >= total) {
          lastDeliverySnapshotAt = done;
          await pool.query(
            `UPDATE email_broadcasts SET errors=$1, deliveries=$2 WHERE id=$3`,
            [JSON.stringify(results.errors), JSON.stringify(mergedDeliveries), broadcastId]
          );
        }
      },
      delay,
      attachments,
      batchSize,
      variable_fields
    ))
    .then(async (results) => {
      const final = await finalizeEmailBroadcastJob(broadcastId, results, baseDeliveries, total);
      console.log(`[Broadcast #${broadcastId}] Done — sent:${final.sent} failed:${final.failed} status:${final.status}`);
      return final;
    })
    .catch(async (err) => {
      console.error(`[Broadcast #${broadcastId}] Error:`, err.message);
      try {
        await pool.query(
          `UPDATE email_broadcasts SET status='partial', errors=$2 WHERE id=$1`,
          [broadcastId, JSON.stringify([{ error: err.message }])]
        );
      } catch (updateErr) {
        console.error(`[Broadcast #${broadcastId}] Failed status update failed:`, updateErr.message);
      }
      throw err;
    })
    .finally(() => {
      releaseEmailBroadcastJob(broadcastId);
    });
}

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, subject, total, sent, failed, status, created_at, sent_at
       FROM email_broadcasts ORDER BY created_at DESC LIMIT 50`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/test', async (req, res) => {
  const { to, subject, html, attachments, variable_fields } = req.body;
  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'to, subject, html required' });
  }
  try {
    const { normalizeFieldDefs, buildRecipientMap, substitute } = require('../services/emailTemplateVars');
    const fieldDefs = normalizeFieldDefs(variable_fields);
    const varMap = buildRecipientMap({ email: to, name: to.split('@')[0] || '' }, fieldDefs);
    const finalSubject = substitute(subject, varMap);
    const finalHtml = substitute(html, varMap);
    await eb.sendOne(to, finalSubject, finalHtml, null, attachments);
    res.json({ success: true, message: `Test email sent to ${to}`, attachments: Array.isArray(attachments) ? attachments.length : 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/verify', async (req, res) => {
  try {
    await eb.verifyConnection();
    res.json({ success: true, message: 'SMTP connection verified' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/send', async (req, res) => {
  const { subject, html, recipients, delay_ms, attachments, batch_size, variable_fields } = req.body;
  if (!subject || !html || !Array.isArray(recipients) || !recipients.length) {
    return res.status(400).json({ error: 'subject, html, recipients[] required' });
  }

  const pendingDeliveries = buildPendingDeliveries(recipients);
  const delay = parseInt(delay_ms || 2000, 10);
  const batchSize = Math.max(1, parseInt(batch_size || 1, 10) || 1);
  const safeAttachments = Array.isArray(attachments) ? attachments : [];
  const safeVariableFields = Array.isArray(variable_fields) ? variable_fields : [];

  let broadcastId;
  try {
    const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
    const result = await pool.query(
      `INSERT INTO email_broadcasts (subject, html_body, recipients, from_email, total, status, attachments, deliveries, delay_ms, batch_size, variable_fields)
       VALUES ($1,$2,$3,$4,$5,'sending',$6,$7,$8,$9,$10) RETURNING id`,
      [
        subject,
        html,
        JSON.stringify(recipients),
        fromEmail,
        recipients.length,
        JSON.stringify(safeAttachments),
        JSON.stringify(pendingDeliveries),
        delay,
        batchSize,
        JSON.stringify(safeVariableFields),
      ]
    );
    broadcastId = result.rows[0].id;
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  res.json({ success: true, broadcast_id: broadcastId, total: recipients.length });

  startEmailBroadcastJob({
    broadcastId,
    recipients,
    subject,
    html,
    attachments: safeAttachments,
    delay,
    batchSize,
    variable_fields: safeVariableFields,
    baseDeliveries: pendingDeliveries,
    total: recipients.length,
  }).catch(() => {});
});

router.post('/:id/resend', async (req, res) => {
  const broadcastId = parseInt(req.params.id, 10);
  if (!broadcastId) return res.status(400).json({ error: 'Invalid broadcast id' });

  try {
    const row = await pool.query(`SELECT * FROM email_broadcasts WHERE id=$1`, [broadcastId]);
    if (!row.rows.length) return res.status(404).json({ error: 'Broadcast not found' });
    const b = row.rows[0];

    if (!acquireEmailBroadcastJob(broadcastId)) {
      return res.status(409).json({ error: 'Broadcast is already sending. Wait for it to finish before resending.' });
    }
    releaseEmailBroadcastJob(broadcastId);

    const recipients = parseJsonField(b.recipients, []);
    const baseDeliveries = parseJsonField(b.deliveries, buildPendingDeliveries(recipients));
    const hasSentLog = baseDeliveries.some((d) => d.status === 'sent');
    if (!hasSentLog && (parseInt(b.sent || 0, 10) || 0) > 0) {
      return res.status(409).json({
        error: 'This broadcast has no per-recipient delivery log. Resend is blocked to prevent duplicate sends. Start a new broadcast for remaining contacts.',
      });
    }
    const toSend = buildUndeliveredEmailRecipients(recipients, baseDeliveries);

    if (!toSend.length) {
      return res.json({
        success: true,
        broadcast_id: broadcastId,
        queued: 0,
        message: 'All recipients already received this broadcast.',
      });
    }

    const delay = parseInt(req.body.delay_ms ?? b.delay_ms ?? 2000, 10);
    const batchSize = Math.max(1, parseInt(req.body.batch_size ?? b.batch_size ?? 1, 10) || 1);
    const attachments = parseJsonField(b.attachments, []);
    const variable_fields = parseJsonField(b.variable_fields, []);

    await pool.query(
      `UPDATE email_broadcasts SET status='sending', delay_ms=$2, batch_size=$3 WHERE id=$1`,
      [broadcastId, delay, batchSize]
    );

    res.json({
      success: true,
      broadcast_id: broadcastId,
      queued: toSend.length,
      skipped_sent: recipients.length - toSend.length,
      message: `Resuming broadcast for ${toSend.length} pending/failed recipient(s). Already-sent recipients are skipped.`,
    });

    startEmailBroadcastJob({
      broadcastId,
      recipients: toSend,
      subject: b.subject,
      html: b.html_body,
      attachments,
      delay,
      batchSize,
      variable_fields,
      baseDeliveries,
      total: recipients.length,
    }).catch(() => {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM email_broadcasts WHERE id=$1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM email_broadcasts WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

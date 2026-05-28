/**
 * Email Broadcast Routes
 */
const express  = require('express');
const pool     = require('../db/pool');
const eb       = require('../services/emailBroadcast');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ── ENSURE TABLE ──────────────────────────────────────────────────────────
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
}
ensureTable().catch(e => console.error('[Broadcast] Table init error:', e.message));

// ── GET /api/broadcast — list all broadcasts ──────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, subject, total, sent, failed, status, created_at, sent_at
       FROM email_broadcasts ORDER BY created_at DESC LIMIT 50`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/broadcast/:id — get single broadcast ─────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM email_broadcasts WHERE id=$1`, [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/broadcast/test — send test email ────────────────────────────
router.post('/test', async (req, res) => {
  const { to, subject, html, attachments } = req.body;
  if (!to || !subject || !html)
    return res.status(400).json({ error: 'to, subject, html required' });
  try {
    await eb.sendOne(to, subject, html, null, attachments);
    res.json({ success: true, message: `Test email sent to ${to}`, attachments: Array.isArray(attachments) ? attachments.length : 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/broadcast/verify — verify SMTP connection ───────────────────
router.post('/verify', async (req, res) => {
  try {
    await eb.verifyConnection();
    res.json({ success: true, message: 'SMTP connection verified' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/broadcast/send — create + send broadcast ───────────────────
// Body: { subject, html, recipients: [{email,name}] or ['email'], delay_ms }
router.post('/send', async (req, res) => {
  const { subject, html, recipients, delay_ms, attachments } = req.body;
  if (!subject || !html || !Array.isArray(recipients) || !recipients.length)
    return res.status(400).json({ error: 'subject, html, recipients[] required' });

  const pendingDeliveries = recipients.map((r) => {
    const email = typeof r === 'string' ? r : r.email;
    const name = typeof r === 'object' ? (r.name || '') : '';
    return { email, name, status: 'pending', sent_at: null };
  });

  // Save broadcast record
  let broadcastId;
  try {
    const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
    const result = await pool.query(
      `INSERT INTO email_broadcasts (subject, html_body, recipients, from_email, total, status, attachments, deliveries)
       VALUES ($1,$2,$3,$4,$5,'sending',$6,$7) RETURNING id`,
      [
        subject,
        html,
        JSON.stringify(recipients),
        fromEmail,
        recipients.length,
        JSON.stringify(Array.isArray(attachments) ? attachments : []),
        JSON.stringify(pendingDeliveries),
      ]
    );
    broadcastId = result.rows[0].id;
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Respond immediately — sending happens async
  res.json({ success: true, broadcast_id: broadcastId, total: recipients.length });

  // Send in background
  const delay = parseInt(delay_ms || 2000);
  eb.sendBroadcast(recipients, subject, html, async (sent, failed, _current, results) => {
    const doneByEmail = new Map(results.deliveries.map((d) => [String(d.email || '').toLowerCase(), d]));
    const mergedDeliveries = pendingDeliveries.map((d) => doneByEmail.get(String(d.email || '').toLowerCase()) || d);
    await pool.query(
      `UPDATE email_broadcasts SET sent=$1, failed=$2, errors=$3, deliveries=$4 WHERE id=$5`,
      [sent, failed, JSON.stringify(results.errors), JSON.stringify(mergedDeliveries), broadcastId]
    );
  }, delay, attachments)
    .then(async (results) => {
      try {
        await pool.query(
          `UPDATE email_broadcasts SET sent=$1, failed=$2, status='sent', sent_at=NOW(), errors=$3, deliveries=$4 WHERE id=$5`,
          [results.sent, results.failed, JSON.stringify(results.errors), JSON.stringify(results.deliveries), broadcastId]
        );
      } catch (err) {
        console.error(`[Broadcast #${broadcastId}] Final log update failed:`, err.message);
      }
      console.log(`[Broadcast #${broadcastId}] Done — sent:${results.sent} failed:${results.failed}`);
    })
    .catch(async (err) => {
      await pool.query(
        `UPDATE email_broadcasts SET status='failed' WHERE id=$1`, [broadcastId]
      );
      console.error(`[Broadcast #${broadcastId}] Error:`, err.message);
    });
});

// ── DELETE /api/broadcast/:id ─────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM email_broadcasts WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

const express = require('express');
const pool    = require('../db/pool');
const eb      = require('../services/emailBroadcast');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ── SELF-HEALING SCHEMA — add new columns if they don't exist ─────────────
async function ensureCampaignColumns() {
  const cols = [
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS goal VARCHAR(60)`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ab_test_enabled BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ab_subject_b VARCHAR(300)`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS open_rate NUMERIC(5,2) DEFAULT 0`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ctr NUMERIC(5,2) DEFAULT 0`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS bounce_rate NUMERIC(5,2) DEFAULT 0`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS unsubscribe_rate NUMERIC(5,2) DEFAULT 0`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sent_count INT DEFAULT 0`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS send_interval_ms INT DEFAULT 180000`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS timezone VARCHAR(60) DEFAULT 'Asia/Kolkata'`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS group_id INT`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS subject TEXT`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS body TEXT`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS deliveries JSONB DEFAULT '[]'`,
  ];
  for (const sql of cols) {
    await pool.query(sql).catch(() => {}); // ignore if already exists
  }
}
ensureCampaignColumns().catch(e => console.error('[Campaigns] Schema migration error:', e.message));

// GET /api/campaigns
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM campaigns ORDER BY created_at DESC`);
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch campaigns.' });
  }
});

// POST /api/campaigns
router.post('/', async (req, res) => {
  const { name, product, segment, channel, status, scheduled_at,
          goal, ab_test_enabled, ab_subject_b,
          send_interval_ms, timezone, group_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Campaign name is required.' });
  try {
    const result = await pool.query(`
      INSERT INTO campaigns (name,product,segment,channel,status,scheduled_at,goal,ab_test_enabled,ab_subject_b,send_interval_ms,timezone,group_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *
    `, [name, product||null, segment||'All', channel||'Email', status||'Draft',
        scheduled_at||null, goal||null, ab_test_enabled||false, ab_subject_b||null,
        send_interval_ms||180000, timezone||'Asia/Kolkata', group_id||null]);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create campaign.' });
  }
});

// PUT /api/campaigns/:id
router.put('/:id', async (req, res) => {
  const { name, product, segment, channel, status, progress, scheduled_at,
          goal, ab_test_enabled, ab_subject_b,
          send_interval_ms, timezone } = req.body;
  try {
    const result = await pool.query(`
      UPDATE campaigns SET name=$1,product=$2,segment=$3,channel=$4,status=$5,progress=$6,
        scheduled_at=$7,goal=$8,ab_test_enabled=$9,ab_subject_b=$10,
        send_interval_ms=$11,timezone=$12
      WHERE id=$13 RETURNING *
    `, [name, product, segment, channel, status, progress||0, scheduled_at||null,
        goal||null, ab_test_enabled||false, ab_subject_b||null,
        send_interval_ms||180000, timezone||'Asia/Kolkata', req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Campaign not found.' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update campaign.' });
  }
});

// PATCH /api/campaigns/:id/stats — update performance metrics
router.patch('/:id/stats', async (req, res) => {
  const { open_rate, ctr, bounce_rate, unsubscribe_rate, sent_count, status } = req.body;
  try {
    const fields = [];
    const vals = [];
    let i = 1;
    if (open_rate        !== undefined) { fields.push(`open_rate=$${i++}`);        vals.push(open_rate); }
    if (ctr              !== undefined) { fields.push(`ctr=$${i++}`);              vals.push(ctr); }
    if (bounce_rate      !== undefined) { fields.push(`bounce_rate=$${i++}`);      vals.push(bounce_rate); }
    if (unsubscribe_rate !== undefined) { fields.push(`unsubscribe_rate=$${i++}`); vals.push(unsubscribe_rate); }
    if (sent_count       !== undefined) { fields.push(`sent_count=$${i++}`);       vals.push(sent_count); }
    if (status           !== undefined) { fields.push(`status=$${i++}`);           vals.push(status); }
    if (!fields.length) return res.status(400).json({ error: 'No stats fields provided.' });
    vals.push(req.params.id);
    const result = await pool.query(
      `UPDATE campaigns SET ${fields.join(',')} WHERE id=$${i} RETURNING *`, vals
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Campaign not found.' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update stats.' });
  }
});

// GET /api/campaigns/:id — get single campaign
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM campaigns WHERE id=$1`, [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Campaign not found.' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch campaign.' });
  }
});

// POST /api/campaigns/:id/launch — fetch group members and send emails
router.post('/:id/launch', async (req, res) => {
  const { subject, html, group_id, attachments } = req.body;
  if (!subject || !html) return res.status(400).json({ error: 'subject and html are required to launch.' });

  let campaign;
  try {
    const r = await pool.query(`SELECT * FROM campaigns WHERE id=$1`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Campaign not found.' });
    campaign = r.rows[0];
  } catch (err) { return res.status(500).json({ error: err.message }); }

  // Resolve recipients — try group_id first, then campaign's stored segment
  let recipients = [];
  try {
    // Try group_id passed in request body first, then fall back to campaign's stored group_id
    const resolvedGroupId = group_id || campaign.group_id || null;
    if (resolvedGroupId) {
      const gRes = await pool.query(`
        SELECT c.fname, c.lname, c.company, c.email
        FROM recipient_group_members m
        JOIN contacts c ON c.id = m.contact_id
        WHERE m.group_id = $1 AND c.email IS NOT NULL AND c.email <> ''
      `, [resolvedGroupId]);
      recipients = gRes.rows.map(c => ({
        email: c.email,
        name: ((c.fname || '') + ' ' + (c.lname || '')).trim() || c.email.split('@')[0],
        company: c.company || '',
      }));
    }

    // If no group_id or group was empty, try looking up a group by the segment name
    if (!recipients.length && campaign.segment && campaign.segment !== 'All') {
      const grpRes = await pool.query(`
        SELECT c.fname, c.lname, c.company, c.email
        FROM recipient_groups g
        JOIN recipient_group_members m ON m.group_id = g.id
        JOIN contacts c ON c.id = m.contact_id
        WHERE LOWER(g.name) = LOWER($1) AND c.email IS NOT NULL AND c.email <> ''
      `, [campaign.segment]);
      recipients = grpRes.rows.map(c => ({
        email: c.email,
        name: ((c.fname || '') + ' ' + (c.lname || '')).trim() || c.email.split('@')[0],
        company: c.company || '',
      }));
    }

    // Final fallback — all contacts with email matching segment value, or all contacts
    if (!recipients.length) {
      const seg = campaign.segment && campaign.segment !== 'All' ? campaign.segment : null;
      const cRes = seg
        ? await pool.query(
            `SELECT fname, lname, company, email FROM contacts
             WHERE email IS NOT NULL AND email <> '' AND segment = $1 LIMIT 500`,
            [seg])
        : await pool.query(
            `SELECT fname, lname, company, email FROM contacts
             WHERE email IS NOT NULL AND email <> '' LIMIT 500`);
      recipients = cRes.rows.map(c => ({
        email: c.email,
        name: ((c.fname || '') + ' ' + (c.lname || '')).trim() || c.email.split('@')[0],
        company: c.company || '',
      }));
    }
  } catch (err) { return res.status(500).json({ error: 'Failed to load recipients: ' + err.message }); }

  // Guard: don't re-send if already Sending or Sent
  let priorDeliveries = campaign.deliveries || [];
  if (typeof priorDeliveries === 'string') {
    try { priorDeliveries = JSON.parse(priorDeliveries); } catch (_) { priorDeliveries = []; }
  }
  if (
    campaign.status === 'Sending' ||
    campaign.status === 'Sent' ||
    campaign.status === 'Paused' ||
    Number(campaign.sent_count || 0) > 0 ||
    (Array.isArray(priorDeliveries) && priorDeliveries.length > 0)
  ) {
    return res.status(400).json({ error: `Campaign has already been launched or is ${campaign.status}. Delete and recreate to send again.` });
  }

  if (!recipients.length) return res.status(400).json({ error: 'No recipients found for this campaign.' });

  const pendingDeliveries = recipients.map((r) => ({
    email: r.email,
    name: r.name || '',
    status: 'pending',
    sent_at: null,
    subject,
    body: html,
  }));

  const safeAttachments = Array.isArray(attachments) ? attachments : [];

  // Mark as sending and save the campaign content
  await pool.query(`UPDATE campaigns SET status='Sending', sent_count=$1, subject=$2, body=$3, attachments=$4, deliveries=$5 WHERE id=$6`,
    [recipients.length, subject, html, JSON.stringify(safeAttachments), JSON.stringify(pendingDeliveries), req.params.id]).catch((err) => {
      console.error(`[Campaign #${req.params.id}] Initial save failed:`, err.message);
    });

  // Respond immediately
  res.json({ success: true, total: recipients.length, message: `Sending to ${recipients.length} recipients…` });

  // Send in background
  const delayMs = parseInt(campaign.send_interval_ms || 180000);
  eb.sendBroadcast(recipients, subject, html, async (sent, failed, _current, results) => {
    const doneByEmail = new Map(results.deliveries.map((d) => [String(d.email || '').toLowerCase(), d]));
    const mergedDeliveries = pendingDeliveries.map((d) => doneByEmail.get(String(d.email || '').toLowerCase()) || d);
    await pool.query(`
      UPDATE campaigns SET progress=$1,
        bounce_rate=$2, deliveries=$3
      WHERE id=$4
    `, [
      parseFloat((((sent + failed) / recipients.length) * 100).toFixed(2)),
      failed > 0 ? parseFloat(((failed / recipients.length) * 100).toFixed(2)) : 0,
      JSON.stringify(mergedDeliveries),
      req.params.id,
    ]);
  }, delayMs, safeAttachments)
    .then(async (results) => {
      try {
        await pool.query(`
          UPDATE campaigns SET status='Sent', sent_count=$1, progress=100,
            bounce_rate=$2, subject=$3, body=$4, attachments=$5, deliveries=$6
          WHERE id=$7
        `, [results.sent,
            results.failed > 0 ? parseFloat(((results.failed / recipients.length) * 100).toFixed(2)) : 0,
            subject, html,
            JSON.stringify(safeAttachments),
            JSON.stringify(results.deliveries),
            req.params.id]);
      } catch (err) {
        console.error(`[Campaign #${req.params.id}] Final log update failed:`, err.message);
      }
      console.log(`[Campaign #${req.params.id}] Done — sent:${results.sent} failed:${results.failed}`);
    })
    .catch(async (err) => {
      await pool.query(`UPDATE campaigns SET status='Failed' WHERE id=$1`, [req.params.id]);
      console.error(`[Campaign #${req.params.id}] Error:`, err.message);
    });
});

// PATCH /api/campaigns/:id/pause — toggle pause/resume
router.patch('/:id/pause', async (req, res) => {
  try {
    const r = await pool.query(`SELECT status FROM campaigns WHERE id=$1`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Campaign not found.' });
    const current = r.rows[0].status;
    const next = current === 'Paused' ? 'Active' : 'Paused';
    const updated = await pool.query(
      `UPDATE campaigns SET status=$1 WHERE id=$2 RETURNING *`, [next, req.params.id]
    );
    return res.json(updated.rows[0]);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// DELETE /api/campaigns/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM campaigns WHERE id=$1 RETURNING id`, [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Campaign not found.' });
    return res.json({ message: 'Campaign deleted.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete campaign.' });
  }
});

module.exports = router;

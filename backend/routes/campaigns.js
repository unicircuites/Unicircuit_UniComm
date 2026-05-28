const express = require('express');
const pool    = require('../db/pool');
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
          goal, ab_test_enabled, ab_subject_b } = req.body;
  if (!name) return res.status(400).json({ error: 'Campaign name is required.' });
  try {
    const result = await pool.query(`
      INSERT INTO campaigns (name,product,segment,channel,status,scheduled_at,goal,ab_test_enabled,ab_subject_b)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [name, product||null, segment||'All', channel||'Email', status||'Draft',
        scheduled_at||null, goal||null, ab_test_enabled||false, ab_subject_b||null]);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create campaign.' });
  }
});

// PUT /api/campaigns/:id
router.put('/:id', async (req, res) => {
  const { name, product, segment, channel, status, progress, scheduled_at,
          goal, ab_test_enabled, ab_subject_b } = req.body;
  try {
    const result = await pool.query(`
      UPDATE campaigns SET name=$1,product=$2,segment=$3,channel=$4,status=$5,progress=$6,
        scheduled_at=$7,goal=$8,ab_test_enabled=$9,ab_subject_b=$10
      WHERE id=$11 RETURNING *
    `, [name, product, segment, channel, status, progress||0, scheduled_at||null,
        goal||null, ab_test_enabled||false, ab_subject_b||null, req.params.id]);
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

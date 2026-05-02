/**
 * Email Templates Routes
 */
const express = require('express');
const pool    = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_templates (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(300) NOT NULL,
      subject     VARCHAR(500),
      html_body   TEXT NOT NULL,
      category    VARCHAR(100) DEFAULT 'General',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}
ensureTable().catch(e => console.error('[Templates] Table init error:', e.message));

// GET all templates
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, name, subject, category, created_at FROM email_templates ORDER BY created_at DESC`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET single template
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM email_templates WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create template
router.post('/', async (req, res) => {
  const { name, subject, html_body, category } = req.body;
  if (!name || !html_body) return res.status(400).json({ error: 'name and html_body required' });
  try {
    const r = await pool.query(
      `INSERT INTO email_templates (name, subject, html_body, category) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, subject||'', html_body, category||'General']
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT update template
router.put('/:id', async (req, res) => {
  const { name, subject, html_body, category } = req.body;
  try {
    const r = await pool.query(
      `UPDATE email_templates SET name=$1, subject=$2, html_body=$3, category=$4, updated_at=NOW() WHERE id=$5 RETURNING *`,
      [name, subject||'', html_body, category||'General', req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE template
router.delete('/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM email_templates WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

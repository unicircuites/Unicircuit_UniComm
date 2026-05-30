/**
 * Email Templates Routes
 */
const express = require('express');
const pool    = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { seedEmailTemplates } = require('../data/emailTemplateStorage');

const router = express.Router();
router.use(authenticate);

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_templates (
      id          SERIAL PRIMARY KEY,
      slug        VARCHAR(180),
      name        VARCHAR(300) NOT NULL,
      subject     VARCHAR(500),
      html_body   TEXT NOT NULL,
      category    VARCHAR(100) DEFAULT 'General',
      variable_fields JSONB DEFAULT '[]'::jsonb,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS slug VARCHAR(180)`);
  await pool.query(`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS variable_fields JSONB DEFAULT '[]'::jsonb`);
  await pool.query(`UPDATE email_templates SET variable_fields='[]'::jsonb WHERE variable_fields IS NULL`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS email_templates_slug_idx
    ON email_templates (slug)
    WHERE slug IS NOT NULL
  `);

  await seedDefaultTemplates();
}

async function seedDefaultTemplates() {
  for (const tpl of seedEmailTemplates) {
    await pool.query(
      `INSERT INTO email_templates (slug, name, subject, html_body, category, variable_fields)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (slug) WHERE slug IS NOT NULL DO UPDATE SET
         name = EXCLUDED.name,
         subject = EXCLUDED.subject,
         html_body = EXCLUDED.html_body,
         category = EXCLUDED.category,
         variable_fields = EXCLUDED.variable_fields,
         updated_at = NOW()`,
      [
        tpl.slug,
        tpl.name,
        tpl.subject || '',
        tpl.html_body,
        tpl.category || 'General',
        JSON.stringify(tpl.variable_fields || [])
      ]
    );
  }
}

ensureTable().catch(e => console.error('[Templates] Table init error:', e.message));

// GET all templates
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, slug, name, subject, category, variable_fields, created_at FROM email_templates ORDER BY created_at DESC`);
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
  const { name, subject, html_body, category, variable_fields } = req.body;
  if (!name || !html_body) return res.status(400).json({ error: 'name and html_body required' });
  try {
    const r = await pool.query(
      `INSERT INTO email_templates (name, subject, html_body, category, variable_fields) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *`,
      [name, subject||'', html_body, category||'General', JSON.stringify(variable_fields || [])]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT update template
router.put('/:id', async (req, res) => {
  const { name, subject, html_body, category, variable_fields } = req.body;
  const variableFieldsJson = Object.prototype.hasOwnProperty.call(req.body, 'variable_fields')
    ? JSON.stringify(variable_fields || [])
    : null;
  try {
    const r = await pool.query(
      `UPDATE email_templates SET name=$1, subject=$2, html_body=$3, category=$4, variable_fields=COALESCE($5::jsonb, variable_fields), updated_at=NOW() WHERE id=$6 RETURNING *`,
      [name, subject||'', html_body, category||'General', variableFieldsJson, req.params.id]
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

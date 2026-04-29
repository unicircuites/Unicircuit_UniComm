const express = require('express');
const pool    = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

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
  const { name, product, segment, channel, status, scheduled_at } = req.body;
  if (!name) return res.status(400).json({ error: 'Campaign name is required.' });
  try {
    const result = await pool.query(`
      INSERT INTO campaigns (name,product,segment,channel,status,scheduled_at)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [name, product||null, segment||'All', channel||'Email', status||'Draft', scheduled_at||null]);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create campaign.' });
  }
});

// PUT /api/campaigns/:id
router.put('/:id', async (req, res) => {
  const { name, product, segment, channel, status, progress, scheduled_at } = req.body;
  try {
    const result = await pool.query(`
      UPDATE campaigns SET name=$1,product=$2,segment=$3,channel=$4,status=$5,progress=$6,scheduled_at=$7
      WHERE id=$8 RETURNING *
    `, [name, product, segment, channel, status, progress||0, scheduled_at||null, req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Campaign not found.' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update campaign.' });
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

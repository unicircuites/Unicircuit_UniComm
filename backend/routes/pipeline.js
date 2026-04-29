const express = require('express');
const pool    = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/pipeline
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM pipeline_deals ORDER BY score DESC, created_at DESC`);
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch pipeline.' });
  }
});

// POST /api/pipeline
router.post('/', async (req, res) => {
  const { name, company, value, stage, score, owner, due_date } = req.body;
  if (!name) return res.status(400).json({ error: 'Deal name is required.' });
  try {
    const result = await pool.query(`
      INSERT INTO pipeline_deals (name,company,value,stage,score,owner,due_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [name, company||null, value||null, stage||'Prospect', score||50, owner||null, due_date||null]);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create deal.' });
  }
});

// PUT /api/pipeline/:id
router.put('/:id', async (req, res) => {
  const { name, company, value, stage, score, owner, due_date } = req.body;
  try {
    const result = await pool.query(`
      UPDATE pipeline_deals SET name=$1,company=$2,value=$3,stage=$4,score=$5,owner=$6,due_date=$7
      WHERE id=$8 RETURNING *
    `, [name, company, value, stage, score, owner, due_date, req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Deal not found.' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update deal.' });
  }
});

// DELETE /api/pipeline/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM pipeline_deals WHERE id=$1 RETURNING id`, [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Deal not found.' });
    return res.json({ message: 'Deal deleted.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete deal.' });
  }
});

module.exports = router;

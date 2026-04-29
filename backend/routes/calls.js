const express = require('express');
const pool    = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/calls
router.get('/', async (req, res) => {
  const limit  = parseInt(req.query.limit  || '50');
  const offset = parseInt(req.query.offset || '0');
  try {
    const result = await pool.query(
      `SELECT * FROM call_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const total = await pool.query(`SELECT COUNT(*) FROM call_logs`);
    return res.json({ calls: result.rows, total: parseInt(total.rows[0].count) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch call logs.' });
  }
});

// POST /api/calls
router.post('/', async (req, res) => {
  const { caller, extension, destination, duration, call_type, ai_summary } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO call_logs (caller,extension,destination,duration,call_type,ai_summary)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [caller||null, extension||null, destination||null, duration||null, call_type||'Out', ai_summary||null]);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to log call.' });
  }
});

// PATCH /api/calls/:id/summary
router.patch('/:id/summary', async (req, res) => {
  const { ai_summary } = req.body;
  try {
    const result = await pool.query(
      `UPDATE call_logs SET ai_summary=$1 WHERE id=$2 RETURNING *`,
      [ai_summary, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Call log not found.' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update summary.' });
  }
});

module.exports = router;

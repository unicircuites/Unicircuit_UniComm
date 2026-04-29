const express = require('express');
const pool    = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/dashboard/stats — aggregated KPIs
router.get('/stats', async (req, res) => {
  try {
    const [contacts, calls, campaigns, pipeline] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN last_contact='Today' THEN 1 ELSE 0 END) AS new_today
        FROM contacts
      `),
      pool.query(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN call_type='Missed' THEN 1 ELSE 0 END) AS missed
        FROM call_logs
      `),
      pool.query(`SELECT COUNT(*) AS active FROM campaigns WHERE status IN ('Active','Live')`),
      pool.query(`
        SELECT COUNT(*) AS deals,
               SUM(CASE WHEN stage='Won' THEN 1 ELSE 0 END) AS won
        FROM pipeline_deals
      `),
    ]);

    return res.json({
      contacts: {
        total:     parseInt(contacts.rows[0].total),
        new_today: parseInt(contacts.rows[0].new_today || 0),
      },
      calls: {
        total:  parseInt(calls.rows[0].total),
        missed: parseInt(calls.rows[0].missed || 0),
      },
      campaigns: {
        active: parseInt(campaigns.rows[0].active),
      },
      pipeline: {
        deals: parseInt(pipeline.rows[0].deals),
        won:   parseInt(pipeline.rows[0].won || 0),
      },
    });
  } catch (err) {
    console.error('[Dashboard] Stats error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch stats.' });
  }
});

module.exports = router;

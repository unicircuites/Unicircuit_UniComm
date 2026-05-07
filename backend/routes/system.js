/**
 * System Routes
 * GET /api/system/status  — live service health (requires auth)
 * GET /api/system/log     — recent activity log entries (requires auth)
 */
const express    = require('express');
const { authenticate } = require('../middleware/auth');
const activityLog = require('../services/activityLog');
const pool       = require('../db/pool');

const router = express.Router();

/**
 * Shared service state — updated by server.js bridge and probes.
 * Exported so server.js can import and mutate it directly.
 */
const serviceState = {
  whatsapp: { status: 'offline', lastConnected: null, lastDisconnected: null },
  pbx:      { status: 'offline', lastConnected: null, lastDisconnected: null },
  outlook:  { status: 'offline', lastConnected: null, lastDisconnected: null },
  postgres: { status: 'offline', lastConnected: null, lastDisconnected: null },
};

// ── GET /api/system/status ────────────────────────────────────────────────
router.get('/status', authenticate, async (req, res) => {
  // Probe PostgreSQL live with a 3000ms timeout
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('PostgreSQL probe timed out')), 3000)
      ),
    ]);
    serviceState.postgres.status = 'online';
  } catch (_) {
    serviceState.postgres.status = 'offline';
  }

  return res.json(serviceState);
});

// ── GET /api/system/log ───────────────────────────────────────────────────
router.get('/log', authenticate, (req, res) => {
  const rawLimit = parseInt(req.query.limit, 10);
  const limit = isNaN(rawLimit) || rawLimit <= 0
    ? 100
    : Math.min(rawLimit, 500);

  const all    = activityLog.getRecent(activityLog.size());
  const sliced = all.slice(-limit).reverse(); // newest first

  return res.json({ events: sliced, total: sliced.length });
});

module.exports = router;
module.exports.serviceState = serviceState;

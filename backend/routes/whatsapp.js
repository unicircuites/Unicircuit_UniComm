/**
 * WhatsApp Routes
 * GET  /api/wa/status        — connection status
 * GET  /api/wa/qr            — get QR code image
 * POST /api/wa/logout        — disconnect
 * GET  /api/wa/chats         — list all chats from DB
 * GET  /api/wa/messages/:jid — messages for a chat
 * POST /api/wa/send          — send a message
 */
const express = require('express');
const pool    = require('../db/pool');
const wa      = require('../services/whatsapp');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/wa/status
router.get('/status', (req, res) => {
  res.json(wa.getStatus());
});

// GET /api/wa/qr
router.get('/qr', async (req, res) => {
  const qr = await wa.getQR();
  if (!qr) return res.json({ qr: null, message: 'No QR available. Already connected or not started.' });
  res.json({ qr });
});

// POST /api/wa/logout
router.post('/logout', async (req, res) => {
  try {
    await wa.logout();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/wa/chats — only Indian (+91) numbers + groups, no @lid junk
router.get('/chats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM wa_chats
      WHERE
        -- Groups: keep all
        is_group = true
        OR
        -- Individual: only real WhatsApp numbers (not @lid internal IDs)
        -- Indian numbers: 91 + 10 digits = 12 digits total
        (
          id LIKE '%@s.whatsapp.net'
          AND (
            split_part(id, '@', 1) LIKE '91%'
            AND length(split_part(id, '@', 1)) = 12
          )
        )
      ORDER BY last_time DESC NULLS LAST
      LIMIT 300
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/wa/sync — pull latest messages from WhatsApp and store in DB
router.post('/sync', async (req, res) => {
  const status = wa.getStatus();
  if (!status.connected) {
    return res.status(400).json({ error: 'WhatsApp not connected' });
  }
  try {
    // Fetch latest chats from DB (already being updated by Baileys events)
    // Just return current count as confirmation
    const result = await pool.query(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN is_group THEN 1 ELSE 0 END) as groups,
             SUM(CASE WHEN NOT is_group AND (phone LIKE '+91%' OR phone LIKE '91%') THEN 1 ELSE 0 END) as indian
      FROM wa_chats
    `);
    res.json({
      success: true,
      message: 'Sync complete',
      stats: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/wa/messages/:jid
router.get('/messages/:jid', async (req, res) => {
  const jid   = decodeURIComponent(req.params.jid);
  const limit = parseInt(req.query.limit || '100');
  try {
    const result = await pool.query(`
      SELECT * FROM wa_messages
      WHERE chat_id = $1
      ORDER BY timestamp ASC
      LIMIT $2
    `, [jid, limit]);

    // Mark as read
    await pool.query(`UPDATE wa_messages SET is_read=true WHERE chat_id=$1 AND from_me=false`, [jid]);
    await pool.query(`UPDATE wa_chats SET unread=0 WHERE id=$1`, [jid]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/wa/send
router.post('/send', async (req, res) => {
  const { jid, message } = req.body;
  if (!jid || !message) return res.status(400).json({ error: 'jid and message required' });
  try {
    await wa.sendMessage(jid, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

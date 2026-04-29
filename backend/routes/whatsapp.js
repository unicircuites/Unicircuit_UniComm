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

// GET /api/wa/chats
router.get('/chats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM wa_chats
      ORDER BY last_time DESC NULLS LAST
      LIMIT 100
    `);
    res.json(result.rows);
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

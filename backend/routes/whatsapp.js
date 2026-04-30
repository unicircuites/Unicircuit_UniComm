/**
 * WhatsApp Routes
 */
const express = require('express');
const pool    = require('../db/pool');
const wa      = require('../services/whatsapp');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ── PUBLIC (no auth) ──────────────────────────────────────────────────────
router.get('/qr',     async (req, res) => { res.json({ qr: await wa.getQR() || null }); });
router.get('/status', (req, res)       => { res.json(wa.getStatus()); });

// ── PROTECTED ─────────────────────────────────────────────────────────────
router.post('/logout', authenticate, async (req, res) => {
  try { await wa.logout(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/chats', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM wa_chats
      WHERE
        -- Groups: real WhatsApp groups only
        (is_group = true AND id LIKE '%@g.us')
        OR
        -- Individual: only Indian +91 numbers on real WhatsApp
        (
          id LIKE '%@s.whatsapp.net'
          AND split_part(id,'@',1) LIKE '91%'
          AND length(split_part(id,'@',1)) = 12
        )
      ORDER BY last_time DESC NULLS LAST LIMIT 300
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/sync', authenticate, async (req, res) => {
  if (!wa.getStatus().connected) return res.status(400).json({ error: 'WhatsApp not connected' });
  try {
    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_group) AS groups,
        COUNT(*) FILTER (WHERE NOT is_group AND id LIKE '%@s.whatsapp.net'
          AND split_part(id,'@',1) LIKE '91%' AND length(split_part(id,'@',1))=12) AS indian_numbers,
        COALESCE(SUM(unread) FILTER (WHERE NOT is_group AND id LIKE '%@s.whatsapp.net'
          AND split_part(id,'@',1) LIKE '91%' AND length(split_part(id,'@',1))=12), 0) AS unread_individual,
        COALESCE(SUM(unread) FILTER (WHERE is_group), 0) AS unread_groups
      FROM wa_chats
    `);
    res.json({ success: true, stats: stats.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/group/:jid', authenticate, async (req, res) => {
  try {
    res.json(await wa.getGroupMetadata(decodeURIComponent(req.params.jid)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/messages/:jid', authenticate, async (req, res) => {
  const jid   = decodeURIComponent(req.params.jid);
  const limit = parseInt(req.query.limit || '100');
  try {
    const result = await pool.query(
      `SELECT * FROM wa_messages WHERE chat_id=$1 ORDER BY timestamp ASC LIMIT $2`,
      [jid, limit]
    );
    await pool.query(`UPDATE wa_messages SET is_read=true WHERE chat_id=$1 AND from_me=false`, [jid]);
    await pool.query(`UPDATE wa_chats SET unread=0 WHERE id=$1`, [jid]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/send', authenticate, async (req, res) => {
  const { jid, message, quotedMsgId } = req.body;
  if (!jid || !message) return res.status(400).json({ error: 'jid and message required' });
  try {
    await wa.sendMessage(jid, message, quotedMsgId || null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/media/:msgId', authenticate, async (req, res) => {
  try {
    const { buffer, mime, filename } = await wa.downloadMedia(req.params.msgId);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) { res.status(404).json({ error: err.message }); }
});

module.exports = router;

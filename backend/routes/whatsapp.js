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
        OR
        -- LID (Linked Identity) chats — only show if they have a real name (not own device)
        (
          id LIKE '%@lid'
          AND name IS NOT NULL
          AND name NOT LIKE '+%'
          AND length(name) > 0
        )
        OR
        -- Imported chats (from WhatsApp Export)
        id LIKE 'import_%'
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
    let jid = decodeURIComponent(req.params.jid);
    // Fix double domain suffix
    jid = jid.replace(/@g\.us@g\.us$/, '@g.us').replace(/@s\.whatsapp\.net@s\.whatsapp\.net$/, '@s.whatsapp.net');
    res.json(await wa.getGroupMetadata(jid));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/messages/:jid', authenticate, async (req, res) => {
  const jid   = decodeURIComponent(req.params.jid);
  const limit = parseInt(req.query.limit || '100');
  try {
    // For @lid JIDs, also search by the LID number as phone JID
    // e.g. 183357119950912@lid -> also try 183357119950912@s.whatsapp.net
    const lidNum = jid.endsWith('@lid') ? jid.split('@')[0] : null;
    const result = await pool.query(
      `SELECT m.*,
        CASE
          WHEN m.sender LIKE '%@lid' AND c.phone IS NOT NULL AND c.phone ~ '^[0-9]{7,15}$'
            THEN CASE
              WHEN c.phone LIKE '91%' AND length(c.phone) = 12
              THEN '+91 ' || substring(c.phone, 3, 5) || ' ' || substring(c.phone, 8, 5)
              ELSE '+' || c.phone
            END
          WHEN m.sender NOT LIKE '%@lid' AND m.sender NOT LIKE '%@g.us' AND m.sender IS NOT NULL
            THEN CASE
              WHEN split_part(m.sender,'@',1) LIKE '91%' AND length(split_part(m.sender,'@',1)) = 12
              THEN '+91 ' || substring(split_part(m.sender,'@',1), 3, 5) || ' ' || substring(split_part(m.sender,'@',1), 8, 5)
              ELSE '+' || split_part(m.sender,'@',1)
            END
          ELSE NULL
        END AS sender_phone
       FROM (
         SELECT * FROM wa_messages 
         WHERE chat_id=$1
            OR chat_id LIKE split_part($1, '@', 1) || ':%@' || split_part($1, '@', 2)
            OR ($3::text IS NOT NULL AND (
              chat_id = $3 || '@s.whatsapp.net'
              OR chat_id LIKE $3 || ':%@s.whatsapp.net'
            ))
         ORDER BY timestamp DESC LIMIT $2
       ) m
       LEFT JOIN wa_contacts c ON c.jid = m.sender
       ORDER BY m.timestamp ASC`,
      [jid, limit, lidNum]
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

router.get('/media/:msgId', async (req, res) => {
  // Support token via query param for <img src> / <audio src> direct links
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = 'Bearer ' + req.query.token;
  }
  try {
    const { buffer, mime, filename } = await wa.downloadMedia(req.params.msgId);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buffer);
  } catch (err) { res.status(404).json({ error: err.message }); }
});

// ── WhatsApp Export Chat Import ────────────────────────────────────────────
router.post('/import-chat', authenticate, async (req, res) => {
  try {
    const { chatText, chatJid, mediaFiles, clearOld } = req.body;
    if (!chatText || typeof chatText !== 'string') {
      return res.status(400).json({ error: 'chatText is required' });
    }
    if (!chatJid) {
      return res.status(400).json({ error: 'chatJid is required' });
    }

    const result = await wa.importExportedChat(chatText, chatJid, mediaFiles, clearOld);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[WA-Import] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

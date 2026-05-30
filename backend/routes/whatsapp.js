/**
 * WhatsApp Routes
 */
const express = require('express');
const pool    = require('../db/pool');
const wa      = require('../services/whatsapp');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// -- PUBLIC (no auth) -------------------------------------------------------
router.get('/qr',     async (req, res) => { res.json({ qr: await wa.requestQR() || null }); });
router.get('/status', (req, res)       => { res.json(wa.getStatus()); });

// -- PROTECTED --------------------------------------------------------------
router.post('/logout', authenticate, async (req, res) => {
  try { await wa.logout(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/wa/lid-map - returns LID number -> {name, phone} map for @mention replacement
router.get('/lid-map', authenticate, async (req, res) => {
  try {
    // Merge wa_chats + wa_contacts to cover ALL LID contacts:
    // - wa_chats: LIDs that have a direct chat
    // - wa_contacts: LIDs that are group-only members, never had a direct chat
    // UNION gives full coverage for any group size, any number of members
    const result = await pool.query(`
      SELECT lid_num, name, phone FROM (
        SELECT
          split_part(id, '@', 1) AS lid_num,
          name,
          phone
        FROM wa_chats
        WHERE id LIKE '%@lid'
          AND phone IS NOT NULL AND phone != ''
          AND account_phone = $1
        UNION
        SELECT
          split_part(jid, '@', 1) AS lid_num,
          name,
          phone
        FROM wa_contacts
        WHERE jid LIKE '%@lid'
          AND phone IS NOT NULL AND phone != ''
          AND phone ~ '^[0-9]'
          AND account_phone = $1
      ) combined
    `, [wa.getConnectedPhone() || 'unknown']);
    const map = {};
    result.rows.forEach(r => {
      // Format phone for display if it's raw digits
      let phone = r.phone || '';
      if (phone && !phone.startsWith('+')) {
        if (phone.startsWith('91') && phone.length === 12) {
          phone = '+91 ' + phone.slice(2, 7) + ' ' + phone.slice(7);
        } else {
          phone = '+' + phone;
        }
      }
      map[r.lid_num] = { name: r.name, phone };
    });
    res.json(map);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/chats', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id,
        c.account_phone,
        c.name,
        c.phone,
        c.is_group,
        COALESCE(NULLIF(latest.body, ''), NULLIF(c.last_message, ''), c.last_message) AS last_message,
        COALESCE(latest.timestamp, c.last_time) AS last_time,
        c.unread,
        c.updated_at,
        c.imported_last_ts
      FROM wa_chats c
      LEFT JOIN LATERAL (
        SELECT body, timestamp
        FROM wa_messages m
        WHERE m.chat_id = c.id AND m.account_phone = c.account_phone
        ORDER BY m.timestamp DESC NULLS LAST
        LIMIT 1
      ) latest ON true
      WHERE c.account_phone = $1 AND (
        -- Groups: real WhatsApp groups only
        (c.id LIKE '%@g.us')
        OR
        -- Individual: only Indian +91 numbers on real WhatsApp
        (
          c.id LIKE '%@s.whatsapp.net'
          AND split_part(c.id,'@',1) LIKE '91%'
          AND length(split_part(c.id,'@',1)) = 12
        )
        OR
        -- LID chats: only show if named AND no matching @s.whatsapp.net chat exists
        -- This prevents duplicates when mobile (s.whatsapp.net) and web (LID) show same contact
        (
          c.id LIKE '%@lid'
          AND c.name IS NOT NULL
          AND c.name NOT LIKE '+%'
          AND length(c.name) > 0
          AND NOT EXISTS (
            SELECT 1 FROM wa_chats c2
            WHERE c2.account_phone = $1
              AND c2.id LIKE '%@s.whatsapp.net'
              AND (
                c2.name = c.name
                OR (c.phone IS NOT NULL AND c2.phone = c.phone)
              )
          )
        )
        OR
        -- Imported chats (from WhatsApp Export)
        c.id LIKE 'import_%'
      )
      ORDER BY last_time DESC NULLS LAST LIMIT 300
    `, [wa.getConnectedPhone() || 'unknown']);
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
      WHERE account_phone = $1
    `, [wa.getConnectedPhone() || 'unknown']);
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
  const jid   = decodeURIComponent(req.params.jid).replace(/@g\.us@g\.us$/, '@g.us').replace(/@s\.whatsapp\.net@s\.whatsapp\.net$/, '@s.whatsapp.net');
  const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 200);
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  try {
    // If this is a group chat, populate LID phone numbers from group metadata first
    if (jid.endsWith('@g.us')) {
      try {
        const groupMeta = await wa.getGroupMetadata(jid);
        let updated = 0;
        const accPhone = wa.getConnectedPhone() || 'unknown';
        for (const p of groupMeta.participants) {
          if (p.jid && p.jid.endsWith('@lid') && p.phone) {
            const realPhone = p.phone.replace(/[^0-9]/g, '');
            if (realPhone && realPhone.length >= 7) {
              await pool.query(`
                INSERT INTO wa_contacts (jid, account_phone, name, phone)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (jid, account_phone) DO UPDATE SET
                  phone = EXCLUDED.phone,
                  name = COALESCE(EXCLUDED.name, wa_contacts.name),
                  updated_at = NOW()
              `, [p.jid, accPhone, p.name, realPhone]);
              updated++;
            }
          }
        }
        if (updated > 0) console.log(`[WA] Updated ${updated} LID contacts for group ${jid}`);
      } catch (metaErr) {
        console.warn(`[WA] Failed to fetch group metadata for ${jid}:`, metaErr.message);
      }
    }
    
    // For @lid JIDs, also search by the LID number as phone JID
    // e.g. 183357119950912@lid -> also try 183357119950912@s.whatsapp.net
    const lidNum = jid.endsWith('@lid') ? jid.split('@')[0] : null;
    const beforeIsValid = before && !Number.isNaN(before.getTime());
    const result = await pool.query(
      `SELECT m.*,
        CASE
          WHEN m.sender LIKE '%@lid' AND c.phone IS NOT NULL AND c.phone ~ '^[0-9]{7,}$'
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
         WHERE account_phone=$4 AND (
              chat_id=$1
              OR chat_id LIKE split_part($1, '@', 1) || ':%@' || split_part($1, '@', 2)
              OR ($3::text IS NOT NULL AND (
                chat_id = $3 || '@s.whatsapp.net'
                OR chat_id LIKE $3 || ':%@s.whatsapp.net'
              ))
            )
            AND ($5::timestamptz IS NULL OR timestamp < $5::timestamptz)
         ORDER BY timestamp DESC LIMIT $2
       ) m
       LEFT JOIN wa_contacts c ON c.jid = m.sender AND c.account_phone=$4
       ORDER BY m.timestamp ASC`,
      [jid, limit, lidNum, wa.getConnectedPhone() || 'unknown', beforeIsValid ? before.toISOString() : null]
    );
    const accPhone = wa.getConnectedPhone() || 'unknown';
    await pool.query(`UPDATE wa_messages SET is_read=true WHERE chat_id=$1 AND account_phone=$2 AND from_me=false`, [jid, accPhone]);
    await pool.query(`UPDATE wa_chats SET unread=0 WHERE id=$1 AND account_phone=$2`, [jid, accPhone]);
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

router.post('/broadcast', authenticate, async (req, res) => {
  const { recipients, message, delay_ms, attachments } = req.body;
  const targets = Array.isArray(recipients) ? recipients : [];
  const text = String(message || '').trim();
  const files = Array.isArray(attachments) ? attachments.slice(0, 10) : [];

  if (!targets.length) return res.status(400).json({ error: 'recipients[] required' });
  if (!text && !files.length) return res.status(400).json({ error: 'message or attachments required' });

  const ownPhone = String(wa.getConnectedPhone() || '').replace(/\D/g, '');

  function normalizeBroadcastJid(value) {
    const jid = String(value || '').trim();
    if (!jid) return '';
    if (jid.endsWith('@g.us') || jid.endsWith('@lid')) return jid;
    if (jid.endsWith('@s.whatsapp.net')) {
      const phone = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
      return phone ? `${phone}@s.whatsapp.net` : jid;
    }
    const phone = jid.replace(/\D/g, '');
    return phone ? `${phone}@s.whatsapp.net` : jid;
  }

  const normalized = [];
  const seen = new Set();
  for (const item of targets) {
    const rawJid = normalizeBroadcastJid(typeof item === 'string' ? item : item?.jid || '');
    if (!rawJid || !rawJid.includes('@')) continue;
    const phone = rawJid.endsWith('@s.whatsapp.net') ? rawJid.split('@')[0].split(':')[0].replace(/\D/g, '') : '';
    if (ownPhone && phone && phone === ownPhone) continue;
    const dedupeKey = rawJid.endsWith('@g.us') ? `group:${rawJid}` : (phone ? `phone:${phone}` : `jid:${rawJid}`);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push({ jid: rawJid, name: typeof item === 'object' ? item.name || '' : '' });
  }
  if (!normalized.length) return res.status(400).json({ error: 'No valid WhatsApp recipients found' });

  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const delay = Math.max(500, Math.min(parseInt(delay_ms || 2000, 10) || 2000, 24 * 60 * 60 * 1000));

  res.json({ success: true, total: normalized.length, queued: normalized.length });

  (async () => {
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < normalized.length; i++) {
      const target = normalized[i];
      try {
        if (files.length) {
          for (let f = 0; f < files.length; f++) {
            const att = files[f] || {};
            const buffer = Buffer.from(String(att.contentBytes || att.data || '').replace(/^data:[^,]+,/, ''), 'base64');
            if (!buffer.length) continue;
            const mime = att.contentType || att.mimeType || 'application/octet-stream';
            const mediaType = String(att.mediaType || '').toLowerCase()
              || (String(mime).startsWith('image/') ? 'image'
                : String(mime).startsWith('video/') ? 'video'
                  : 'document');
            await wa.sendMediaMessage(target.jid, {
              buffer,
              filename: att.name || att.fileName || 'broadcast-attachment',
              mimetype: mime,
              mediaType,
              caption: f === 0 ? text : '',
            }, null);
            if (f < files.length - 1) await wait(800);
          }
        } else {
          await wa.sendMessage(target.jid, text, null);
        }
        sent += 1;
      } catch (err) {
        failed += 1;
        console.error(`[WA Broadcast] Failed for ${target.jid}:`, err.message);
      }
      if (i < normalized.length - 1) await wait(delay);
    }
    console.log(`[WA Broadcast] Done - sent:${sent} failed:${failed}`);
  })().catch(err => console.error('[WA Broadcast] Worker error:', err.message));
});

router.post('/send-media', authenticate, async (req, res) => {
  const { jid, fileName, mimeType, mediaType, data, caption, quotedMsgId } = req.body;
  if (!jid || !fileName || !mimeType || !data) {
    return res.status(400).json({ error: 'jid, fileName, mimeType, and data are required' });
  }

  const allowed = ['image', 'video', 'document', 'sticker'];
  if (mediaType && !allowed.includes(String(mediaType).toLowerCase())) {
    return res.status(400).json({ error: 'mediaType must be image, video, document, or sticker' });
  }

  try {
    const base64 = String(data).includes(',') ? String(data).split(',').pop() : String(data);
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'Invalid media data' });

    const result = await wa.sendMediaMessage(jid, {
      buffer,
      filename: fileName,
      mimetype: mimeType,
      mediaType,
      caption,
    }, quotedMsgId || null);

    res.json({ success: true, message: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// -- WhatsApp Export Chat Import -------------------------------------------
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

/**
 * WhatsApp Routes
 */
const express = require('express');
const pool    = require('../db/pool');
const wa      = require('../services/whatsapp');
const waInventory = require('../services/whatsappInventory');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const WA_DEBUG_ACCOUNT_SCOPE = String(process.env.WA_DEBUG_ACCOUNT_SCOPE || 'false').toLowerCase() === 'true';

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function isAllowedWaNumber(value) {
  const digits = normalizeDigits(value);
  if (!digits) return false;
  // Allowed:
  // 1) Indian WhatsApp mobiles: 91 + 10 digits (starting 6-9)
  // 2) Internal extension style: starts with 0
  return /^91[6-9]\d{9}$/.test(digits) || /^0\d{1,10}$/.test(digits);
}

function formatDisplayPhone(value) {
  const digits = normalizeDigits(value);
  if (!digits) return '';
  if (digits.startsWith('91') && digits.length === 12) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  if (digits.startsWith('0')) {
    return digits;
  }
  return `+${digits}`;
}

function canonicalizeChats(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.id) continue;
    const id = String(row.id);
    // Hard rule: only @g.us JIDs are real WhatsApp groups.
    // Ignore stale/incorrect DB flags that mark number chats as groups.
    const isGroup = id.endsWith('@g.us');
    const idLocal = id.split('@')[0].split(':')[0];
    const phoneDigits = normalizeDigits(row.phone || (id.endsWith('@lid') ? '' : idLocal));
    const allowedNumber = isAllowedWaNumber(phoneDigits);

    // Hard rule: no raw @lid chat should be exposed when it can't be mapped to a phone number.
    if (!isGroup && id.endsWith('@lid') && !phoneDigits) continue;
    // Hard rule: for individual chats show only +91 numbers or 0-extension numbers.
    if (!isGroup && !allowedNumber) continue;

    const normalizedId = !isGroup && phoneDigits ? `${phoneDigits}@s.whatsapp.net` : id;
    const key = isGroup ? `group:${normalizedId}` : (phoneDigits ? `phone:${phoneDigits}` : `id:${normalizedId}`);
    const lastTs = row.last_time ? new Date(row.last_time).getTime() : 0;
    const unread = Number(row.unread || 0);
    const cleanName = String(row.name || '').trim();
    const numericName = normalizeDigits(cleanName);
    const safeName = !cleanName || /@lid/i.test(cleanName) || (numericName && !isAllowedWaNumber(numericName))
      ? null
      : cleanName;
    const normalizedRow = {
      ...row,
      id: normalizedId,
      phone: !isGroup && phoneDigits ? formatDisplayPhone(phoneDigits) : row.phone,
      name: safeName || (!isGroup && phoneDigits ? formatDisplayPhone(phoneDigits) : row.name),
      _lastTs: Number.isFinite(lastTs) ? lastTs : 0,
      _unread: Number.isFinite(unread) ? unread : 0,
    };

    const existing = map.get(key);
    if (!existing) {
      map.set(key, normalizedRow);
      continue;
    }

    // Keep newest row and preserve highest unread count.
    const winner = normalizedRow._lastTs >= existing._lastTs
      ? { ...existing, ...normalizedRow }
      : { ...normalizedRow, ...existing };
    winner._unread = Math.max(existing._unread, normalizedRow._unread);
    winner.unread = winner._unread;
    map.set(key, winner);
  }

  return Array.from(map.values())
    .map(({ _lastTs, _unread, ...row }) => row)
    .sort((a, b) => {
      const ta = a.last_time ? new Date(a.last_time).getTime() : 0;
      const tb = b.last_time ? new Date(b.last_time).getTime() : 0;
      return tb - ta;
    });
}

function connectedAccount(res) {
  const accountPhone = wa.getConnectedPhone();
  if (!accountPhone) {
    res.status(409).json({ error: 'WhatsApp not connected' });
    return null;
  }
  return accountPhone;
}

async function ensureBlocklistTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_chat_blocklist (
      account_phone VARCHAR(50) NOT NULL,
      chat_id VARCHAR(100) NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (account_phone, chat_id)
    )
  `);
}

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
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
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
    `, [accountPhone]);
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
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
    const totals = WA_DEBUG_ACCOUNT_SCOPE ? await pool.query(`
      SELECT account_phone, COUNT(*)::int AS chats
      FROM wa_chats
      GROUP BY account_phone
      ORDER BY chats DESC
    `) : null;
    const result = await pool.query(`
      WITH chat_rows AS (
        SELECT
          c.id,
          c.account_phone,
          COALESCE(c.name, wc.name, wc.notify) AS name,
          COALESCE(c.phone, wc.phone) AS phone,
          c.is_group,
          COALESCE(wc.is_group_member, false) AS is_group_member,
          COALESCE(NULLIF(latest.body, ''), NULLIF(c.last_message, ''), c.last_message) AS last_message,
          COALESCE(latest.timestamp, c.last_time) AS last_time,
          c.unread,
          c.updated_at,
          c.imported_last_ts,
          0 AS sort_bucket
        FROM wa_chats c
        LEFT JOIN LATERAL (
          SELECT body, timestamp
          FROM wa_messages m
          WHERE m.chat_id = c.id AND m.account_phone = c.account_phone
          ORDER BY m.timestamp DESC NULLS LAST
          LIMIT 1
        ) latest ON true
        LEFT JOIN wa_contacts wc
          ON wc.jid = c.id
         AND wc.account_phone = c.account_phone
        WHERE c.account_phone = $1
          AND NOT EXISTS (
            SELECT 1 FROM wa_chat_blocklist b
            WHERE b.account_phone = c.account_phone
              AND b.chat_id = c.id
          )
      ),
      contact_rows AS (
        SELECT
          CASE
            WHEN regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g') ~ '^[0-9]{7,15}$'
              THEN regexp_replace(wc.phone, '[^0-9]', '', 'g') || '@s.whatsapp.net'
            ELSE wc.jid
          END AS id,
          wc.account_phone,
          COALESCE(NULLIF(wc.name, ''), NULLIF(wc.notify, '')) AS name,
          NULLIF(regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g'), '') AS phone,
          COALESCE(wc.is_group_member, false) AS is_group_member,
          false AS is_group,
          '' AS last_message,
          NULL::timestamptz AS last_time,
          0 AS unread,
          wc.updated_at,
          NULL::timestamptz AS imported_last_ts,
          1 AS sort_bucket
        FROM wa_contacts wc
        WHERE wc.account_phone = $1
          AND wc.jid IS NOT NULL
          AND wc.jid <> ''
          AND NOT EXISTS (
            SELECT 1
            FROM wa_chats c
            WHERE c.account_phone = wc.account_phone
              AND (
                c.id = wc.jid
                OR (
                  regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g') <> ''
                  AND (
                    c.id = regexp_replace(wc.phone, '[^0-9]', '', 'g') || '@s.whatsapp.net'
                    OR regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = regexp_replace(wc.phone, '[^0-9]', '', 'g')
                  )
                )
              )
          )
      ),
      combined AS (
        SELECT * FROM chat_rows
        UNION ALL
        SELECT * FROM contact_rows
      )
      SELECT DISTINCT ON (account_phone, id)
        id, account_phone, name, phone, is_group, is_group_member, last_message, last_time, unread, updated_at, imported_last_ts
      FROM combined
      ORDER BY account_phone, id, sort_bucket ASC, last_time DESC NULLS LAST, updated_at DESC NULLS LAST
    `, [accountPhone]);
    if (WA_DEBUG_ACCOUNT_SCOPE) {
      const sample = result.rows.slice(0, 10).map(c => ({
        id: c.id,
        account_phone: c.account_phone,
        name: c.name,
        phone: c.phone,
        is_group: c.is_group,
        last_time: c.last_time,
      }));
      console.log('[WA-SCOPE] /api/wa/chats', {
        connectedAccount: accountPhone,
        returned: result.rowCount,
        totalsByAccount: totals.rows,
        sample,
      });
    }
    res.json(canonicalizeChats(result.rows));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/chats-live', authenticate, async (req, res) => {
  try {
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
    res.json(canonicalizeChats(wa.getLiveChats()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/sync', authenticate, async (req, res) => {
  if (!wa.getStatus().connected) return res.status(400).json({ error: 'WhatsApp not connected' });
  try {
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
    const metadata = await wa.refreshCurrentAccountGroupMetadata(50).catch(err => ({ error: err.message }));
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
    `, [accountPhone]);
    res.json({ success: true, stats: stats.rows[0], metadata });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/backups/create', authenticate, async (req, res) => {
  try {
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
    const result = await waInventory.createBackup(accountPhone, 'manual');
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/backups', authenticate, async (req, res) => {
  try {
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
    res.json(waInventory.listBackups(accountPhone));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/backups/load', authenticate, async (req, res) => {
  try {
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
    const fileName = req.body?.fileName;
    if (!fileName) return res.status(400).json({ error: 'fileName is required' });
    const result = await waInventory.restoreBackup(fileName, accountPhone);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/block-chat', authenticate, async (req, res) => {
  try {
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
    const jid = String(req.body?.jid || '').trim()
      .replace(/@g\.us@g\.us$/, '@g.us')
      .replace(/@s\.whatsapp\.net@s\.whatsapp\.net$/, '@s.whatsapp.net');
    if (!jid || !jid.includes('@')) return res.status(400).json({ error: 'jid is required' });
    await ensureBlocklistTable();
    await pool.query(
      `INSERT INTO wa_chat_blocklist (account_phone, chat_id, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_phone, chat_id) DO UPDATE SET reason=EXCLUDED.reason`,
      [accountPhone, jid, req.body?.reason || 'blocked from current WhatsApp account']
    );
    await pool.query(`DELETE FROM wa_messages WHERE account_phone=$1 AND chat_id=$2`, [accountPhone, jid]);
    await pool.query(`DELETE FROM wa_chats WHERE account_phone=$1 AND id=$2`, [accountPhone, jid]);
    res.json({ success: true, account_phone: accountPhone, jid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/group/:jid', authenticate, async (req, res) => {
  try {
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
    await ensureBlocklistTable();
    let jid = decodeURIComponent(req.params.jid);
    // Fix double domain suffix
    jid = jid.replace(/@g\.us@g\.us$/, '@g.us').replace(/@s\.whatsapp\.net@s\.whatsapp\.net$/, '@s.whatsapp.net');
    const blocked = await pool.query(
      `SELECT 1 FROM wa_chat_blocklist WHERE account_phone=$1 AND chat_id=$2 LIMIT 1`,
      [accountPhone, jid]
    );
    if (blocked.rowCount) return res.status(404).json({ error: 'Chat is blocked for this WhatsApp account' });
    const participantsLimit = Math.max(1, parseInt(req.query.limit || '200', 10) || 200);
    const participantsOffset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);
    res.json(await wa.getGroupMetadata(jid, { participantsLimit, participantsOffset }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/messages/:jid', authenticate, async (req, res) => {
  const jid   = decodeURIComponent(req.params.jid).replace(/@g\.us@g\.us$/, '@g.us').replace(/@s\.whatsapp\.net@s\.whatsapp\.net$/, '@s.whatsapp.net');
  const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 200);
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  try {
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
    await ensureBlocklistTable();
    const blocked = await pool.query(
      `SELECT 1 FROM wa_chat_blocklist WHERE account_phone=$1 AND chat_id=$2 LIMIT 1`,
      [accountPhone, jid]
    );
    if (blocked.rowCount) return res.json([]);
    // If this is a group chat, populate LID phone numbers from group metadata first
    if (jid.endsWith('@g.us')) {
      try {
        const groupMeta = await wa.getGroupMetadata(jid, { participantsLimit: 2000, participantsOffset: 0 });
        let updated = 0;
        const accPhone = accountPhone;
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
      [jid, limit, lidNum, accountPhone, beforeIsValid ? before.toISOString() : null]
    );
    if (WA_DEBUG_ACCOUNT_SCOPE) {
      console.log('[WA-SCOPE] /api/wa/messages', {
        connectedAccount: accountPhone,
        jid,
        returned: result.rowCount,
        first: result.rows[0] ? {
          id: result.rows[0].id,
          chat_id: result.rows[0].chat_id,
          account_phone: result.rows[0].account_phone,
          sender: result.rows[0].sender,
          timestamp: result.rows[0].timestamp,
        } : null,
        last: result.rows[result.rows.length - 1] ? {
          id: result.rows[result.rows.length - 1].id,
          chat_id: result.rows[result.rows.length - 1].chat_id,
          account_phone: result.rows[result.rows.length - 1].account_phone,
          sender: result.rows[result.rows.length - 1].sender,
          timestamp: result.rows[result.rows.length - 1].timestamp,
        } : null,
      });
    }
    const accPhone = accountPhone;
    await pool.query(`UPDATE wa_messages SET is_read=true WHERE chat_id=$1 AND account_phone=$2 AND from_me=false`, [jid, accPhone]);
    await pool.query(`UPDATE wa_chats SET unread=0 WHERE id=$1 AND account_phone=$2`, [jid, accPhone]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/messages-live/:jid', authenticate, async (req, res) => {
  const jid = decodeURIComponent(req.params.jid).replace(/@g\.us@g\.us$/, '@g.us').replace(/@s\.whatsapp\.net@s\.whatsapp\.net$/, '@s.whatsapp.net');
  const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 200);
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  try {
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
    const rows = wa.getLiveMessages(jid, {
      limit,
      before: before && !Number.isNaN(before.getTime()) ? before.toISOString() : null,
    });
    res.json(rows);
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

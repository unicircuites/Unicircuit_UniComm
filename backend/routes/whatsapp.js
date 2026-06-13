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

// ── One-time cleanup: NULL out any wa_chats.name that is the group's own JID ──
pool.query(`
  UPDATE wa_chats
  SET name = NULL
  WHERE is_group = true
    AND name IS NOT NULL
    AND (
      name = id
      OR name = split_part(id,'@',1)
      OR (name ~ '^[0-9]{12,}' AND name NOT LIKE '%@%')
    )
`).catch(e => console.error('[WA] group name cleanup:', e.message));

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeWaRouteJid(value) {
  const jid = String(value || '')
    .replace(/@g\.us@g\.us$/, '@g.us')
    .replace(/@s\.whatsapp\.net@s\.whatsapp\.net$/, '@s.whatsapp.net');
  return jid.includes(':') && jid.includes('@')
    ? jid.split(':')[0] + '@' + jid.split('@').slice(1).join('@')
    : jid;
}

function isAllowedWaNumber(value) {
  const digits = normalizeDigits(value);
  if (!digits) return false;
  // A LID is a 15+ digit internal WhatsApp identifier — never a real phone number.
  // Any other number between 7 and 15 digits is a valid phone number from any country.
  if (digits.length >= 15) return false; // LID — not a real phone
  if (digits.length < 7)   return false; // too short to be a phone
  if (/^0{5,}$/.test(digits)) return false; // all zeros
  return true; // valid international phone number
}

function formatDisplayPhone(value) {
  const digits = normalizeDigits(value);
  if (!digits) return '';
  // Indian mobile: 91 + 10 digits → +91 XXXXXXXXXX
  if (digits.startsWith('91') && digits.length === 12) {
    return `+91 ${digits.slice(2)}`;
  }
  // Extension starting with 0 — show as-is
  if (digits.startsWith('0')) {
    return digits;
  }
  // All other international numbers — show with +
  return `+${digits}`;
}

function isPhoneLikeText(value, phoneDigits) {
  const text = String(value || '').trim();
  if (!text || text.includes('@lid')) return false;
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return false;
  if (phoneDigits && digits === phoneDigits) return true;
  if (/^\+?\d[\d\s\-().]+$/.test(text) && digits.length >= 7) return true;
  return false;
}

function isInvalidContactLabel(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (/^you$/i.test(text)) return true;
  if (/^(unknown|unknown whatsapp contact|whatsapp)$/i.test(text)) return true;
  // Meta AI is WhatsApp's built-in AI assistant — never a real contact or group
  if (/^meta\s*ai$/i.test(text)) return true;
  // WhatsApp rate-limit / protocol error strings must never appear as names
  if (/rate.?overlimit|not-authorized|forbidden|bad.?request|not.?found|timeout|internal.?server/i.test(text)) return true;
  return false;
}

function isGroupishLabel(candidate, groupIdLocal) {
  const text = String(candidate || '').trim();
  if (!text) return true;
  if (/^\d+$/.test(text)) return true;
  if (isPhoneLikeText(text, '')) return true;
  if (isAllowedWaNumber(normalizeDigits(text))) return true;
  const localDigits = normalizeDigits(groupIdLocal || '');
  if (localDigits && normalizeDigits(text) === localDigits) return true;
  // Generic fallback placeholder — not a real group name
  if (/^group$/i.test(text)) return true;
  // JID stored as name (e.g. "120363361207108410@g.us") — not a real name
  if (text.includes('@g.us') || text.includes('@s.whatsapp.net') || text.includes('@lid')) return true;
  // Pure numeric string with @g.us stripped — 15+ digit internal group ID stored as name
  if (/^\d{12,}/.test(text.replace(/@[a-z.]+$/i, ''))) return true;
  return false;
}

function pickContactLabel(row, phoneDigits, isGroup) {
  const name = String(row.name || '').trim();
  const notify = String(row.notify || '').trim();
  const verified = String(row.verified_name || row.verifiedName || '').trim();
  const msgName = String(row.msg_name || '').trim();
  const crmName = String(row.crm_name || '').trim();
  const chatName = String(row.chat_name || '').trim();
  const groupIdLocal = isGroup ? String(row.id || '').split('@')[0].split(':')[0] : '';
  const candidates = isGroup
    ? [chatName, name]
    : [name, notify, verified, msgName, crmName, chatName];

  for (const candidate of candidates) {
    if (!candidate || isInvalidContactLabel(candidate)) continue;
    if (isGroup) {
      if (isGroupishLabel(candidate, groupIdLocal)) continue;
      return candidate;
    }
    if (!isGroup && isPhoneLikeText(candidate, phoneDigits)) continue;
    if (!isGroup && isAllowedWaNumber(normalizeDigits(candidate))) continue;
    return candidate;
  }

  if (isGroup) return '';  // no name found — will be hidden until refreshed from WA
  if (phoneDigits && isAllowedWaNumber(phoneDigits)) return formatDisplayPhone(phoneDigits);
  return '';
}

function isNamedLidFallback(id, phoneDigits, label) {
  if (!String(id || '').endsWith('@lid') || phoneDigits || !label) return false;
  if (isInvalidContactLabel(label)) return false;
  const idLocal = id.split('@')[0].split(':')[0];
  const labelDigits = normalizeDigits(label);
  if (labelDigits && labelDigits === idLocal) return false;
  if (isPhoneLikeText(label, '')) return false;
  return true;
}

function isNonChatJid(jid) {
  const id = String(jid || '');
  return id === 'status@broadcast' || id.endsWith('@newsletter') || id.endsWith('@broadcast');
}

function canonicalizeChats(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.id) continue;
    const id = String(row.id);
    if (isNonChatJid(id)) continue;
    const isGroup = id.endsWith('@g.us');
    const idLocal = id.split('@')[0].split(':')[0];
    const rawPhoneDigits = normalizeDigits(row.phone || (id.endsWith('@lid') ? '' : idLocal));
    const phoneDigits = id.endsWith('@lid') && rawPhoneDigits === idLocal ? '' : rawPhoneDigits;
    const allowedNumber = isAllowedWaNumber(phoneDigits);
    const displayLabel = pickContactLabel(row, phoneDigits, isGroup);
    const hasNamedLidFallback = isNamedLidFallback(id, phoneDigits, displayLabel);

    // ── Hard exclusion rules ──────────────────────────────────────────────
    // 0. STRICT: Meta AI is WhatsApp's built-in AI assistant — never show it
    //    as a contact or group in the CRM chat list.
    if (/^meta\s*ai$/i.test(displayLabel)) { console.log(`[WA-FILTER] Blocked Meta AI entry: ${id}`); continue; }

    // 1. Raw @lid with no phone AND no proper name: hide until resolved.
    // If it has a proper name (hasNamedLidFallback = true), we MUST show it.
    if (!isGroup && id.endsWith('@lid') && !phoneDigits && !hasNamedLidFallback) continue;
    
    // 2. Individual chats need a resolved phone or a real saved/profile name
    if (!isGroup && !allowedNumber && !hasNamedLidFallback) continue;
    
    // 3. Never expose @lid rows whose only label is the LID number itself
    if (!isGroup && id.includes('@lid') && !hasNamedLidFallback && !phoneDigits) continue;
    
    if (!isGroup && !displayLabel) continue;
    
    // 4. Groups with confirmed-bad names (numeric ID stored as name, raw JID) are hidden.
    //    Groups with null/empty name are kept but will show as pending until subject is fetched.
    if (isGroup && row.name && isGroupishLabel(row.name, idLocal)) continue;

    // Group-only members belong in group info, not the main chat list.
    if (!isGroup && row.is_group_member && !row.last_time && !String(row.last_message || '').trim()) continue;

    const normalizedId = !isGroup && phoneDigits ? `${phoneDigits}@s.whatsapp.net` : id;
    const key = isGroup ? `group:${normalizedId}` : (phoneDigits ? `phone:${phoneDigits}` : `id:${normalizedId}`);
    const lastTs = row.last_time ? new Date(row.last_time).getTime() : 0;
    const unread = Number(row.unread || 0);
    const normalizedRow = {
      ...row,
      id: normalizedId,
      phone: !isGroup && phoneDigits ? formatDisplayPhone(phoneDigits) : (isGroup ? null : row.phone),
      name: displayLabel,
      _lastTs: Number.isFinite(lastTs) ? lastTs : 0,
      _unread: Number.isFinite(unread) ? unread : 0,
      _sortName: displayLabel.toLowerCase(),
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

  // ── STRICT: LOAD ONLY UNIQUE NAMES ───────────────────────────────────────
  // Only one chat per display name is ever returned.
  // Duplicates are DROPPED (keeping most-recent), unread counts are merged.
  const nameMap = new Map();
  const dupLog  = [];

  for (const row of map.values()) {
    const nameKey = String(row.name || '').trim().toLowerCase();
    if (!nameKey) continue;
    const existing = nameMap.get(nameKey);
    if (!existing) {
      nameMap.set(nameKey, row);
    } else {
      const ta = row._lastTs ?? (row.last_time ? new Date(row.last_time).getTime() : 0);
      const tb = existing._lastTs ?? (existing.last_time ? new Date(existing.last_time).getTime() : 0);
      if (ta >= tb) {
        const merged = { ...row };
        merged._unread = Math.max(row._unread || 0, existing._unread || 0);
        merged.unread  = merged._unread;
        dupLog.push(`  DROPPED  [${existing.id}]  kept  [${row.id}]  name="${row.name}"`);
        nameMap.set(nameKey, merged);
      } else {
        existing._unread = Math.max(existing._unread || 0, row._unread || 0);
        existing.unread  = existing._unread;
        dupLog.push(`  DROPPED  [${row.id}]  kept  [${existing.id}]  name="${existing.name}"`);
      }
    }
  }

  if (dupLog.length > 0) {
    console.warn(`[WA-DEDUP] ⚠️  ${dupLog.length} duplicate name(s) suppressed — UNIQUE NAMES ONLY policy:`);
    dupLog.forEach(l => console.warn(l));
  } else {
    console.log(`[WA-DEDUP] ✅ All ${nameMap.size} chat names are unique.`);
  }

  return Array.from(nameMap.values())
    .map(({ _lastTs, _unread, _sortName, ...row }) => row)
    .sort((a, b) => {
      const ta = a.last_time ? new Date(a.last_time).getTime() : 0;
      const tb = b.last_time ? new Date(b.last_time).getTime() : 0;
      if (tb !== ta) return tb - ta;
      return String(a.name || '').localeCompare(String(b.name || ''));
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
          phone = '+91 ' + phone.slice(2);
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
      WITH enriched_contacts AS (
        SELECT
          wc.jid,
          wc.account_phone,
          wc.name,
          wc.notify,
          wc.phone,
          wc.is_group_member,
          wc.verified_name,
          wc.is_business,
          wc.updated_at,
          msg.sender_name AS msg_name,
          NULLIF(trim(concat(crm.fname, ' ', crm.lname)), '') AS crm_name
        FROM wa_contacts wc
        LEFT JOIN LATERAL (
          SELECT m.sender_name
          FROM wa_messages m
          WHERE wc.name IS NULL AND wc.notify IS NULL
            AND m.account_phone = wc.account_phone
            AND m.from_me = false
            AND m.sender_name IS NOT NULL
            AND m.sender_name != ''
            AND m.sender_name !~* '^you$'
            AND m.sender_name !~ '^\\+?[0-9]'
            AND (
              m.sender = wc.jid
              OR regexp_replace(split_part(COALESCE(m.sender, ''), '@', 1), '[^0-9]', '', 'g')
                = regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g')
            )
          ORDER BY m.timestamp DESC NULLS LAST
          LIMIT 1
        ) msg ON true
        LEFT JOIN LATERAL (
          SELECT c.fname, c.lname
          FROM contacts c
          WHERE wc.phone IS NOT NULL
            AND regexp_replace(COALESCE(c.phone, c.wa, ''), '[^0-9]', '', 'g') != ''
            AND (
              regexp_replace(COALESCE(c.phone, c.wa, ''), '[^0-9]', '', 'g')
                = regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g')
              OR right(regexp_replace(COALESCE(c.phone, c.wa, ''), '[^0-9]', '', 'g'), 10)
                = right(regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g'), 10)
            )
          LIMIT 1
        ) crm ON true
        WHERE wc.account_phone = $1
      ),
      chat_rows AS (
        SELECT
          c.id,
          c.account_phone,
          CASE WHEN c.is_group THEN c.name ELSE COALESCE(ec.name, wc.name, c.name) END AS name,
          COALESCE(ec.notify, wc.notify) AS notify,
          ec.msg_name,
          ec.crm_name,
          CASE WHEN c.is_group THEN c.name END AS chat_name,
          COALESCE(
            NULLIF(regexp_replace(COALESCE(c.phone, ec.phone, wc.phone, ''), '[^0-9]', '', 'g'), ''),
            CASE WHEN c.id NOT LIKE '%@lid' THEN split_part(c.id, '@', 1) ELSE NULL END
          ) AS phone,
          COALESCE(ec.is_group_member, wc.is_group_member, false) AS is_group_member,
          COALESCE(ec.verified_name, wc.verified_name, lid_biz.verified_name) AS verified_name,
          COALESCE(ec.is_business, wc.is_business, lid_biz.is_business, false) AS is_business,
          c.is_group,
          COALESCE(NULLIF(latest.body, ''), NULLIF(c.last_message, ''), c.last_message) AS last_message,
          COALESCE(latest.timestamp, c.last_time) AS last_time,
          c.unread,
          c.updated_at,
          c.imported_last_ts,
          COALESCE(c.is_announce, false) AS is_announce,
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
          ON wc.jid = c.id AND wc.account_phone = c.account_phone
        LEFT JOIN enriched_contacts ec
          ON ec.jid = c.id AND ec.account_phone = c.account_phone
        LEFT JOIN LATERAL (
          SELECT wc2.verified_name, wc2.is_business
          FROM wa_contacts wc2
          WHERE wc2.account_phone = c.account_phone
            AND wc2.jid LIKE '%@lid'
            AND wc2.phone IS NOT NULL
            AND regexp_replace(wc2.phone, '[^0-9]', '', 'g') = split_part(c.id, '@', 1)
          LIMIT 1
        ) lid_biz ON true
        WHERE c.account_phone = $1
          AND c.id NOT LIKE '%@newsletter'
          AND c.id NOT LIKE '%@broadcast'
          AND c.id <> 'status@broadcast'
          AND NOT EXISTS (
            SELECT 1 FROM wa_chat_blocklist b
            WHERE b.account_phone = c.account_phone
              AND b.chat_id = c.id
          )
          AND NOT (c.id LIKE '%@lid' AND COALESCE(regexp_replace(c.phone, '[^0-9]', '', 'g'), '') = ''
                   AND COALESCE(c.name, '') = '')
      ),
      contact_rows AS (
        SELECT
          CASE
            WHEN regexp_replace(COALESCE(ec.phone, ''), '[^0-9]', '', 'g') ~ '^[0-9]{7,15}$'
              THEN regexp_replace(ec.phone, '[^0-9]', '', 'g') || '@s.whatsapp.net'
            ELSE ec.jid
          END AS id,
          ec.account_phone,
          ec.name,
          ec.notify,
          ec.msg_name,
          ec.crm_name,
          NULL::text AS chat_name,
          NULLIF(regexp_replace(COALESCE(ec.phone, ''), '[^0-9]', '', 'g'), '') AS phone,
          COALESCE(ec.is_group_member, false) AS is_group_member,
          ec.verified_name,
          COALESCE(ec.is_business, false) AS is_business,
          false AS is_group,
          '' AS last_message,
          NULL::timestamptz AS last_time,
          0 AS unread,
          ec.updated_at,
          NULL::timestamptz AS imported_last_ts,
          false AS is_announce,
          1 AS sort_bucket
        FROM enriched_contacts ec
        WHERE ec.account_phone = $1
          AND ec.jid IS NOT NULL
          AND ec.jid <> ''
          AND ec.jid NOT LIKE '%@newsletter'
          AND ec.jid NOT LIKE '%@broadcast'
          AND ec.jid <> 'status@broadcast'
          -- Only list contacts with a real resolved phone (never the raw LID number).
          AND regexp_replace(COALESCE(ec.phone, ''), '[^0-9]', '', 'g') ~ '^[0-9]{7,14}$'
          AND regexp_replace(COALESCE(ec.phone, ''), '[^0-9]', '', 'g') <> split_part(ec.jid, '@', 1)
          -- Hide anonymous raw @lid entries, but allow named contacts while
          -- WhatsApp phone resolution catches up for a newly linked account.
          AND NOT (
            ec.jid LIKE '%@lid'
            AND COALESCE(regexp_replace(ec.phone, '[^0-9]', '', 'g'), '') = ''
            AND COALESCE(NULLIF(ec.name, ''), NULLIF(ec.notify, '')) IS NULL
          )
          -- Group-only members are not chats; they appear under Group Info instead.
          AND COALESCE(ec.is_group_member, false) = false
          AND NOT EXISTS (
            SELECT 1
            FROM wa_chats c
            WHERE c.account_phone = ec.account_phone
              AND (
                c.id = ec.jid
                OR (
                  regexp_replace(COALESCE(ec.phone, ''), '[^0-9]', '', 'g') <> ''
                  AND (
                    c.id = regexp_replace(ec.phone, '[^0-9]', '', 'g') || '@s.whatsapp.net'
                    OR regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = regexp_replace(ec.phone, '[^0-9]', '', 'g')
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
        id, account_phone, name, phone, is_group, is_group_member, last_message, last_time, unread, updated_at, imported_last_ts, is_announce
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
    // Enrich null-name groups from in-memory cache (contactsStore / groupMetadataCache)
    // This fills names immediately without waiting for a DB round-trip
    for (const row of result.rows) {
      if (row.is_group && !row.name) {
        const cached = wa.getGroupSubjectFromCache(row.id);
        if (cached) row.name = cached;
      }
    }

    // Enrich chats with labels
    try {
      const labelRes = await pool.query(`
        SELECT a.chat_id, json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color)) AS labels
        FROM wa_label_associations a
        JOIN wa_labels l ON l.id = a.label_id AND l.account_phone = a.account_phone
        WHERE a.account_phone = $1
        GROUP BY a.chat_id
      `, [accountPhone]);
      const labelMap = {};
      for (const row of labelRes.rows) labelMap[row.chat_id] = row.labels;
      for (const row of result.rows) row.labels = labelMap[row.id] || [];
    } catch (_) {}

    res.json(canonicalizeChats(result.rows));

    // Background: fetch group subjects from WA for groups still with null name, patch DB
    const nullNameGroups = result.rows.filter(r => r.is_group && !r.name);
    if (nullNameGroups.length > 0) {
      setImmediate(() => {
        wa.refreshCurrentAccountGroupMetadata(Math.min(nullNameGroups.length + 10, 200)).catch(() => {});
      });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/chats-live', authenticate, async (req, res) => {
  try {
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
    res.json(canonicalizeChats(wa.getLiveChats()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/resolution-stats', authenticate, async (req, res) => {
  try {
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
    const result = await pool.query(`
      WITH raw_items AS (
        SELECT
          id,
          COALESCE(name, '') AS name,
          COALESCE(phone, '') AS phone,
          COALESCE(is_group, false) AS is_group,
          updated_at
        FROM wa_chats
        WHERE account_phone = $1
        UNION ALL
        SELECT
          jid AS id,
          COALESCE(NULLIF(name, ''), NULLIF(notify, ''), '') AS name,
          COALESCE(phone, '') AS phone,
          false AS is_group,
          updated_at
        FROM wa_contacts
        WHERE account_phone = $1
      ),
      keyed AS (
        SELECT DISTINCT ON (
          CASE
            WHEN id LIKE '%@g.us' THEN 'group:' || id
            WHEN COALESCE(regexp_replace(phone, '[^0-9]', '', 'g'), '') != ''
              THEN 'phone:' || regexp_replace(phone, '[^0-9]', '', 'g')
            ELSE 'id:' || id
          END
        )
          id,
          name,
          regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') AS phone_digits,
          is_group,
          updated_at
        FROM raw_items
        WHERE id IS NOT NULL AND id != ''
        ORDER BY
          CASE
            WHEN id LIKE '%@g.us' THEN 'group:' || id
            WHEN COALESCE(regexp_replace(phone, '[^0-9]', '', 'g'), '') != ''
              THEN 'phone:' || regexp_replace(phone, '[^0-9]', '', 'g')
            ELSE 'id:' || id
          END,
          updated_at DESC NULLS LAST
      )
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE is_group
            OR (phone_digits ~ '^[0-9]{7,14}$')
            OR (id NOT LIKE '%@lid' AND split_part(id, '@', 1) ~ '^[0-9]{7,14}$')
            OR (id LIKE '%@lid' AND COALESCE(phone_digits, '') = '' AND NULLIF(name, '') IS NOT NULL)
        )::int AS loaded,
        COUNT(*) FILTER (
          WHERE id LIKE '%@lid'
            AND COALESCE(phone_digits, '') = ''
        )::int AS lid_pending,
        COUNT(*) FILTER (
          WHERE id LIKE '%@lid'
            AND COALESCE(phone_digits, '') = ''
            AND NULLIF(name, '') IS NOT NULL
        )::int AS named_lid_pending,
        COUNT(*) FILTER (
          WHERE id LIKE '%@lid'
            AND COALESCE(phone_digits, '') = ''
            AND NULLIF(name, '') IS NULL
        )::int AS hidden_lid_pending
      FROM keyed
    `, [accountPhone]);
    const stats = result.rows[0] || {};
    res.json({
      account_phone: accountPhone,
      total: Number(stats.total || 0),
      loaded: Number(stats.loaded || 0),
      pending: Number(stats.lid_pending || 0),
      named_pending: Number(stats.named_lid_pending || 0),
      hidden_pending: Number(stats.hidden_lid_pending || 0),
      exhausted: wa.isLidResolutionExhausted(),
      cooldown_mins: wa.getLidResolutionCooldownMins()
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/resolve-lids', authenticate, async (req, res) => {
  if (!wa.getStatus().connected) return res.status(400).json({ error: 'WhatsApp not connected' });
  try {
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
    const batch = Math.max(1, Math.min(parseInt(req.body?.batch || req.query?.batch || 100, 10) || 100, 200));
    const result = await wa.processLidResolutionBatch(batch);
    res.json({ success: true, account_phone: accountPhone, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/sync', authenticate, async (req, res) => {
  if (!wa.getStatus().connected) return res.status(400).json({ error: 'WhatsApp not connected' });
  try {
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
    const resync = await wa.resyncDirectoryFromSocket({ groupLimit: 100 }).catch(err => ({ error: err.message }));
    const metadata = await wa.refreshCurrentAccountGroupMetadata(100).catch(err => ({ error: err.message }));
    wa.startLidResolutionWorker();

    // Backfill: upsert sender_name from messages into wa_contacts.notify where no name saved yet
    pool.query(`
      INSERT INTO wa_contacts (jid, account_phone, notify)
      SELECT DISTINCT ON (m.chat_id)
        m.chat_id AS jid, m.account_phone, m.sender_name AS notify
      FROM wa_messages m
      WHERE m.account_phone = $1
        AND m.from_me = false
        AND m.chat_id NOT LIKE '%@g.us'
        AND m.sender_name IS NOT NULL AND m.sender_name != '' AND m.sender_name != 'Unknown'
        AND m.sender_name !~ '^[+0-9 ()-]+$'
      ORDER BY m.chat_id, m.timestamp DESC
      ON CONFLICT (jid, account_phone) DO UPDATE SET
        notify = EXCLUDED.notify,
        updated_at = NOW()
      WHERE (wa_contacts.name IS NULL OR wa_contacts.name = '')
        AND (wa_contacts.notify IS NULL OR wa_contacts.notify = '')
    `, [accountPhone]).catch(() => {});
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
    res.json({ success: true, stats: stats.rows[0], metadata, resync });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/backups/create', authenticate, async (req, res) => {
  try {
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
    await wa.flushCachedMediaToDisk().catch(() => {});
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

// Stream the .zip backup file directly to the browser
router.get('/backups/download/:fileName', authenticate, (req, res) => {
  const fs   = require('fs');
  const path = require('path');
  const fileName = path.basename(String(req.params.fileName || ''));
  if (!/^wa-backup-[a-zA-Z0-9_.-]+\.zip$/.test(fileName))
    return res.status(400).json({ error: 'Invalid file name' });
  const filePath = path.join(waInventory.backupDir, fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Backup not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', 'application/zip');
  fs.createReadStream(filePath).pipe(res);
});

// Accept binary ZIP upload — use express.raw() locally to bypass express.json()
router.post('/backups/upload',
  authenticate,
  (req, res, next) => {
    // express.json() runs globally; for this route we need raw binary
    // If body was already parsed (small upload), skip. Otherwise read raw.
    if (Buffer.isBuffer(req.body) || !req.headers['content-type']?.includes('application/zip')) {
      return next();
    }
    next();
  },
  require('express').raw({ type: 'application/zip', limit: '500mb' }),
  async (req, res) => {
    const fs   = require('fs');
    const path = require('path');
    const os   = require('os');
    try {
      const accountPhone = connectedAccount(res);
      if (!accountPhone) return;

      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length < 4)
        return res.status(400).json({ error: 'Invalid or empty ZIP file' });

      // ZIP magic bytes: PK\x03\x04
      if (buf[0] !== 0x50 || buf[1] !== 0x4B)
        return res.status(400).json({ error: 'File is not a valid ZIP archive' });

      if (buf.length > 500 * 1024 * 1024)
        return res.status(413).json({ error: 'Backup too large (max 500 MB)' });

      // Write to temp file, let restoreBackup read it
      const tmpPath = path.join(os.tmpdir(), `wa-upload-${Date.now()}.zip`);
      fs.writeFileSync(tmpPath, buf);
      try {
        const result = await waInventory.restoreBackup(tmpPath, accountPhone);
        if (wa.getStatus().connected) wa.startLidResolutionWorker();
        res.json(result);
      } finally {
        fs.unlink(tmpPath, () => {});
      }
    } catch (err) {
      const status = err.message.includes('Restore blocked') || err.message.includes('belongs to') ? 409 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

router.post('/backups/load', authenticate, async (req, res) => {
  try {
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
    const fileName = req.body?.fileName;
    if (!fileName) return res.status(400).json({ error: 'fileName is required' });
    const filePath = require('path').join(waInventory.backupDir, require('path').basename(fileName));
    const result = await waInventory.restoreBackup(filePath, accountPhone);
    if (wa.getStatus().connected) wa.startLidResolutionWorker();
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

router.get('/profile-pic/:jid', authenticate, async (req, res) => {
  try {
    const accountPhone = connectedAccount(res);
    if (!accountPhone) return;
    const jid = decodeURIComponent(req.params.jid);
    const url = await wa.getProfilePicUrl(jid, accountPhone);
    res.json({ url: url || null });
  } catch (err) { res.json({ url: null }); }
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
    const gData = await wa.getGroupMetadata(jid, { participantsLimit, participantsOffset });
    // Group Info is the authoritative source — persist the confirmed subject to wa_chats
    // so the chat list always shows the real name, not a stale/empty fallback.
    if (gData?.name) setImmediate(() => wa.updateGroupName(jid, gData.name, accountPhone));
    // Persist announce status so the chat list badge (ANN/GRP) survives across sessions
    if (gData && typeof gData.announce === 'boolean') {
      setImmediate(() => pool.query(
        `UPDATE wa_chats SET is_announce=$1 WHERE id=$2 AND account_phone=$3`,
        [gData.announce, jid, accountPhone]
      ).catch(() => {}));
    }
    res.json(gData);
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
    // If this is a group chat, populate LID phone numbers from group metadata in the background.
    // We do NOT await this — messages are returned immediately, contacts update async.
    if (jid.endsWith('@g.us')) {
      setImmediate(async () => {
        try {
          const groupMeta = await wa.getGroupMetadata(jid, { participantsLimit: 2000, participantsOffset: 0 });
          // Always persist the confirmed group subject — this is the authoritative name source
          if (groupMeta?.name) await wa.updateGroupName(jid, groupMeta.name, accountPhone);
          let updated = 0;
          for (const p of (groupMeta?.participants || [])) {
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
                `, [p.jid, accountPhone, p.name, realPhone]);
                updated++;
              }
            }
          }
          if (updated > 0) console.log(`[WA] Updated ${updated} LID contacts for group ${jid}`);
        } catch (metaErr) {
          console.warn(`[WA] Failed to fetch group metadata for ${jid}:`, metaErr.message);
        }
      });
    }
    
    const jidLocal = jid.split('@')[0].split(':')[0];
    const phoneDigits = jid.endsWith('@s.whatsapp.net') ? jidLocal : null;
    const lidNum = jid.endsWith('@lid') ? jidLocal : null;
    const beforeIsValid = before && !Number.isNaN(before.getTime());
    const result = await pool.query(
      `SELECT m.*,
        CASE
          WHEN m.sender LIKE '%@lid' AND c.phone IS NOT NULL AND c.phone ~ '^[0-9]{7,}$'
            THEN CASE
              WHEN c.phone LIKE '91%' AND length(regexp_replace(c.phone, '[^0-9]', '', 'g')) = 12
              THEN '+91 ' || substring(regexp_replace(c.phone, '[^0-9]', '', 'g'), 3)
              ELSE '+' || regexp_replace(c.phone, '[^0-9]', '', 'g')
            END
          WHEN m.sender NOT LIKE '%@lid' AND m.sender NOT LIKE '%@g.us' AND m.sender IS NOT NULL
            THEN CASE
              WHEN split_part(m.sender,'@',1) LIKE '91%' AND length(split_part(m.sender,'@',1)) = 12
              THEN '+91 ' || substring(split_part(m.sender,'@',1), 3)
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
              OR ($6::text IS NOT NULL AND chat_id IN (
                SELECT wc.jid FROM wa_contacts wc
                WHERE wc.account_phone = $4
                  AND regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g') = $6
                  AND wc.jid LIKE '%@lid'
              ))
              OR ($6::text IS NOT NULL AND chat_id IN (
                SELECT wc.id FROM wa_chats wc
                WHERE wc.account_phone = $4
                  AND regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g') = $6
                  AND wc.id LIKE '%@lid'
              ))
            )
            AND ($5::timestamptz IS NULL OR timestamp < $5::timestamptz)
         ORDER BY timestamp DESC LIMIT $2
       ) m
       LEFT JOIN wa_contacts c ON c.jid = m.sender AND c.account_phone=$4
       ORDER BY m.timestamp ASC`,
      [jid, limit, lidNum, accountPhone, beforeIsValid ? before.toISOString() : null, phoneDigits]
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
    res.json(result.rows);
    // Fire-and-forget: mark messages read after responding — don't block the response
    Promise.all([
      pool.query(`UPDATE wa_messages SET is_read=true WHERE chat_id=$1 AND account_phone=$2 AND from_me=false AND is_read=false`, [jid, accountPhone]),
      wa.markChatRead(jid),
    ]).catch(() => {});
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
    pool.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'wa_send','whatsapp_chat',$2,$3)`,
      [req.user?.id, jid, `Sent WA message to ${jid}: "${String(message).slice(0,80)}"`]
    ).catch(() => {});
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Delete WA Message ─────────────────────────────────────────────────────────
router.delete('/message/:msgId', authenticate, async (req, res) => {
  const { msgId } = req.params;
  const { chatJid } = req.query;
  if (!chatJid) return res.status(400).json({ error: 'chatJid query param required' });
  try {
    await wa.deleteWaMessage(chatJid, msgId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WA Broadcast History (DB-backed) ─────────────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS wa_broadcast_history (
    id            SERIAL PRIMARY KEY,
    message       TEXT,
    full_message  TEXT,
    recipients    JSONB,
    total         INT DEFAULT 0,
    sent          INT DEFAULT 0,
    failed        INT DEFAULT 0,
    status        VARCHAR(20) DEFAULT 'sending',
    sent_at       TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.error('[WA] wa_broadcast_history init:', e.message));
// Migrate existing table if columns missing
pool.query(`ALTER TABLE wa_broadcast_history ADD COLUMN IF NOT EXISTS full_message TEXT`).catch(()=>{});
pool.query(`ALTER TABLE wa_broadcast_history ADD COLUMN IF NOT EXISTS recipients JSONB`).catch(()=>{});

router.get('/broadcast', authenticate, async (req, res) => {
  try {
    const rows = await pool.query(`SELECT id, message, full_message, recipients, total, sent, failed, status, sent_at FROM wa_broadcast_history ORDER BY sent_at DESC LIMIT 100`);
    res.json(rows.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/broadcast/:id', authenticate, async (req, res) => {
  try {
    await pool.query(`DELETE FROM wa_broadcast_history WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/broadcast', authenticate, async (req, res) => {
  const { recipients, message, delay_ms, attachments, image_url, variable_fields } = req.body;
  const targets = Array.isArray(recipients) ? recipients : [];
  const text = String(message || '').trim();
  const files = Array.isArray(attachments) ? attachments.slice(0, 10) : [];
  const imageUrl = String(image_url || '').trim();
  const varFields = Array.isArray(variable_fields) ? variable_fields : [];

  if (!targets.length) return res.status(400).json({ error: 'recipients[] required' });
  if (!text && !files.length && !imageUrl) return res.status(400).json({ error: 'message or attachments required' });

  // Build fixed variable substitutions (non-recipient fields)
  function applyVarFields(tmpl, recipientName) {
    let out = String(tmpl || '');
    for (const f of varFields) {
      const key = String(f.key || '').trim();
      if (!key) continue;
      const val = f.source === 'recipient'
        ? (recipientName || '')
        : String(f.value || '').trim();
      out = out.replace(new RegExp('\\{\\{' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\}\\}', 'g'), val);
    }
    return out;
  }

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

  const dbRow = await pool.query(
    `INSERT INTO wa_broadcast_history (message, full_message, recipients, total, sent, failed, status, sent_at) VALUES ($1,$2,$3,$4,0,0,'sending',NOW()) RETURNING id`,
    [text.length > 120 ? text.slice(0, 120) + '…' : text, text, JSON.stringify(normalized.map(r => ({ jid: r.jid, name: r.name }))), normalized.length]
  );
  const histId = dbRow.rows[0].id;

  // Pre-fetch image from URL if provided (once for all recipients)
  let imageBuf = null, imageMime = 'image/jpeg';
  if (imageUrl) {
    try {
      const https = require('https'), http = require('http');
      const proto = imageUrl.startsWith('https') ? https : http;
      imageBuf = await new Promise((resolve, reject) => {
        proto.get(imageUrl, res => {
          imageMime = res.headers['content-type'] || 'image/jpeg';
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }).on('error', reject);
      });
    } catch (e) {
      console.warn('[WA Broadcast] Could not fetch image URL:', e.message);
    }
  }

  res.json({ success: true, total: normalized.length, queued: normalized.length });

  (async () => {
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < normalized.length; i++) {
      const target = normalized[i];
      const msg = applyVarFields(text, target.name);
      try {
        if (imageBuf) {
          await wa.sendMediaMessage(target.jid, {
            buffer: imageBuf,
            filename: 'image.jpg',
            mimetype: imageMime,
            mediaType: 'image',
            caption: msg,
          }, null);
          if (files.length) await wait(800);
        }
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
              caption: f === 0 && !imageBuf ? msg : '',
            }, null);
            if (f < files.length - 1) await wait(800);
          }
        } else if (!imageBuf) {
          await wa.sendMessage(target.jid, msg, null);
        }
        sent += 1;
      } catch (err) {
        failed += 1;
        console.error(`[WA Broadcast] Failed for ${target.jid}:`, err.message);
      }
      if (i < normalized.length - 1) await wait(delay);
    }
    console.log(`[WA Broadcast] Done - sent:${sent} failed:${failed}`);
    await pool.query(
      `UPDATE wa_broadcast_history SET sent=$1, failed=$2, status=$3 WHERE id=$4`,
      [sent, failed, failed === normalized.length ? 'failed' : 'sent', histId]
    ).catch(e => console.error('[WA Broadcast] history update:', e.message));
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

// POST /api/wa/purge-all — wipe all WA DB data + media files + session
router.post('/purge-all', authenticate, async (req, res) => {
  const fs = require('fs');
  const path = require('path');
  try {
    // 1. Stop WA socket gracefully
    try { await wa.logout(); } catch (_) {}

    // 2. Wipe DB tables
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const t of ['wa_messages', 'wa_chats', 'wa_contacts', 'wa_chat_blocklist']) {
        await client.query(`DELETE FROM ${t}`);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }

    // 3. Wipe media files
    const mediaDir = path.join(__dirname, '../wa_media');
    let mediaDeleted = 0;
    if (fs.existsSync(mediaDir)) {
      for (const f of fs.readdirSync(mediaDir)) {
        try { fs.unlinkSync(path.join(mediaDir, f)); mediaDeleted++; } catch (_) {}
      }
    }

    // 4. Wipe session (auth) files
    const authDir = path.join(__dirname, '../wa_auth');
    let authDeleted = 0;
    if (fs.existsSync(authDir)) {
      for (const f of fs.readdirSync(authDir)) {
        try { fs.unlinkSync(path.join(authDir, f)); authDeleted++; } catch (_) {}
      }
    }

    res.json({ success: true, mediaDeleted, authDeleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WA Broadcast Groups ─────────────────────────────────────────────────────
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_broadcast_groups (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(200) NOT NULL,
        description TEXT,
        created_by  INT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_broadcast_group_members (
        group_id   INT NOT NULL REFERENCES wa_broadcast_groups(id) ON DELETE CASCADE,
        jid        VARCHAR(100) NOT NULL,
        name       VARCHAR(200),
        added_at   TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (group_id, jid)
      )
    `);
  } catch (e) { console.error('[WA Groups] Table init:', e.message); }
})();

router.get('/groups', authenticate, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT g.id, g.name, g.description, g.created_at,
             COUNT(m.jid)::int AS member_count
      FROM wa_broadcast_groups g
      LEFT JOIN wa_broadcast_group_members m ON m.group_id = g.id
      GROUP BY g.id ORDER BY g.name ASC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/groups', authenticate, async (req, res) => {
  const { name, description, members } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Group name required' });
  try {
    const r = await pool.query(
      `INSERT INTO wa_broadcast_groups (name, description, created_by) VALUES ($1,$2,$3) RETURNING *`,
      [name.trim(), description || null, req.user.id]
    );
    const group = r.rows[0];
    if (Array.isArray(members) && members.length) {
      const vals = members.map((m, i) => `($1,$${i*2+2},$${i*2+3})`).join(',');
      const params = [group.id];
      members.forEach(m => { params.push(String(m.jid || '').trim(), String(m.name || '').trim()); });
      await pool.query(
        `INSERT INTO wa_broadcast_group_members (group_id,jid,name) VALUES ${vals} ON CONFLICT DO NOTHING`,
        params
      );
    }
    const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM wa_broadcast_group_members WHERE group_id=$1`, [group.id]);
    group.member_count = cnt.rows[0].n;
    res.status(201).json(group);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/groups/:id', authenticate, async (req, res) => {
  try {
    const g = await pool.query(`SELECT * FROM wa_broadcast_groups WHERE id=$1`, [req.params.id]);
    if (!g.rowCount) return res.status(404).json({ error: 'Not found' });
    const m = await pool.query(`SELECT jid, name FROM wa_broadcast_group_members WHERE group_id=$1 ORDER BY name`, [req.params.id]);
    res.json({ ...g.rows[0], members: m.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/groups/:id', authenticate, async (req, res) => {
  try {
    await pool.query(`DELETE FROM wa_broadcast_groups WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/groups/:id/members', authenticate, async (req, res) => {
  const { members } = req.body; // [{jid, name}]
  if (!Array.isArray(members) || !members.length) return res.status(400).json({ error: 'members[] required' });
  try {
    const vals = members.map((m, i) => `($1,$${i*2+2},$${i*2+3})`).join(',');
    const params = [req.params.id];
    members.forEach(m => { params.push(String(m.jid || '').trim(), String(m.name || '').trim()); });
    await pool.query(
      `INSERT INTO wa_broadcast_group_members (group_id,jid,name) VALUES ${vals} ON CONFLICT (group_id,jid) DO UPDATE SET name=EXCLUDED.name`,
      params
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/groups/:id/members', authenticate, async (req, res) => {
  const { jids } = req.body;
  if (!Array.isArray(jids) || !jids.length) return res.status(400).json({ error: 'jids[] required' });
  try {
    await pool.query(`DELETE FROM wa_broadcast_group_members WHERE group_id=$1 AND jid=ANY($2)`, [req.params.id, jids]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── WA Contacts Search — GET /api/wa/contacts/search?q= ─────────────────────
// Fast autocomplete: searches enriched_contacts + wa_chats by name or phone digits
router.get('/contacts/search', authenticate, async (req, res) => {
  const accountPhone = connectedAccount(res);
  if (!accountPhone) return;
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const digits = q.replace(/\D/g, '');
  try {
    const result = await pool.query(`
      SELECT jid, name, phone, is_group FROM (
        -- Individual contacts from enriched_contacts
        SELECT
          CASE
            WHEN regexp_replace(COALESCE(ec.phone,''),'[^0-9]','','g') ~ '^[0-9]{7,15}$'
              THEN regexp_replace(ec.phone,'[^0-9]','','g') || '@s.whatsapp.net'
            ELSE ec.jid
          END AS jid,
          COALESCE(NULLIF(ec.crm_name,''), NULLIF(ec.name,''), NULLIF(ec.notify,''), split_part(ec.jid,'@',1)) AS name,
          regexp_replace(COALESCE(ec.phone,''),'[^0-9]','','g') AS phone,
          false AS is_group
        FROM enriched_contacts ec
        WHERE ec.account_phone = $1
          AND ec.jid IS NOT NULL AND ec.jid <> ''
          AND ec.jid NOT LIKE '%@newsletter' AND ec.jid NOT LIKE '%@broadcast'
          AND regexp_replace(COALESCE(ec.phone,''),'[^0-9]','','g') ~ '^[0-9]{7,14}$'
          AND (
            COALESCE(ec.crm_name, ec.name, ec.notify, '') ILIKE $2
            OR ($3 <> '' AND regexp_replace(COALESCE(ec.phone,''),'[^0-9]','','g') LIKE $4)
          )
        UNION ALL
        -- WA groups from wa_chats (only groups with a real non-numeric name)
        SELECT c.id AS jid,
          c.name AS name,
          '' AS phone,
          true AS is_group
        FROM wa_chats c
        WHERE c.account_phone = $1
          AND c.id LIKE '%@g.us'
          AND c.name IS NOT NULL AND c.name != ''
          AND c.name !~ '^[0-9]{10,}$'
          AND c.name NOT ILIKE 'group'
          AND c.name ILIKE $2
      ) t
      ORDER BY is_group ASC, name ASC
      LIMIT 20
    `, [accountPhone, '%' + q + '%', digits, '%' + digits + '%']);
    res.json(result.rows.map(r => ({
      jid: r.jid,
      name: r.name,
      phone: r.phone,
      isGroup: r.is_group,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark chat read — POST /api/wa/chats/:jid/read
router.post('/chats/:jid/read', authenticate, async (req, res) => {
  const accountPhone = connectedAccount(res);
  if (!accountPhone) return;
  const jid = normalizeWaRouteJid(decodeURIComponent(req.params.jid));
  try {
    await wa.markChatRead(jid);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark chat unread — POST /api/wa/chats/:jid/unread
router.post('/chats/:jid/unread', authenticate, async (req, res) => {
  const accountPhone = connectedAccount(res);
  if (!accountPhone) return;
  const jid = normalizeWaRouteJid(decodeURIComponent(req.params.jid));
  try {
    await wa.markChatUnread(jid);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get all labels — GET /api/wa/labels
router.get('/labels', authenticate, async (req, res) => {
  const accountPhone = connectedAccount(res);
  if (!accountPhone) return;
  try {
    const labels = await pool.query(
      `SELECT l.id, l.name, l.color,
         COALESCE(json_agg(a.chat_id) FILTER (WHERE a.chat_id IS NOT NULL), '[]') AS chats
       FROM wa_labels l
       LEFT JOIN wa_label_associations a ON a.label_id=l.id AND a.account_phone=l.account_phone
       WHERE l.account_phone=$1
       GROUP BY l.id, l.name, l.color`, [accountPhone]);
    res.json(labels.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add label to chat — POST /api/wa/chats/:jid/labels/:labelId
router.post('/chats/:jid/labels/:labelId', authenticate, async (req, res) => {
  const accountPhone = connectedAccount(res);
  if (!accountPhone) return;
  const jid = normalizeWaRouteJid(decodeURIComponent(req.params.jid));
  const { labelId } = req.params;
  try {
    await wa.addChatLabel(jid, labelId);
    await pool.query(`INSERT INTO wa_label_associations (label_id,account_phone,chat_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [labelId, accountPhone, jid]);
    const lbl = await pool.query(`SELECT name FROM wa_labels WHERE id=$1 LIMIT 1`, [labelId]).catch(() => ({ rows: [] }));
    pool.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'wa_label_add','whatsapp_chat',$2,$3)`,
      [req.user?.id, jid, `Added label "${lbl.rows[0]?.name || labelId}" to chat ${jid}`]
    ).catch(() => {});
    wa.emitEvent('wa:labels_updated', { type: 'association', association: { labelId, chatId: jid }, action: 'add' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Remove label from chat — DELETE /api/wa/chats/:jid/labels/:labelId
router.delete('/chats/:jid/labels/:labelId', authenticate, async (req, res) => {
  const accountPhone = connectedAccount(res);
  if (!accountPhone) return;
  const jid = normalizeWaRouteJid(decodeURIComponent(req.params.jid));
  const { labelId } = req.params;
  try {
    await wa.removeChatLabel(jid, labelId);
    const lbl2 = await pool.query(`SELECT name FROM wa_labels WHERE id=$1 LIMIT 1`, [labelId]).catch(() => ({ rows: [] }));
    pool.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'wa_label_remove','whatsapp_chat',$2,$3)`,
      [req.user?.id, jid, `Removed label "${lbl2.rows[0]?.name || labelId}" from chat ${jid}`]
    ).catch(() => {});
    await pool.query(`DELETE FROM wa_label_associations WHERE label_id=$1 AND account_phone=$2 AND chat_id=$3`,
      [labelId, accountPhone, jid]);
    wa.emitEvent('wa:labels_updated', { type: 'association', association: { labelId, chatId: jid }, action: 'remove' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update WA contact name — PUT /api/wa/contacts/:jid
router.put('/contacts/:jid', authenticate, async (req, res) => {
  const accountPhone = connectedAccount(res);
  if (!accountPhone) return;
  const jid = decodeURIComponent(req.params.jid);
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    // Duplicate-name check: reject if a different contact already has this name
    const dupCheck = await pool.query(
      `SELECT jid FROM wa_contacts WHERE LOWER(TRIM(name)) = LOWER($1) AND account_phone = $2 AND jid != $3 LIMIT 1`,
      [name, accountPhone, jid]
    );
    if (dupCheck.rowCount > 0) {
      return res.status(409).json({ error: `Name "${name}" is already used by another WA contact. Use a unique name.` });
    }
    await pool.query(`
      INSERT INTO wa_contacts (jid, account_phone, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (jid, account_phone) DO UPDATE SET name = $3, updated_at = NOW()
    `, [jid, accountPhone, name]);
    // Also update wa_chats display name
    await pool.query(`UPDATE wa_chats SET name=$1 WHERE id=$2 AND account_phone=$3`, [name, jid, accountPhone]);
    pool.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'wa_contact_save','whatsapp_contact',$2,$3)`,
      [req.user?.id, jid, `Saved WA contact name "${name}" for ${jid}`]
    ).catch(() => {});
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

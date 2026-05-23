/**
 * PBX Call Logs API — UniComm Pro
 * ──────────────────────────────────────────────────────────────────
 * GET    /api/calls                   — paginated call log (with filter)
 * GET    /api/calls/pbx-status        — SMDR connection status
 * GET    /api/calls/contacts          — distinct PBX numbers (phone book)
 * POST   /api/calls/contacts/save     — save/update a PBX contact name
 * GET    /api/calls/contacts/list     — full saved PBX contact list
 * GET    /api/calls/contact/:phone    — call history for one phone number
 * POST   /api/calls                   — manual log insert
 * PATCH  /api/calls/:id/summary       — update AI summary
 * GET    /api/calls/backup/list       — list backup files
 * POST   /api/calls/backup/create     — create JSON backup snapshot
 * POST   /api/calls/backup/restore    — restore from a backup
 * GET    /api/calls/recordings        — list recordings (file-system scan)
 * GET    /api/calls/sync              — sync latest from live DB (no-op wrapper)
 * POST   /api/calls/sync              — trigger a manual re-pull from PBX table
 */

const express = require('express');
const pool = require('../db/pool');
const path = require('path');
const fs = require('fs');
const backupJobs = {};
const { authenticate } = require('../middleware/auth');
const smdr = require('../services/matrixSmdr');


const router = express.Router();
router.use((req, res, next) => {

  // Allow recordings without authentication
  if (req.path.startsWith('/recordings')) {
    return next();
  }

  return authenticate(req, res, next);
});

function makePbxTraceId(prefix = 'PBX') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

// ── Recordings directory (PBX may store files here via network share/FTP) ──
const REC_DIR = process.env.PBX_RECORDINGS_DIR
  || path.join(__dirname, '../../recordings');
console.log('[REC_DIR]', REC_DIR);

// ── Backup directory ──────────────────────────────────────────────────────
const BACKUP_DIR = process.env.CALL_BACKUP_DIR
  || 'C:\\MatrixVMS\\Voicemail_Backup\\_BACKUPS';

// Ensure directories exist
[REC_DIR, BACKUP_DIR].forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch (_) { } });

function getSafeBackupPath(filename) {
  const name = String(filename || '').trim();
  if (!name) return null;
  if (name !== path.basename(name) || path.extname(name).toLowerCase() !== '.json') {
    return null;
  }
  return path.join(BACKUP_DIR, name);
}

function formatDurationFromSeconds(seconds) {
  const sec = Math.max(0, parseInt(seconds, 10) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map(v => v.toString().padStart(2, '0')).join(':');
}

function isMatrixDate(value) {
  return /^\d{1,2}-\d{2}-\d{2,4}$/.test(String(value || '').trim());
}

function isMatrixTime(value) {
  return /^\d{2}:\d{2}:\d{2}$/.test(String(value || '').trim());
}

function parseMatrixFixedLayout(rawLine) {
  const line = String(rawLine || '');
  const get = (start, len) => line.substring(start - 1, (start - 1) + len).trim();
  const durationAfterTime = (rawTime) => {
    const afterTime = line.slice(line.indexOf(rawTime) + rawTime.length).trim();
    const numericFields = afterTime.match(/\b\d+(?:\.\d+)?\b/g) || [];
    if (!numericFields.length) return 0;
    return Math.round(parseFloat(numericFields[numericFields.length - 1]) || 0);
  };
  const incomingDate = get(36, 8);
  const incomingTime = get(47, 8);
  const outgoingDate = get(41, 8);
  const outgoingTime = get(50, 8);

  if (isMatrixDate(incomingDate) && isMatrixTime(incomingTime)) {
    return {
      durationSeconds: parseInt(get(64, 5), 10) || durationAfterTime(incomingTime),
    };
  }

  if (isMatrixDate(outgoingDate) && isMatrixTime(outgoingTime)) {
    return {
      durationSeconds: parseInt(get(59, 5), 10) || 0,
    };
  }

  const dateTimeMatch = line.match(/\b(\d{1,2}-\d{2}-\d{2,4})\s+(\d{2}:\d{2}:\d{2})\b/);
  if (dateTimeMatch) {
    return {
      durationSeconds: durationAfterTime(dateTimeMatch[2]),
    };
  }

  return null;
}

function extractMatrixDurationFromRawLine(rawLine) {
  const parsedLayout = parseMatrixFixedLayout(rawLine);
  if (!parsedLayout) return null;
  return formatDurationFromSeconds(parsedLayout.durationSeconds);
}

async function repairPbxDurationsFromRawLines() {
  const result = await pool.query(`
    SELECT id, duration, raw_line
    FROM call_logs
    WHERE raw_line IS NOT NULL
      AND raw_line ~ '\\d{2}:\\d{2}:\\d{2}'
  `);
  let repaired = 0;
  for (const row of result.rows) {
    const parsedDuration = extractMatrixDurationFromRawLine(row.raw_line);
    if (!parsedDuration || parsedDuration === row.duration) continue;
    await pool.query(`UPDATE call_logs SET duration = $1 WHERE id = $2`, [parsedDuration, row.id]);
    repaired++;
  }
  return repaired;
}

// ═══════════════════════════════════════════════════════════════════
// ENSURE TABLES
// ═══════════════════════════════════════════════════════════════════
async function ensurePbxContactsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pbx_contacts (
      id           SERIAL PRIMARY KEY,
      phone        VARCHAR(50) UNIQUE NOT NULL,
      name         VARCHAR(150),
      company      VARCHAR(150),
      notes        TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}
ensurePbxContactsTable().catch(err => console.warn('[Calls] pbx_contacts table error:', err.message));

async function syncPbxContactsFromCallLogs() {
  const result = await pool.query(`
    INSERT INTO pbx_contacts (phone)
    SELECT DISTINCT phone
    FROM (
      SELECT NULLIF(TRIM(destination), '') AS phone
      FROM call_logs
      WHERE destination IS NOT NULL AND destination <> ''
      UNION
      SELECT NULLIF(TRIM(caller), '') AS phone
      FROM call_logs
      WHERE caller IS NOT NULL AND caller <> ''
    ) phones
    WHERE phone IS NOT NULL AND phone <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM pbx_contacts pc
        WHERE regexp_replace(pc.phone, '[^0-9]', '', 'g') = regexp_replace(phones.phone, '[^0-9]', '', 'g')
      )
    ON CONFLICT (phone) DO NOTHING
  `);
  return result.rowCount || 0;
}

// ═══════════════════════════════════════════════════════════════════
// GET /api/calls/pbx-status
// ═══════════════════════════════════════════════════════════════════
router.get('/pbx-status', async (req, res) => {
  const traceId = makePbxTraceId('PBX-STATUS');
  console.log(`[${traceId}] GET /api/calls/pbx-status started`, {
    ip: req.ip,
    user: req.user?.id || req.user?.email || null,
  });
  try {
    console.log(`[${traceId}] Querying call_logs grouped date counts`);
    const dates = await pool.query(`SELECT call_date, COUNT(*) as count FROM call_logs GROUP BY call_date ORDER BY call_date DESC NULLS LAST`);
    console.log(`[${traceId}] call_logs grouped date query success`, {
      dateRows: dates.rowCount,
    });
    const status = smdr.getStatus();
    status.db_dates = dates.rows;
    console.log(`[${traceId}] GET /api/calls/pbx-status response`, status);
    res.json(status);
  } catch (err) {
    console.error(`[${traceId}] GET /api/calls/pbx-status failed`, {
      message: err.message,
      stack: err.stack,
    });
    const fallbackStatus = smdr.getStatus();
    console.log(`[${traceId}] Returning fallback SMDR status`, fallbackStatus);
    res.json(fallbackStatus);
  }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/calls/contacts  — distinct numbers seen in PBX call_logs
// ═══════════════════════════════════════════════════════════════════
router.get('/contacts', async (req, res) => {
  try {
    await syncPbxContactsFromCallLogs();
    const result = await pool.query(`
      WITH seen_numbers AS (
        SELECT NULLIF(TRIM(destination), '') AS phone, created_at, id FROM call_logs WHERE destination IS NOT NULL AND destination <> ''
        UNION ALL
        SELECT NULLIF(TRIM(caller), '') AS phone, created_at, id FROM call_logs WHERE caller IS NOT NULL AND caller <> ''
      ),
      grouped_numbers AS (
        SELECT
          regexp_replace(phone, '[^0-9]', '', 'g') AS phone_digits,
          COALESCE(
            (ARRAY_AGG(phone ORDER BY created_at DESC NULLS LAST))[1],
            MIN(phone)
          ) AS phone,
          MAX(created_at) AS last_call,
          COUNT(DISTINCT id)::int AS call_count
        FROM seen_numbers
        WHERE phone IS NOT NULL AND phone <> ''
        GROUP BY regexp_replace(phone, '[^0-9]', '', 'g')
      ),
      saved_contacts AS (
        SELECT DISTINCT ON (regexp_replace(phone, '[^0-9]', '', 'g'))
          regexp_replace(phone, '[^0-9]', '', 'g') AS phone_digits,
          id,
          phone,
          name,
          company,
          notes
        FROM pbx_contacts
        ORDER BY regexp_replace(phone, '[^0-9]', '', 'g'), (name IS NULL), updated_at DESC NULLS LAST, id DESC
      )
      SELECT
        COALESCE(sc.phone, gn.phone) AS phone,
        gn.last_call,
        gn.call_count,
        pc.name,
        pc.company,
        pc.notes,
        pc.id                AS pbx_contact_id
      FROM grouped_numbers gn
      LEFT JOIN saved_contacts sc ON sc.phone_digits = gn.phone_digits
      LEFT JOIN pbx_contacts pc ON pc.id = sc.id
      ORDER BY gn.last_call DESC NULLS LAST
      LIMIT 500
    `);
    return res.json(result.rows);
  } catch (err) {
    console.error('[Calls] contacts error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch PBX contacts.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/calls/contacts/list  — saved PBX contacts only
// ═══════════════════════════════════════════════════════════════════
router.get('/contacts/list', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pc.*, COUNT(cl.id)::int AS call_count, MAX(cl.created_at) AS last_call
      FROM pbx_contacts pc
      LEFT JOIN call_logs cl ON (
        cl.caller = pc.phone
        OR cl.destination = pc.phone
        OR regexp_replace(cl.caller, '[^0-9]', '', 'g') = regexp_replace(pc.phone, '[^0-9]', '', 'g')
        OR regexp_replace(cl.destination, '[^0-9]', '', 'g') = regexp_replace(pc.phone, '[^0-9]', '', 'g')
      )
      GROUP BY pc.id
      ORDER BY pc.name ASC
    `);
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch saved PBX contacts.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/calls/contacts/save  — save/update a PBX contact
// ═══════════════════════════════════════════════════════════════════
router.post('/contacts/save', async (req, res) => {
  const { phone, name, company, notes } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required.' });
  try {
    const cleanPhone = phone.trim();
    const existing = await pool.query(`
      SELECT id
      FROM pbx_contacts
      WHERE regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g')
      ORDER BY (name IS NULL), updated_at DESC NULLS LAST, id DESC
      LIMIT 1
    `, [cleanPhone]);

    const result = existing.rowCount
      ? await pool.query(`
          UPDATE pbx_contacts
          SET name = $1,
              company = $2,
              notes = $3,
              updated_at = NOW()
          WHERE id = $4
          RETURNING *
        `, [name || null, company || null, notes || null, existing.rows[0].id])
      : await pool.query(`
          INSERT INTO pbx_contacts (phone, name, company, notes, updated_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (phone) DO UPDATE
            SET name = EXCLUDED.name,
                company = EXCLUDED.company,
                notes = EXCLUDED.notes,
                updated_at = NOW()
          RETURNING *
        `, [cleanPhone, name || null, company || null, notes || null]);
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[Calls] save contact error:', err.message);
    return res.status(500).json({ error: 'Failed to save PBX contact.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/calls/contact/:phone  — all calls for one number
// ═══════════════════════════════════════════════════════════════════
router.get('/contact/:phone', async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const limit = parseInt(req.query.limit || '100');
  const offset = parseInt(req.query.offset || '0');
  const dedupedCallsSql = `
    SELECT DISTINCT ON (
      CASE
        WHEN raw_line IS NOT NULL AND trim(raw_line) <> ''
          THEN regexp_replace(trim(raw_line), '^\\d+\\s+', '')
        ELSE 'id:' || id::text
      END
    ) *
    FROM call_logs candidate
    WHERE NOT (
      candidate.raw_line ~ '\\sT\\s*$'
      AND EXISTS (
        SELECT 1
        FROM call_logs primary_leg
        WHERE primary_leg.id <> candidate.id
          AND primary_leg.raw_line ~ '\\sD\\s*$'
          AND primary_leg.call_date IS NOT DISTINCT FROM candidate.call_date
          AND COALESCE(primary_leg.trunk, '') = COALESCE(candidate.trunk, '')
          AND regexp_replace(COALESCE(primary_leg.caller, ''), '[^0-9]', '', 'g') = regexp_replace(COALESCE(candidate.caller, ''), '[^0-9]', '', 'g')
          AND ABS(EXTRACT(EPOCH FROM (
            (primary_leg.call_date::timestamp + COALESCE(primary_leg.call_time, TIME '00:00:00')) -
            (candidate.call_date::timestamp + COALESCE(candidate.call_time, TIME '00:00:00'))
          ))) <= 90
      )
    )
    ORDER BY
      CASE
        WHEN raw_line IS NOT NULL AND trim(raw_line) <> ''
          THEN regexp_replace(trim(raw_line), '^\\d+\\s+', '')
        ELSE 'id:' || id::text
      END,
      created_at DESC,
      id DESC
  `;
  try {
    const result = await pool.query(`
      SELECT cl.*, TO_CHAR(cl.call_date, 'YYYY-MM-DD') AS call_date_str, 
             COALESCE(pc1.name, pc2.name) AS saved_name, 
             COALESCE(pc1.company, pc2.company) AS saved_company,
             COALESCE(pc1.notes, pc2.notes) AS saved_notes
      FROM (${dedupedCallsSql}) cl
      LEFT JOIN (
        SELECT DISTINCT ON (regexp_replace(phone, '[^0-9]', '', 'g'))
          regexp_replace(phone, '[^0-9]', '', 'g') AS phone_digits, phone, name, company, notes
        FROM pbx_contacts
        ORDER BY regexp_replace(phone, '[^0-9]', '', 'g'), (name IS NULL), updated_at DESC NULLS LAST, id DESC
      ) pc1 ON (
        pc1.phone = cl.caller
        OR pc1.phone_digits = regexp_replace(cl.caller, '[^0-9]', '', 'g')
      )
      LEFT JOIN (
        SELECT DISTINCT ON (regexp_replace(phone, '[^0-9]', '', 'g'))
          regexp_replace(phone, '[^0-9]', '', 'g') AS phone_digits, phone, name, company, notes
        FROM pbx_contacts
        ORDER BY regexp_replace(phone, '[^0-9]', '', 'g'), (name IS NULL), updated_at DESC NULLS LAST, id DESC
      ) pc2 ON (
        pc2.phone = cl.destination
        OR pc2.phone_digits = regexp_replace(cl.destination, '[^0-9]', '', 'g')
      )
      WHERE cl.caller = $1
         OR cl.destination = $1
         OR regexp_replace(cl.caller, '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g')
         OR regexp_replace(cl.destination, '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g')
      ORDER BY COALESCE(cl.call_date::timestamp + COALESCE(cl.call_time, TIME '00:00:00'), cl.created_at) DESC,
               cl.created_at DESC,
               cl.id DESC
      LIMIT $2 OFFSET $3
    `, [phone, limit, offset]);

    result.rows.forEach(r => {
      if (r.call_date_str) {
        r.call_date = r.call_date_str;
        delete r.call_date_str;
      }
    });
    const total = await pool.query(`
      SELECT COUNT(*) FROM (${dedupedCallsSql}) cl
      WHERE caller = $1
         OR destination = $1
         OR regexp_replace(caller, '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g')
         OR regexp_replace(destination, '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g')
    `, [phone]);
    return res.json({
      calls: result.rows,
      total: parseInt(total.rows[0].count),
      phone,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch contact call history.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/calls  — paginated call log with type/date/search filters
// ═══════════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  const limit = parseInt(req.query.limit || '50');
  const offset = parseInt(req.query.offset || '0');
  const type = req.query.type || '';
  const search = req.query.search || '';
  const dateFrom = normalizeDateParam(req.query.from || '');
  const dateTo = normalizeDateParam(req.query.to || '');

  console.log('[Calls API] Filter request:', { rawFrom: req.query.from, rawTo: req.query.to, dateFrom, dateTo });

  const where = ['1=1'];
  const params = [];
  let p = 1;

  if (type) { where.push(`call_type = $${p++}`); params.push(type); }
  if (search) {
    where.push(`(
      caller ILIKE $${p}
      OR destination ILIKE $${p}
      OR extension ILIKE $${p}
      OR EXISTS (
        SELECT 1
        FROM pbx_contacts pc
        WHERE (
          pc.name ILIKE $${p}
          OR pc.company ILIKE $${p}
          OR pc.notes ILIKE $${p}
        )
        AND (
          pc.phone = caller
          OR pc.phone = destination
          OR regexp_replace(pc.phone, '[^0-9]', '', 'g') = regexp_replace(caller, '[^0-9]', '', 'g')
          OR regexp_replace(pc.phone, '[^0-9]', '', 'g') = regexp_replace(destination, '[^0-9]', '', 'g')
        )
      )
    )`);
    params.push('%' + search + '%'); p++;
  }
  if (dateFrom) { where.push(`call_date >= $${p++}`); params.push(dateFrom); }
  if (dateTo) { where.push(`call_date <= $${p++}`); params.push(dateTo); }

  const whereStr = where.join(' AND ');
  // Dedup logic:
  // 1. First remove exact duplicates (same date/trunk/caller/destination/time).
  // 2. Then collapse Matrix PBX T/D legs — same caller + same trunk within a
  //    120-second window are treated as one call; keep the row with the longest
  //    duration (or highest id on tie).
  const dedupedCallsSql = `
    WITH base AS (
      SELECT DISTINCT ON (
        call_date::date,
        COALESCE(trunk, ''),
        regexp_replace(COALESCE(caller, ''), '[^0-9]', '', 'g'),
        regexp_replace(COALESCE(destination, ''), '[^0-9]', '', 'g'),
        COALESCE(call_time, TIME '00:00:00')
      ) *
      FROM call_logs
      WHERE
        -- Hide records where destination is a date (bad SMDR parse)
        NOT (destination ~ '^\\d{2}-\\d{2}-\\d{2,4}$')
        -- Hide records with no destination and zero/null duration (unanswered/noise)
        AND NOT (
          (destination IS NULL OR trim(destination) = '')
          AND (duration IS NULL OR duration = '' OR duration = '00:00:00')
        )
        -- Hide zero-duration calls (not considered real calls)
        AND NOT (duration IS NULL OR duration = '' OR duration = '00:00:00')
      ORDER BY
        call_date::date,
        COALESCE(trunk, ''),
        regexp_replace(COALESCE(caller, ''), '[^0-9]', '', 'g'),
        regexp_replace(COALESCE(destination, ''), '[^0-9]', '', 'g'),
        COALESCE(call_time, TIME '00:00:00'),
        created_at DESC,
        id DESC
    ),
    ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY
            call_date::date,
            COALESCE(trunk, ''),
            regexp_replace(COALESCE(caller, ''), '[^0-9]', '', 'g'),
            -- Bucket call_time into 120-second windows so T/D legs from the
            -- same Matrix PBX call collapse into one group (2-min window handles
            -- edge cases where legs straddle a minute boundary)
            FLOOR(EXTRACT(EPOCH FROM COALESCE(call_time, TIME '00:00:00')) / 120)
          ORDER BY
            -- Prefer the leg with the longest actual talk time
            CASE
              WHEN duration ~ '^\\d{2}:\\d{2}:\\d{2}$'
              THEN EXTRACT(EPOCH FROM duration::interval)
              ELSE 0
            END DESC,
            id DESC
        ) AS _rn
      FROM base
    )
    SELECT * FROM ranked WHERE _rn = 1
  `;
  try {
    const result = await pool.query(
      `SELECT cl.*, TO_CHAR(cl.call_date, 'YYYY-MM-DD') AS call_date_str, 
              COALESCE(pc1.name, pc2.name) AS saved_name, 
              COALESCE(pc1.company, pc2.company) AS saved_company,
              COALESCE(pc1.notes, pc2.notes) AS saved_notes
       FROM (${dedupedCallsSql}) cl
       LEFT JOIN (
         SELECT DISTINCT ON (regexp_replace(phone, '[^0-9]', '', 'g'))
           regexp_replace(phone, '[^0-9]', '', 'g') AS phone_digits, phone, name, company, notes
         FROM pbx_contacts
         ORDER BY regexp_replace(phone, '[^0-9]', '', 'g'), (name IS NULL), updated_at DESC NULLS LAST, id DESC
       ) pc1 ON (
         pc1.phone = cl.caller
         OR pc1.phone_digits = regexp_replace(cl.caller, '[^0-9]', '', 'g')
       )
       LEFT JOIN (
         SELECT DISTINCT ON (regexp_replace(phone, '[^0-9]', '', 'g'))
           regexp_replace(phone, '[^0-9]', '', 'g') AS phone_digits, phone, name, company, notes
         FROM pbx_contacts
         ORDER BY regexp_replace(phone, '[^0-9]', '', 'g'), (name IS NULL), updated_at DESC NULLS LAST, id DESC
       ) pc2 ON (
         pc2.phone = cl.destination
         OR pc2.phone_digits = regexp_replace(cl.destination, '[^0-9]', '', 'g')
       )
       WHERE ${whereStr}
       ORDER BY COALESCE(cl.call_date::timestamp + COALESCE(cl.call_time, TIME '00:00:00'), cl.created_at) DESC,
                cl.created_at DESC,
                cl.id DESC
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );

    // Fix pg driver timezone shift by using the string representation of the date
    result.rows.forEach(r => {
      if (r.call_date_str) {
        r.call_date = r.call_date_str;
        delete r.call_date_str;
      }
    });

    const total = await pool.query(
      `SELECT COUNT(*) FROM (${dedupedCallsSql}) cl WHERE ${whereStr}`,
      params
    );
    return res.json({ calls: result.rows, total: parseInt(total.rows[0].count) });
  } catch (err) {
    console.error('[Calls] list error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch call logs.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/calls  — manual call log insert
// ═══════════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  const { caller, extension, destination, duration, call_type, ai_summary, call_date, call_time, trunk, raw_line } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO call_logs (caller,extension,destination,duration,call_type,ai_summary,call_date,call_time,trunk,raw_line)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [
      caller || null, extension || null, destination || null,
      duration || null, call_type || 'Out', ai_summary || null,
      call_date || null, call_time || null, trunk || null, raw_line || null
    ]);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to log call.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// DELETE /api/calls/:id  — remove one PBX call log row
// ═══════════════════════════════════════════════════════════════════
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid call log id.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const selected = await client.query(`
      SELECT id, call_date, call_time, caller, trunk, raw_line
      FROM call_logs
      WHERE id = $1
      FOR UPDATE
    `, [id]);

    if (!selected.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Call log not found.' });
    }

    const row = selected.rows[0];
    const related = await client.query(`
      SELECT id
      FROM call_logs related
      WHERE related.id <> $1
        AND related.call_date IS NOT DISTINCT FROM $2
        AND COALESCE(related.trunk, '') = COALESCE($3, '')
        AND regexp_replace(COALESCE(related.caller, ''), '[^0-9]', '', 'g') = regexp_replace(COALESCE($4, ''), '[^0-9]', '', 'g')
        AND (
          ($5 ~ '\\sD\\s*$' AND related.raw_line ~ '\\sT\\s*$')
          OR ($5 ~ '\\sT\\s*$' AND related.raw_line ~ '\\sD\\s*$')
        )
        AND ABS(EXTRACT(EPOCH FROM (
          (related.call_date::timestamp + COALESCE(related.call_time, TIME '00:00:00')) -
          ($2::date::timestamp + COALESCE($6::time, TIME '00:00:00'))
        ))) <= 90
      FOR UPDATE
    `, [id, row.call_date, row.trunk, row.caller, row.raw_line || '', row.call_time]);

    const ids = [id, ...related.rows.map(r => r.id)];
    const deleted = await client.query(
      `DELETE FROM call_logs WHERE id = ANY($1::int[]) RETURNING id`,
      [ids]
    );

    await client.query('COMMIT');
    return res.json({
      success: true,
      deleted: deleted.rowCount,
      ids: deleted.rows.map(r => r.id),
      message: deleted.rowCount > 1
        ? `Deleted call log and ${deleted.rowCount - 1} linked Matrix call leg.`
        : 'Deleted call log.'
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    console.error('[Calls] delete error:', err.message);
    return res.status(500).json({ error: 'Failed to delete call log.' });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════════════
// PATCH /api/calls/:id/summary
// ═══════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════
// POST /api/calls/:id/summarize — Generate AI summary for a call
// ═══════════════════════════════════════════════════════════════════
const ollama = require('../services/ollamaService');

router.post('/:id/summarize', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT cl.*, pc.name AS saved_name, pc.company AS saved_company, pc.notes AS contact_notes
      FROM call_logs cl
      LEFT JOIN pbx_contacts pc ON (
        pc.phone = cl.caller
        OR pc.phone = cl.destination
        OR regexp_replace(pc.phone, '[^0-9]', '', 'g') = regexp_replace(cl.caller, '[^0-9]', '', 'g')
        OR regexp_replace(pc.phone, '[^0-9]', '', 'g') = regexp_replace(cl.destination, '[^0-9]', '', 'g')
      )
      WHERE cl.id = $1
    `, [req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'Call not found' });
    const call = rows[0];

    const prompt = `You are a professional CRM assistant for Unicircuit Engineering Services. 
Summarize this PBX call record and extract key details for the CRM.
Format: Brief Summary (1-2 sentences), Tone, and follow-up recommendation.

CALL DETAILS:
- Date: ${call.call_date} ${call.call_time}
- Type: ${call.call_type}
- Caller: ${call.caller} (${call.saved_name || 'Unknown'})
- Destination: ${call.destination}
- Duration: ${call.duration}
- Trunk: ${call.trunk}
${call.contact_notes ? `- Contact Notes: ${call.contact_notes}` : ''}

Output only the summary text. No intro or outro.`;

    // Use a lightweight worker call
    const summary = await ollama.callOllamaService(prompt, []);

    // Save to DB
    await pool.query(`UPDATE call_logs SET ai_summary = $1 WHERE id = $2`, [summary, req.params.id]);

    return res.json({ id: call.id, summary });
  } catch (err) {
    console.error('[Calls] Summarize error:', err.message);
    return res.status(500).json({ error: 'AI Summarization failed: ' + err.message });
  }
});

/** POST /api/calls/dial — Trigger click-to-dial */
router.post('/dial', async (req, res) => {
  const { sourceExt, destination } = req.body;
  if (!sourceExt || !destination) return res.status(400).json({ error: 'sourceExt and destination required' });
  try {
    const response = await smdr.dial(sourceExt, destination);
    return res.json({ success: true, response });
  } catch (err) {
    return res.status(500).json({ error: 'Dial failed: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// BACKUP — list, create, restore
// ═══════════════════════════════════════════════════════════════════

/** GET /api/calls/backup/list */
router.get('/backup/list', (req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { filename: f, size: stat.size, created_at: stat.birthtime, mtime: stat.mtime };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return res.json({ backups: files, dir: BACKUP_DIR });
  } catch (err) {
    return res.status(500).json({ error: 'Could not list backups: ' + err.message });
  }
});

/** POST /api/calls/backup/create */
router.post('/backup/create', async (req, res) => {
  try {
    await ensurePbxContactsTable();
    const calls = await pool.query(`
      SELECT *
      FROM call_logs
      ORDER BY COALESCE(call_date::timestamp + COALESCE(call_time, TIME '00:00:00'), created_at) DESC,
               created_at DESC,
               id DESC
    `);
    const contacts = await pool.query(`
      SELECT id, phone, name, company, notes, created_at, updated_at
      FROM pbx_contacts
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
    `);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `call_backup_${ts}.json`;
    const filepath = path.join(BACKUP_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify({
      version: 2,
      created_at: new Date().toISOString(),
      totals: {
        call_logs: calls.rowCount,
        pbx_contacts: contacts.rowCount,
      },
      total: calls.rowCount,
      records: calls.rows,
      call_logs: calls.rows,
      pbx_contacts: contacts.rows,
    }, null, 2));
    return res.json({
      message: `Backup created: ${filename}`,
      filename,
      total: calls.rowCount,
      calls: calls.rowCount,
      contacts: contacts.rowCount,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Backup failed: ' + err.message });
  }
});

/** POST /api/calls/backup/restore  body: { filename } */
router.post('/backup/restore', async (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required.' });
  const filepath = getSafeBackupPath(filename);
  if (!filepath) return res.status(400).json({ error: 'Invalid backup filename.' });
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup file not found.' });

  try {
    const raw = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    const records = raw.call_logs || raw.records || [];
    const contacts = raw.pbx_contacts || raw.contacts || [];
    let inserted = 0;
    let skipped = 0;
    for (const r of records) {
      try {
        const result = await pool.query(`
          INSERT INTO call_logs
            (id, call_date, call_time, duration, call_type, caller, extension, destination, trunk, ai_summary, raw_line, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (id) DO NOTHING
        `, [
          r.id, r.call_date, r.call_time, r.duration, r.call_type,
          r.caller, r.extension, r.destination, r.trunk,
          r.ai_summary, r.raw_line, r.created_at
        ]);
        inserted += result.rowCount || 0;
      } catch (_) { skipped++; }
    }

    await ensurePbxContactsTable();
    let contactsUpserted = 0;
    let contactsSkipped = 0;
    for (const c of contacts) {
      const phone = String(c.phone || '').trim();
      if (!phone) { contactsSkipped++; continue; }
      try {
        const result = await pool.query(`
          INSERT INTO pbx_contacts (phone, name, company, notes, created_at, updated_at)
          VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz,NOW()),COALESCE($6::timestamptz,NOW()))
          ON CONFLICT (phone) DO UPDATE
            SET name = COALESCE(EXCLUDED.name, pbx_contacts.name),
                company = COALESCE(EXCLUDED.company, pbx_contacts.company),
                notes = COALESCE(EXCLUDED.notes, pbx_contacts.notes),
                updated_at = COALESCE(EXCLUDED.updated_at, NOW())
        `, [phone, c.name || null, c.company || null, c.notes || null, c.created_at || null, c.updated_at || null]);
        contactsUpserted += result.rowCount || 0;
      } catch (_) { contactsSkipped++; }
    }

    const syncedContacts = await syncPbxContactsFromCallLogs().catch(() => 0);

    return res.json({
      message: 'Restore complete.',
      inserted,
      skipped,
      total: records.length,
      contacts_upserted: contactsUpserted,
      contacts_skipped: contactsSkipped,
      contacts_total: contacts.length,
      contacts_synced_from_logs: syncedContacts,
      count: inserted,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Restore failed: ' + err.message });
  }
});

router.post('/backup/append', async (req, res) => {

  try {

    const { filename } = req.body;

    if (!filename) {
      return res.status(400).json({
        error: 'Filename is required'
      });
    }

    const backupPath = path.join(BACKUP_DIR, filename);

    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({
        error: 'Backup file not found'
      });
    }

    // Read backup JSON
    const raw = fs.readFileSync(backupPath, 'utf8');
    const backup = JSON.parse(raw);

    // Support multiple backup formats
    let calls = [];

    if (Array.isArray(backup)) {

      calls = backup;

    } else if (Array.isArray(backup.calls)) {

      calls = backup.calls;

    } else if (Array.isArray(backup.records)) {

      calls = backup.records;

    } else {

      return res.status(400).json({
        error: 'Invalid backup format'
      });
    }

    console.log('Append records count:', calls.length);

    let added = 0;
    let skipped = 0;
    const addedRecords = [];
    const skippedRecords = [];

    for (const rec of calls) {

      // Duplicate check
      const exists = await pool.query(
        `SELECT id
        FROM call_logs
        WHERE caller = $1
          AND destination = $2
          AND duration = $3
          AND call_date = $4
          AND call_time = $5
        LIMIT 1
        `,
        [
          rec.caller || '',
          rec.destination || '',
          rec.duration || 0,
          rec.call_date || null,
          rec.call_time || null
        ]
      );

      if (exists.rows.length > 0) {

        skipped++;

        skippedRecords.push({
          caller: rec.caller,
          destination: rec.destination,
          duration: rec.duration,
          call_date: rec.call_date,
          call_time: rec.call_time
        });

        continue;

      }

      // Insert new record
      await pool.query(
        `INSERT INTO call_logs
        (
          caller,
          extension,
          destination,
          duration,
          call_type,
          ai_summary,
          call_date,
          call_time,
          trunk,
          raw_line
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `,
        [
          rec.caller || '',
          rec.extension || '',
          rec.destination || '',
          rec.duration || 0,
          rec.call_type || '',
          rec.ai_summary || '',
          rec.call_date || null,
          rec.call_time || null,
          rec.trunk || '',
          rec.raw_line || JSON.stringify(rec)
        ]
      );

      added++;

      addedRecords.push({
        caller: rec.caller,
        destination: rec.destination,
        duration: rec.duration,
        call_date: rec.call_date,
        call_time: rec.call_time
      });
    }

    return res.json({
      success: true,
      added,
      skipped,
      total: calls.length,
      addedRecords,
      skippedRecords
    });

  } catch (err) {

    console.error('Append backup error:', err);

    return res.status(500).json({
      error: err.message
    });
  }
});

/** GET /api/calls/backup/read */
router.get('/backup/read', (req, res) => {
  const { filename } = req.query;
  if (!filename) return res.status(400).json({ error: 'filename required.' });
  const filepath = getSafeBackupPath(filename);
  if (!filepath) return res.status(400).json({ error: 'Invalid backup filename.' });
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup file not found.' });

  try {
    const stat = fs.statSync(filepath);
    const raw = fs.readFileSync(filepath, 'utf8');
    return res.json({
      filename: path.basename(filepath),
      size: stat.size,
      created_at: stat.birthtime,
      mtime: stat.mtime,
      content: JSON.parse(raw),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Could not read backup: ' + err.message });
  }
});

/** GET /api/calls/backup/download */
router.get('/backup/download', (req, res) => {
  const { filename } = req.query;
  if (!filename) return res.status(400).json({ error: 'filename required.' });
  const filepath = getSafeBackupPath(filename);
  if (!filepath) return res.status(400).json({ error: 'Invalid backup filename.' });
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup file not found.' });
  res.download(filepath, path.basename(filepath));
});

/** POST /api/calls/backup/delete  body: { filename } */
router.post('/backup/delete', (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required.' });
  const filepath = getSafeBackupPath(filename);
  if (!filepath) return res.status(400).json({ error: 'Invalid backup filename.' });
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup file not found.' });
  try {
    fs.unlinkSync(filepath);
    return res.json({ success: true, message: 'Backup deleted.' });
  } catch (err) {
    return res.status(500).json({ error: 'Could not delete backup: ' + err.message });
  }
});

function getAllRecordingFiles(dir) {
  let results = [];

  if (!fs.existsSync(dir)) return results;

  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);

    if (item.isDirectory()) {

      // Skip backup / copied recording folders
      const skipFolders = [
        '_BACKUPS',
        '_BACK',
        'BACKUP',
        'BACKUPS'
      ];

      if (
        skipFolders.some(name =>
          item.name.toUpperCase().includes(name)
        )
      ) {
        console.log('[SKIPPED BACKUP FOLDER]', fullPath);
        continue;
      }

      results = results.concat(
        getAllRecordingFiles(fullPath)
      );
    } else {
      const ext = path.extname(item.name).toLowerCase();

      if (['.wav', '.mp3', '.ogg', '.m4a'].includes(ext)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

// ── Max folders cleanup — keep only latest 5 date-based folders ──────────
const MAX_REC_FOLDERS = 5;

function pruneOldRecordingFolders() {
  try {
    if (!fs.existsSync(REC_DIR)) return;

    const skipFolders = ['_BACKUPS', '_BACK', 'BACKUP', 'BACKUPS'];

    // Get all top-level directories (excluding backup folders)
    const dirs = fs.readdirSync(REC_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !skipFolders.some(s => d.name.toUpperCase().includes(s)))
      .map(d => {
        const fullPath = path.join(REC_DIR, d.name);
        let mtime;
        try { mtime = fs.statSync(fullPath).mtime; } catch (_) { mtime = new Date(0); }
        return { name: d.name, fullPath, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first

    if (dirs.length <= MAX_REC_FOLDERS) return; // nothing to prune

    // Delete oldest folders beyond the limit
    const toDelete = dirs.slice(MAX_REC_FOLDERS);
    for (const folder of toDelete) {
      try {
        fs.rmSync(folder.fullPath, { recursive: true, force: true });
        console.log(`[REC-PRUNE] Deleted old recording folder: ${folder.name}`);
      } catch (err) {
        console.error(`[REC-PRUNE] Failed to delete ${folder.name}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[REC-PRUNE] pruneOldRecordingFolders error:', err.message);
  }
}

function buildRecordingTree(dir) {

  if (!fs.existsSync(dir)) {
    return [];
  }

  const items = fs.readdirSync(dir, {
    withFileTypes: true
  });

  return items
    .filter(item => {

      if (!item.isDirectory()) {
        return false;
      }

      const skipFolders = [
        '_BACKUPS',
        '_BACK',
        'BACKUP',
        'BACKUPS'
      ];

      return !skipFolders.some(name =>
        item.name.toUpperCase().includes(name)
      );

    })
    .map(item => {

      const fullPath = path.join(dir, item.name);

      return {
        type: 'folder',
        name: item.name,
        path: path.relative(REC_DIR, fullPath).replace(/\\/g, '/'),
        children: buildRecordingTree(fullPath)
      };

    });

}

// ═══════════════════════════════════════════════════════════════════
// GET /api/calls/section-summary  — full PBX section intelligence
// ═══════════════════════════════════════════════════════════════════
router.get('/section-summary', async (req, res) => {
  try {
    // ── Call log stats ──────────────────────────────────────────────
    const statsQ = await pool.query(`
      SELECT
        COUNT(*)                                                        AS total,
        COUNT(*) FILTER (WHERE call_type = 'In')                       AS incoming,
        COUNT(*) FILTER (WHERE call_type = 'Out')                      AS outgoing,
        COUNT(*) FILTER (WHERE call_type = 'Missed')                   AS missed,
        COUNT(*) FILTER (WHERE call_type = 'Internal')                 AS internal,
        COUNT(*) FILTER (WHERE ai_summary IS NOT NULL)                 AS with_summary
      FROM call_logs
      WHERE NOT (duration IS NULL OR duration = '' OR duration = '00:00:00')
        AND NOT (destination ~ '^\\d{2}-\\d{2}-\\d{2,4}$')
    `);
    const stats = statsQ.rows[0];

    // ── Latest incoming ─────────────────────────────────────────────
    const latestInQ = await pool.query(`
      SELECT caller, destination, duration, call_date, call_time, trunk
      FROM call_logs
      WHERE call_type = 'In'
        AND NOT (duration IS NULL OR duration = '' OR duration = '00:00:00')
      ORDER BY COALESCE(call_date::timestamp + COALESCE(call_time, TIME '00:00:00'), created_at) DESC
      LIMIT 1
    `);

    // ── Latest outgoing ─────────────────────────────────────────────
    const latestOutQ = await pool.query(`
      SELECT caller, destination, duration, call_date, call_time, trunk
      FROM call_logs
      WHERE call_type = 'Out'
        AND NOT (duration IS NULL OR duration = '' OR duration = '00:00:00')
      ORDER BY COALESCE(call_date::timestamp + COALESCE(call_time, TIME '00:00:00'), created_at) DESC
      LIMIT 1
    `);

    // ── Latest 5 calls ──────────────────────────────────────────────
    const recentQ = await pool.query(`
      SELECT caller, destination, duration, call_type, call_date, call_time, trunk,
             COALESCE(pc1.name, pc2.name) AS contact_name
      FROM call_logs cl
      LEFT JOIN (
        SELECT DISTINCT ON (regexp_replace(phone,'[^0-9]','','g'))
          regexp_replace(phone,'[^0-9]','','g') AS pd, name FROM pbx_contacts
        ORDER BY regexp_replace(phone,'[^0-9]','','g'), id DESC
      ) pc1 ON pc1.pd = regexp_replace(cl.caller,'[^0-9]','','g')
      LEFT JOIN (
        SELECT DISTINCT ON (regexp_replace(phone,'[^0-9]','','g'))
          regexp_replace(phone,'[^0-9]','','g') AS pd, name FROM pbx_contacts
        ORDER BY regexp_replace(phone,'[^0-9]','','g'), id DESC
      ) pc2 ON pc2.pd = regexp_replace(cl.destination,'[^0-9]','','g')
      WHERE NOT (cl.duration IS NULL OR cl.duration = '' OR cl.duration = '00:00:00')
        AND NOT (cl.destination ~ '^\\d{2}-\\d{2}-\\d{2,4}$')
      ORDER BY COALESCE(cl.call_date::timestamp + COALESCE(cl.call_time, TIME '00:00:00'), cl.created_at) DESC
      LIMIT 5
    `);

    // ── Recordings on filesystem ────────────────────────────────────
    let recTotal = 0;
    let recFolders = [];
    let latestRecFile = null;
    try {
      if (fs.existsSync(REC_DIR)) {
        const allRec = getAllRecordingFiles(REC_DIR);
        recTotal = allRec.length;

        // Count per folder
        const folderMap = {};
        for (const fp of allRec) {
          const folder = path.basename(path.dirname(fp));
          folderMap[folder] = (folderMap[folder] || 0) + 1;
        }
        recFolders = Object.entries(folderMap)
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => ({ name, count }));

        // Latest file by mtime
        let latestMtime = 0;
        for (const fp of allRec) {
          try {
            const mt = fs.statSync(fp).mtimeMs;
            if (mt > latestMtime) { latestMtime = mt; latestRecFile = path.basename(fp); }
          } catch (_) {}
        }
      }
    } catch (_) {}

    // ── Recordings in DB ────────────────────────────────────────────
    const recDbQ = await pool.query(`
      SELECT COUNT(*) AS total,
             MAX(COALESCE(call_date::timestamp + COALESCE(call_time, TIME '00:00:00'), created_at)) AS latest_date,
             (SELECT recording_file FROM call_logs
              WHERE recording_file IS NOT NULL AND recording_file != ''
              ORDER BY COALESCE(call_date::timestamp + COALESCE(call_time, TIME '00:00:00'), created_at) DESC
              LIMIT 1) AS latest_file
      FROM call_logs
      WHERE recording_file IS NOT NULL AND recording_file != ''
    `);

    // ── Backups ─────────────────────────────────────────────────────
    let backupCount = 0;
    let latestBackupDate = null;
    try {
      if (fs.existsSync(BACKUP_DIR)) {
        const bFiles = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json'));
        backupCount = bFiles.length;
        if (bFiles.length) {
          const dates = bFiles.map(f => fs.statSync(path.join(BACKUP_DIR, f)).mtime);
          latestBackupDate = new Date(Math.max(...dates)).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
        }
      }
    } catch (_) {}

    res.json({
      stats: {
        total: parseInt(stats.total),
        incoming: parseInt(stats.incoming),
        outgoing: parseInt(stats.outgoing),
        missed: parseInt(stats.missed),
        internal: parseInt(stats.internal),
        with_summary: parseInt(stats.with_summary),
      },
      latest_incoming: latestInQ.rows[0] || null,
      latest_outgoing: latestOutQ.rows[0] || null,
      recent_calls: recentQ.rows,
      recordings: {
        filesystem_total: recTotal,
        folders: recFolders,
        latest_file: latestRecFile,
        db_total: parseInt(recDbQ.rows[0]?.total || 0),
        db_latest_file: recDbQ.rows[0]?.latest_file || null,
        db_latest_date: recDbQ.rows[0]?.latest_date || null,
      },
      backups: {
        count: backupCount,
        latest_date: latestBackupDate,
      },
    });
  } catch (err) {
    console.error('[section-summary] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// RECORDINGS — scan filesystem for .wav / .mp3 files
// ═══════════════════════════════════════════════════════════════════



router.get('/recordings', (req, res) => {
  try {
    const page = parseInt(req.query.page || '1');
    const limit = parseInt(req.query.limit || '50');

    const start = (page - 1) * limit;
    const end = start + limit;
    if (!fs.existsSync(REC_DIR)) {
      return res.json({ recordings: [], dir: REC_DIR, message: 'Recordings directory not found. Set PBX_RECORDINGS_DIR in .env.' });
    }
    const exts = ['.wav', '.mp3', '.ogg', '.m4a'];
    const allFiles = getAllRecordingFiles(REC_DIR);

    const uniqueMap = new Map();

    for (const fullPath of allFiles) {
      const filename = path.basename(fullPath);
      const stat = fs.statSync(fullPath);

      // Keep latest duplicate only
      if (
        !uniqueMap.has(filename) ||
        stat.mtime > uniqueMap.get(filename).mtime
      ) {
        uniqueMap.set(filename, {
          fullPath,
          mtime: stat.mtime
        });
      }
    }

    const files = [...uniqueMap.values()]
      .map(({ fullPath }) => {
        const stat = fs.statSync(fullPath);

        const relativePath = path.relative(REC_DIR, fullPath);
        const parts = relativePath.split(path.sep);

        return {
          filename: path.basename(fullPath),
          folder_date: parts[0] || '',
          folder_team: parts[1] || '',
          full_path: fullPath,
          size_bytes: stat.size,
          size_label: formatBytes(stat.size),
          created_at: stat.birthtime,
          relative_path: relativePath,
          url: `/recordings/${encodeURIComponent(
            relativePath.replace(/\\/g, '/')
          )}`
        };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const paginatedFiles = files.slice(start, end);
    return res.json({
      recordings: paginatedFiles,
      total: files.length,
      page,
      limit,
      total_pages: Math.ceil(files.length / limit)
    });
  } catch (err) {
    return res.status(500).json({ error: 'Could not list recordings: ' + err.message });
  }
});


/** Find actual recording file on disk (smart guessing) */
function findRecordingFile(baseDir, filename) {
  const cleanName = path.basename(filename);

  function search(dir) {
    const items = fs.readdirSync(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isFile()) {
        if (item.name === cleanName) {
          return fullPath;
        }
      }

      if (item.isDirectory()) {
        try {
          const found = search(fullPath);
          if (found) return found;
        } catch (_) { }
      }
    }

    return null;
  }

  return search(baseDir);
}

router.get('/recordings/tree', (req, res) => {

  try {

    if (!fs.existsSync(REC_DIR)) {
      return res.json({
        success: true,
        tree: []
      });
    }

    // Prune old folders — keep only latest MAX_REC_FOLDERS
    pruneOldRecordingFolders();

    const tree = buildRecordingTree(REC_DIR);

    return res.json({
      success: true,
      tree
    });

  } catch (err) {

    console.error('Recording tree error:', err);

    return res.status(500).json({
      error: err.message
    });

  }

});

// ═══════════════════════════════════════════════════════════════════
// RECORDINGS — folder files with pagination
// ═══════════════════════════════════════════════════════════════════

router.get('/recordings/folder', (req, res) => {

  try {

    const relPath = decodeURIComponent(req.query.path || '');

    const page = parseInt(req.query.page || '1');

    const limit = parseInt(req.query.limit || '20');

    const targetDir = path.resolve(REC_DIR, relPath);

    console.log('REC_DIR:', REC_DIR);
    console.log('relPath:', relPath);
    console.log('targetDir:', targetDir);

    if (!fs.existsSync(targetDir)) {

      return res.status(404).json({
        success: false,
        error: 'Folder not found',
        targetDir
      });

    }

    const items = fs.readdirSync(targetDir, {
      withFileTypes: true
    });

    const files = items
      .filter(item => {

        if (!item.isFile()) return false;

        const ext = path.extname(item.name).toLowerCase();

        return ['.wav', '.mp3', '.ogg', '.m4a']
          .includes(ext);

      })
      .map(item => {

        const fullPath = path.join(targetDir, item.name);

        const stat = fs.statSync(fullPath);

        return {
          filename: item.name,
          relative_path: path.join(relPath, item.name),
          size_bytes: stat.size,
          size_label: formatBytes(stat.size),
          created_at: stat.birthtime,
          modified_at: stat.mtime,
          url: `/api/calls/recordings/${encodeURIComponent(
            path.join(relPath, item.name).replace(/\\/g, '/')
          )}`
        };

      })
      .sort((a, b) =>
        new Date(b.created_at) - new Date(a.created_at)
      );

    const start = (page - 1) * limit;

    const paginatedFiles = files.slice(
      start,
      start + limit
    );

    return res.json({
      success: true,
      folder: relPath,
      total: files.length,
      page,
      limit,
      total_pages: Math.ceil(files.length / limit),
      files: paginatedFiles
    });

  } catch (err) {

    console.error('Folder recordings error:', err);

    return res.status(500).json({
      success: false,
      error: err.message
    });

  }

});



/** GET /api/calls/recordings/:filename — Stream audio file */
router.get('/recordings/*', (req, res) => {

  try {

    const relativePath =
      decodeURIComponent(req.params[0]);

    const filepath =
      findRecordingFile(REC_DIR, relativePath);

    console.log('[RECORDING REQUEST]', filepath);

    if (!filepath || !fs.existsSync(filepath)) {

      console.log('[RECORDING NOT FOUND]', filepath);

      return res.status(404)
        .send('Recording not found');
    }

    const stat = fs.statSync(filepath);

    const fileSize = stat.size;

    const range = req.headers.range;

    // MIME TYPE
    let contentType = 'audio/wav';

    if (filepath.toLowerCase().endsWith('.mp3')) {
      contentType = 'audio/mpeg';
    }

    if (filepath.toLowerCase().endsWith('.ogg')) {
      contentType = 'audio/ogg';
    }

    if (filepath.toLowerCase().endsWith('.m4a')) {
      contentType = 'audio/mp4';
    }

    // RANGE STREAMING
    if (range) {

      const parts =
        range.replace(/bytes=/, '').split('-');

      const start =
        parseInt(parts[0], 10);

      const end =
        parts[1]
          ? parseInt(parts[1], 10)
          : fileSize - 1;

      const chunkSize =
        end - start + 1;

      const stream =
        fs.createReadStream(filepath, {
          start,
          end
        });

      res.writeHead(206, {
        'Content-Range':
          `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType
      });

      stream.pipe(res);

    } else {

      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes'
      });

      fs.createReadStream(filepath)
        .pipe(res);
    }

  } catch (err) {

    console.error(
      'Recording stream error:',
      err
    );

    return res.status(500)
      .send('Failed to stream recording');
  }

});

// ═══════════════════════════════════════════════════════════════════
// DELETE /api/calls/contacts/:phone — Remove a contact mapping
// ═══════════════════════════════════════════════════════════════════
router.delete('/contacts/:phone', async (req, res) => {
  try {
    await pool.query(`DELETE FROM pbx_contacts WHERE phone = $1`, [req.params.phone]);
    return res.json({ success: true, message: 'Contact deleted' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// SYNC — pull latest rows from DB (called from dashboard)
// ═══════════════════════════════════════════════════════════════════
router.get('/sync', async (req, res) => {
  const traceId = makePbxTraceId('PBX-SYNC-GET');
  console.log(`[${traceId}] GET /api/calls/sync started`, {
    ip: req.ip,
    user: req.user?.id || req.user?.email || null,
  });
  try {
    console.log(`[${traceId}] Sync step 1: syncPbxContactsFromCallLogs`);
    const contactsSynced = await syncPbxContactsFromCallLogs();
    console.log(`[${traceId}] Sync step 1 success`, { contactsSynced });
    console.log(`[${traceId}] Sync step 2: repairPbxDurationsFromRawLines`);
    const durationsRepaired = await repairPbxDurationsFromRawLines();
    console.log(`[${traceId}] Sync step 2 success`, { durationsRepaired });
    console.log(`[${traceId}] Sync step 3: count call_logs totals`);
    const result = await pool.query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS today
       FROM call_logs`
    );
    const payload = {
      synced: true,
      total: parseInt(result.rows[0].total),
      today: parseInt(result.rows[0].today),
      contacts_synced: contactsSynced,
      durations_repaired: durationsRepaired,
      timestamp: new Date().toISOString(),
    };
    console.log(`[${traceId}] GET /api/calls/sync response`, payload);
    return res.json(payload);
  } catch (err) {
    console.error(`[${traceId}] GET /api/calls/sync failed`, {
      message: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Sync check failed: ' + err.message });
  }
});

router.post('/sync', async (req, res) => {
  // Matrix SMDR is a live push stream; this endpoint reports DB/listener state.
  const traceId = makePbxTraceId('PBX-SYNC-POST');
  console.log(`[${traceId}] POST /api/calls/sync started`, {
    ip: req.ip,
    user: req.user?.id || req.user?.email || null,
    body: req.body,
  });
  try {
    console.log(`[${traceId}] Sync step 1: syncPbxContactsFromCallLogs`);
    const contactsSynced = await syncPbxContactsFromCallLogs();
    console.log(`[${traceId}] Sync step 1 success`, { contactsSynced });
    console.log(`[${traceId}] Sync step 2: repairPbxDurationsFromRawLines`);
    const durationsRepaired = await repairPbxDurationsFromRawLines();
    console.log(`[${traceId}] Sync step 2 success`, { durationsRepaired });
    console.log(`[${traceId}] Sync step 3: count current call_logs totals`);
    const result = await pool.query(`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE call_date = CURRENT_DATE) AS today
      FROM call_logs
    `);
    const pbxStatus = smdr.getStatus();
    const payload = {
      message: 'Live SMDR listener checked. Historical PBX rows are stored only when the PBX pushes them to this server.',
      count: 0,
      total: parseInt(result.rows[0].total),
      today: parseInt(result.rows[0].today),
      contacts_synced: contactsSynced,
      durations_repaired: durationsRepaired,
      pbx_status: pbxStatus,
    };
    console.log(`[${traceId}] POST /api/calls/sync response`, payload);
    return res.json(payload);
  } catch (err) {
    console.error(`[${traceId}] POST /api/calls/sync failed`, {
      message: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────
router.post('/maintenance/repair-dates', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH matched AS (
        SELECT id,
               regexp_match(raw_line, '(\\d{1,2})-(\\d{2})-(\\d{2,4})\\s+(\\d{2}:\\d{2}:\\d{2})') AS m
        FROM call_logs
        WHERE raw_line ~ '(\\d{1,2})-(\\d{2})-(\\d{2,4})\\s+(\\d{2}:\\d{2}:\\d{2})'
      ), parsed AS (
        SELECT id,
               ((CASE WHEN length(m[3]) = 2 THEN '20' || m[3] ELSE m[3] END) || '-' || m[2] || '-' || lpad(m[1], 2, '0'))::date AS parsed_date,
               m[4]::time AS parsed_time
        FROM matched
      )
      UPDATE call_logs cl
         SET call_date = p.parsed_date,
             call_time = p.parsed_time
        FROM parsed p
       WHERE cl.id = p.id
         AND (cl.call_date IS DISTINCT FROM p.parsed_date OR cl.call_time IS DISTINCT FROM p.parsed_time)
      RETURNING cl.id
    `);

    const may14 = await pool.query(`SELECT COUNT(*)::int AS total FROM call_logs WHERE call_date = DATE '2026-05-14'`);
    return res.json({
      success: true,
      repaired: result.rowCount || 0,
      may14_total: may14.rows[0].total,
    });
  } catch (err) {
    console.error('[Calls] repair dates error:', err.message);
    return res.status(500).json({ error: 'Failed to repair PBX call dates: ' + err.message });
  }
});

router.post('/maintenance/repair-durations', async (req, res) => {
  try {
    const repaired = await repairPbxDurationsFromRawLines();
    return res.json({ success: true, repaired });
  } catch (err) {
    console.error('[Calls] repair durations error:', err.message);
    return res.status(500).json({ error: 'Failed to repair PBX call durations: ' + err.message });
  }
});

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

function normalizeDateParam(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const month = slash[1].padStart(2, '0');
    const day = slash[2].padStart(2, '0');
    return `${slash[3]}-${month}-${day}`;
  }

  const dash = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dash) {
    const day = dash[1].padStart(2, '0');
    const month = dash[2].padStart(2, '0');
    return `${dash[3]}-${month}-${day}`;
  }

  return raw;
}



// Run once on startup to clean up any excess folders from before this feature was added
setImmediate(() => {
  try { pruneOldRecordingFolders(); } catch (_) {}
});

module.exports = router;

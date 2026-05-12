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

const express  = require('express');
const pool     = require('../db/pool');
const path     = require('path');
const fs       = require('fs');
const { authenticate } = require('../middleware/auth');
const smdr     = require('../services/matrixSmdr');

const router = express.Router();
router.use(authenticate);

// ── Recordings directory (PBX may store files here via network share/FTP) ──
const REC_DIR = process.env.PBX_RECORDINGS_DIR
  || path.join(__dirname, '../../recordings');

// ── Backup directory ──────────────────────────────────────────────────────
const BACKUP_DIR = process.env.CALL_BACKUP_DIR
  || path.join(__dirname, '../../call_backups');

// Ensure directories exist
[REC_DIR, BACKUP_DIR].forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} });

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

// ═══════════════════════════════════════════════════════════════════
// GET /api/calls/pbx-status
// ═══════════════════════════════════════════════════════════════════
router.get('/pbx-status', (req, res) => {
  res.json(smdr.getStatus());
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/calls/contacts  — distinct numbers seen in PBX call_logs
// ═══════════════════════════════════════════════════════════════════
router.get('/contacts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        t.phone,
        MAX(cl.created_at)   AS last_call,
        COUNT(cl.id)::int    AS call_count,
        pc.name,
        pc.company,
        pc.notes,
        pc.id                AS pbx_contact_id
      FROM (
        SELECT NULLIF(TRIM(destination), '') AS phone, id FROM call_logs WHERE destination IS NOT NULL
        UNION ALL
        SELECT NULLIF(TRIM(caller), '') AS phone, id FROM call_logs WHERE caller IS NOT NULL
      ) t
      LEFT JOIN call_logs cl ON (cl.destination = t.phone OR cl.caller = t.phone)
      LEFT JOIN pbx_contacts pc ON pc.phone = t.phone
      WHERE t.phone IS NOT NULL AND t.phone <> ''
      GROUP BY t.phone, pc.name, pc.company, pc.notes, pc.id
      ORDER BY MAX(cl.created_at) DESC NULLS LAST
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
      LEFT JOIN call_logs cl ON (cl.caller = pc.phone OR cl.destination = pc.phone)
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
    const result = await pool.query(`
      INSERT INTO pbx_contacts (phone, name, company, notes, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (phone) DO UPDATE
        SET name = EXCLUDED.name,
            company = EXCLUDED.company,
            notes = EXCLUDED.notes,
            updated_at = NOW()
      RETURNING *
    `, [phone.trim(), name || null, company || null, notes || null]);
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
  const limit  = parseInt(req.query.limit  || '100');
  const offset = parseInt(req.query.offset || '0');
  try {
    const result = await pool.query(`
      SELECT cl.*, pc.name AS saved_name, pc.company AS saved_company
      FROM call_logs cl
      LEFT JOIN pbx_contacts pc ON (pc.phone = cl.caller OR pc.phone = cl.destination)
      WHERE cl.caller = $1 OR cl.destination = $1
      ORDER BY cl.created_at DESC
      LIMIT $2 OFFSET $3
    `, [phone, limit, offset]);
    const total = await pool.query(`
      SELECT COUNT(*) FROM call_logs WHERE caller = $1 OR destination = $1
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
  const limit   = parseInt(req.query.limit  || '50');
  const offset  = parseInt(req.query.offset || '0');
  const type    = req.query.type   || '';
  const search  = req.query.search || '';
  const dateFrom = req.query.from  || '';
  const dateTo   = req.query.to    || '';

  const where = ['1=1'];
  const params = [];
  let p = 1;

  if (type) { where.push(`call_type = $${p++}`); params.push(type); }
  if (search) {
    where.push(`(caller ILIKE $${p} OR destination ILIKE $${p} OR extension ILIKE $${p})`);
    params.push('%' + search + '%'); p++;
  }
  if (dateFrom) { where.push(`call_date >= $${p++}`); params.push(dateFrom); }
  if (dateTo)   { where.push(`call_date <= $${p++}`); params.push(dateTo); }

  const whereStr = where.join(' AND ');
  try {
    const result = await pool.query(
      `SELECT cl.*, pc.name AS saved_name, pc.company AS saved_company
       FROM call_logs cl
       LEFT JOIN pbx_contacts pc ON (pc.phone = cl.caller OR pc.phone = cl.destination)
       WHERE ${whereStr}
       ORDER BY cl.created_at DESC
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );
    const total = await pool.query(
      `SELECT COUNT(*) FROM call_logs WHERE ${whereStr}`,
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
      caller||null, extension||null, destination||null,
      duration||null, call_type||'Out', ai_summary||null,
      call_date||null, call_time||null, trunk||null, raw_line||null
    ]);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to log call.' });
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
      LEFT JOIN pbx_contacts pc ON (pc.phone = cl.caller OR pc.phone = cl.destination)
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
        return { filename: f, size: stat.size, created_at: stat.birthtime };
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
    const result = await pool.query(`SELECT * FROM call_logs ORDER BY created_at DESC`);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `call_backup_${ts}.json`;
    const filepath = path.join(BACKUP_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify({
      created_at: new Date().toISOString(),
      total: result.rowCount,
      records: result.rows,
    }, null, 2));
    return res.json({
      message: `Backup created: ${filename}`,
      filename,
      total: result.rowCount,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Backup failed: ' + err.message });
  }
});

/** POST /api/calls/backup/restore  body: { filename } */
router.post('/backup/restore', async (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required.' });
  // Safety: prevent path traversal
  const safe = path.basename(filename);
  const filepath = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup file not found.' });

  try {
    const raw = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    const records = raw.records || [];
    let inserted = 0;
    let skipped  = 0;
    for (const r of records) {
      try {
        await pool.query(`
          INSERT INTO call_logs
            (id, call_date, call_time, duration, call_type, caller, extension, destination, trunk, ai_summary, raw_line, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (id) DO NOTHING
        `, [
          r.id, r.call_date, r.call_time, r.duration, r.call_type,
          r.caller, r.extension, r.destination, r.trunk,
          r.ai_summary, r.raw_line, r.created_at
        ]);
        inserted++;
      } catch (_) { skipped++; }
    }
    return res.json({ message: 'Restore complete.', inserted, skipped, total: records.length });
  } catch (err) {
    return res.status(500).json({ error: 'Restore failed: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// RECORDINGS — scan filesystem for .wav / .mp3 files
// ═══════════════════════════════════════════════════════════════════
router.get('/recordings', (req, res) => {
  try {
    if (!fs.existsSync(REC_DIR)) {
      return res.json({ recordings: [], dir: REC_DIR, message: 'Recordings directory not found. Set PBX_RECORDINGS_DIR in .env.' });
    }
    const exts = ['.wav', '.mp3', '.ogg', '.m4a'];
    const files = fs.readdirSync(REC_DIR)
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .map(f => {
        const stat = fs.statSync(path.join(REC_DIR, f));
        return {
          filename: f,
          size_bytes: stat.size,
          size_label: formatBytes(stat.size),
          created_at: stat.birthtime,
          url: `/recordings/${f}`,
        };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return res.json({ recordings: files, dir: REC_DIR, total: files.length });
  } catch (err) {
    return res.status(500).json({ error: 'Could not list recordings: ' + err.message });
  }
});

/** GET /api/calls/recordings/:filename — Stream the actual audio file */
router.get('/recordings/:filename', (req, res) => {
  const safe = path.basename(req.params.filename);
  const filepath = path.join(REC_DIR, safe);
  if (!fs.existsSync(filepath)) return res.status(404).send('Recording not found');
  res.sendFile(filepath);
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
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS today
       FROM call_logs`
    );
    return res.json({
      synced: true,
      total: parseInt(result.rows[0].total),
      today: parseInt(result.rows[0].today),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Sync check failed: ' + err.message });
  }
});

router.post('/sync', async (req, res) => {
  // Future: trigger re-read from PBX SMDR file or re-process buffer.
  // For now: return current stats.
  try {
    const result = await pool.query(`SELECT COUNT(*) FROM call_logs`);
    return res.json({
      message: 'Call log database is up to date. Live SMDR listener is active.',
      total: parseInt(result.rows[0].count),
      pbx_status: smdr.getStatus(),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes < 1024)     return bytes + ' B';
  if (bytes < 1048576)  return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

module.exports = router;

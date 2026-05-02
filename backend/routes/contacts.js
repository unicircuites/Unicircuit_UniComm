const express = require('express');
const pool    = require('../db/pool');
const mailStore  = require('../services/outlookMailStore');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

async function countBroadcastsForEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return 0;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n
       FROM email_broadcasts b
       WHERE b.status IN ('sent', 'sending')
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(b.recipients, '[]'::jsonb)) AS elem
         WHERE (
           (jsonb_typeof(elem) = 'string' AND lower(trim(both '"' from elem::text)) = $1)
           OR (jsonb_typeof(elem) = 'object' AND lower(trim(elem->>'email')) = $1)
         )
       )`,
      [e]
    );
    return r.rows[0].n;
  } catch (_) {
    return 0;
  }
}

// GET /api/contacts
router.get('/', async (req, res) => {
  const { q, segment } = req.query;
  let sql = `SELECT * FROM contacts WHERE 1=1`;
  const params = [];

  if (q) {
    params.push(`%${q}%`);
    const n = params.length;
    sql += ` AND (fname ILIKE $${n} OR lname ILIKE $${n} OR company ILIKE $${n} OR city ILIKE $${n} OR products ILIKE $${n} OR email ILIKE $${n})`;
  }
  if (segment) {
    params.push(segment);
    sql += ` AND segment = $${params.length}`;
  }
  sql += ` ORDER BY score DESC, created_at DESC`;

  try {
    const result = await pool.query(sql, params);
    return res.json(result.rows);
  } catch (err) {
    console.error('[Contacts] GET error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch contacts.' });
  }
});

// GET /api/contacts/:id/activity — Outlook mail stats and broadcast count
router.get('/:id/activity', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const row = await pool.query(
      `SELECT id, email, last_contact FROM contacts WHERE id = $1`, [id]
    );
    if (!row.rowCount) return res.status(404).json({ error: 'Contact not found.' });
    const email = row.rows[0].email;

    let lastEmailAt             = null;
    let outlookSentToThem       = 0;
    let outlookReceivedFromThem = 0;
    let outlookError            = null;
    let outlookHint             = null;

    if (email && String(email).trim()) {
      // Read from DB cache (populated by POST /api/outlook/sync-messages)
      const cached = await mailStore.getStatsForEmail(email);
      if (cached) {
        lastEmailAt             = cached.last_email_at ? new Date(cached.last_email_at).toISOString() : null;
        outlookSentToThem       = cached.sent_to_them    || 0;
        outlookReceivedFromThem = cached.received_from   || 0;
      } else {
        outlookHint = 'No data yet — click "Sync Mail Stats" in Email / Outlook to scan your mailbox.';
      }

      // Persist last_contact to DB if we got a date
      if (lastEmailAt) {
        const disp = new Date(lastEmailAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
        pool.query(`UPDATE contacts SET last_contact = $1 WHERE id = $2`, [disp, id]).catch(() => {});
      }
    }

    const broadcastCount = await countBroadcastsForEmail(email);

    return res.json({
      lastEmailAt,
      lastContactLabel: lastEmailAt
        ? new Date(lastEmailAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
        : null,
      outlookSentToThem,
      outlookReceivedFromThem,
      broadcastCount,
      outlookError,
      outlookHint,
    });
  } catch (err) {
    console.error('[Contacts] activity error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM contacts WHERE id = $1`, [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Contact not found.' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch contact.' });
  }
});

// POST /api/contacts
router.post('/', async (req, res) => {
  const { fname, lname, company, designation, dept, phone, wa, email,
          segment, score, products, city, notes } = req.body;

  if (!fname || !lname || !company) {
    return res.status(400).json({ error: 'First name, last name, and company are required.' });
  }

  const initials = `${fname[0]}${lname[0]}`.toUpperCase();
  const palettes = [
    ['#1d4ed8','rgba(29,78,216,0.15)'],  ['#d97706','rgba(217,119,6,0.15)'],
    ['#7c3aed','rgba(124,58,237,0.15)'], ['#059669','rgba(5,150,105,0.15)'],
    ['#dc2626','rgba(220,38,38,0.15)'],  ['#0891b2','rgba(8,145,178,0.15)'],
    ['#65a30d','rgba(101,163,13,0.15)'], ['#9333ea','rgba(147,51,234,0.15)'],
  ];
  const [avatar_color, avatar_bg] = palettes[Math.floor(Math.random() * palettes.length)];

  try {
    const result = await pool.query(`
      INSERT INTO contacts
        (fname,lname,company,designation,dept,phone,wa,email,segment,score,
         products,city,notes,avatar_color,avatar_bg,initials,last_contact)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'Today')
      RETURNING *
    `, [fname, lname, company, designation||null, dept||null, phone||null, wa||null,
        email||null, segment||'Prospect', score||50, products||null, city||null,
        notes||null, avatar_color, avatar_bg, initials]);

    try {
      await pool.query(
        `INSERT INTO audit_log (user_id,action,entity,entity_id,detail) VALUES ($1,$2,$3,$4,$5)`,
        [req.user.id, 'CREATE', 'contacts', result.rows[0].id, `Created ${fname} ${lname}`]
      );
    } catch (_) {}

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[Contacts] POST error:', err.message);
    return res.status(500).json({ error: 'Failed to create contact.' });
  }
});

// PUT /api/contacts/:id
router.put('/:id', async (req, res) => {
  const { fname, lname, company, designation, dept, phone, wa, email,
          segment, score, products, city, notes } = req.body;
  try {
    const result = await pool.query(`
      UPDATE contacts SET
        fname=$1, lname=$2, company=$3, designation=$4, dept=$5,
        phone=$6, wa=$7, email=$8, segment=$9, score=$10,
        products=$11, city=$12, notes=$13
      WHERE id=$14 RETURNING *
    `, [fname, lname, company, designation, dept, phone, wa, email,
        segment, score, products, city, notes, req.params.id]);

    if (result.rowCount === 0) return res.status(404).json({ error: 'Contact not found.' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update contact.' });
  }
});

// DELETE /api/contacts/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM contacts WHERE id=$1 RETURNING id,fname,lname`, [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Contact not found.' });
    return res.json({ message: 'Contact deleted.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete contact.' });
  }
});

module.exports = router;

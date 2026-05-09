const express = require('express');
const fetch = require('node-fetch');
const pool    = require('../db/pool');
const mailStore  = require('../services/outlookMailStore');
const graph = require('../services/msGraph');
const { authenticate } = require('../middleware/auth');
const activityLog = require('../services/activityLog');

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

function contactDisplayName(row) {
  return [row.fname, row.lname].map(v => String(v || '').trim()).filter(Boolean).join(' ').trim()
    || String(row.email || '').trim()
    || 'CRM contact';
}

function outlookBodyFromCrmContact(row) {
  const email = String(row.email || '').trim();
  const phone = String(row.phone || row.wa || '').trim();
  const body = {
    displayName: contactDisplayName(row),
    givenName: String(row.fname || '').trim() || undefined,
    surname: String(row.lname || '').trim() || undefined,
    companyName: String(row.company || '').trim() || undefined,
    jobTitle: String(row.designation || '').trim() || undefined,
    mobilePhone: phone || undefined,
    businessPhones: phone ? [phone] : undefined,
  };
  if (email) body.emailAddresses = [{ address: email, name: body.displayName }];
  Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
  return body;
}

async function findOutlookContactByEmail(email) {
  const wanted = String(email || '').trim().toLowerCase();
  if (!wanted) return null;
  const token = await graph.getAccessToken(process.env.MS_USER_EMAIL);

  async function readContacts(path) {
    const data = await graph.graphGet(path, process.env.MS_USER_EMAIL);
    let rows = data.value || [];
    let next = data['@odata.nextLink'] || '';
    while (next && rows.length < 5000 && token) {
      const res = await fetch(next, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) break;
      const page = await res.json();
      rows = rows.concat(page.value || []);
      next = page['@odata.nextLink'] || '';
    }
    return rows;
  }

  const select = '$top=500&$select=id,emailAddresses';
  let rows = await readContacts(`/me/contacts?${select}`);
  let found = rows.find(c => (c.emailAddresses || []).some(e => String(e && e.address || '').trim().toLowerCase() === wanted));
  if (found) return found;

  try {
    const folders = await graph.graphGet('/me/contactFolders?$top=100&$select=id,displayName', process.env.MS_USER_EMAIL);
    for (const folder of (folders.value || [])) {
      rows = await readContacts(`/me/contactFolders/${encodeURIComponent(folder.id)}/contacts?${select}`);
      found = rows.find(c => (c.emailAddresses || []).some(e => String(e && e.address || '').trim().toLowerCase() === wanted));
      if (found) return found;
    }
  } catch (err) {
    console.warn('[Contacts] Outlook folder lookup skipped:', err.message);
  }

  return null;
}

async function upsertOutlookContactFromCrm(row) {
  const email = String(row.email || '').trim();
  if (!email) return { skipped: true, reason: 'NO_EMAIL' };
  const phone = String(row.phone || row.wa || '').trim();
  if (!phone) return { skipped: true, reason: 'NO_MOBILE_PHONE' };

  const body = outlookBodyFromCrmContact(row);
  try {
    const existing = await findOutlookContactByEmail(email);
    if (existing && existing.id) {
      await graph.graphPatch(`/me/contacts/${encodeURIComponent(existing.id)}`, body, process.env.MS_USER_EMAIL);
      return { action: 'updated', id: existing.id };
    }
    const created = await graph.graphPost('/me/contacts', body, process.env.MS_USER_EMAIL);
    return { action: 'created', id: created.id };
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') return { skipped: true, reason: 'OUTLOOK_NOT_CONNECTED' };
    console.warn('[Contacts] Outlook sync skipped:', err.message);
    return { skipped: true, reason: err.message };
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
  if (!String(phone || wa || '').trim()) {
    return res.status(400).json({ error: 'Mobile number is required for contact tracking.' });
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

    try {
      activityLog.append({ type: 'info', service: 'system', message: `CRM contact created: ${fname} ${lname} (${email || 'no email'})`, timestamp: new Date().toISOString() });
    } catch(_) {}

    const outlookSync = await upsertOutlookContactFromCrm(result.rows[0]);
    if (!outlookSync.skipped) {
      try {
        activityLog.append({ type: 'info', service: 'outlook', message: `Outlook contact ${outlookSync.action}: ${contactDisplayName(result.rows[0])}`, timestamp: new Date().toISOString() });
      } catch(_) {}
    }

    return res.status(201).json({ ...result.rows[0], outlookSync });
  } catch (err) {
    console.error('[Contacts] POST error:', err.message);
    return res.status(500).json({ error: 'Failed to create contact.' });
  }
});

// PUT /api/contacts/:id
router.put('/:id', async (req, res) => {
  const { fname, lname, company, designation, dept, phone, wa, email,
          segment, score, products, city, notes } = req.body;
  if (!String(phone || wa || '').trim()) {
    return res.status(400).json({ error: 'Mobile number is required for contact tracking.' });
  }
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
    const outlookSync = await upsertOutlookContactFromCrm(result.rows[0]);
    if (!outlookSync.skipped) {
      try {
        activityLog.append({ type: 'info', service: 'outlook', message: `Outlook contact ${outlookSync.action}: ${contactDisplayName(result.rows[0])}`, timestamp: new Date().toISOString() });
      } catch(_) {}
    }
    return res.json({ ...result.rows[0], outlookSync });
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

const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const activityLog = require('../services/activityLog');

const router = express.Router();
router.use(authenticate);

let tableReady = false;

async function ensureMailTasksTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mail_reply_tasks (
      id                    SERIAL PRIMARY KEY,
      message_id            TEXT NOT NULL,
      conversation_id       TEXT,
      subject               TEXT,
      sender_name           TEXT,
      sender_email          TEXT,
      preview               TEXT,
      importance            VARCHAR(20)  DEFAULT 'normal',
      priority              VARCHAR(20)  DEFAULT 'normal',
      status                VARCHAR(30)  DEFAULT 'open',
      assigned_to           INT REFERENCES users(id) ON DELETE SET NULL,
      assigned_by           INT REFERENCES users(id) ON DELETE SET NULL,
      assigned_to_name      TEXT,
      assigned_to_email     VARCHAR(200),
      assigned_to_phone     VARCHAR(30),
      notify_channel        VARCHAR(10)  DEFAULT 'wa',
      notify_before_minutes INTEGER      DEFAULT 60,
      triage_tag            VARCHAR(10)  DEFAULT 'none',
      replied_at            TIMESTAMPTZ,
      notified_at           TIMESTAMPTZ,
      due_at                TIMESTAMPTZ,
      notes                 TEXT,
      created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      completed_at          TIMESTAMPTZ
    );
  `);
  // Add new columns to existing tables (idempotent — IF NOT EXISTS)
  const newCols = [
    `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS assigned_to_name      TEXT`,
    `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS assigned_to_email     VARCHAR(200)`,
    `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS assigned_to_phone     VARCHAR(30)`,
    `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS notify_channel        VARCHAR(10)  DEFAULT 'wa'`,
    `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS notify_before_minutes INTEGER      DEFAULT 60`,
    `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS triage_tag            VARCHAR(10)  DEFAULT 'none'`,
    `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS replied_at            TIMESTAMPTZ`,
    `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS notified_at           TIMESTAMPTZ`,
  ];
  for (const sql of newCols) {
    await pool.query(sql).catch(() => {}); // ignore if already exists
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mail_reply_tasks_status      ON mail_reply_tasks(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mail_reply_tasks_assigned_to ON mail_reply_tasks(assigned_to)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mail_reply_tasks_message_id  ON mail_reply_tasks(message_id)`);
  tableReady = true;
}

// ── Normalizers ──────────────────────────────────────────────────────────────

function normalizePriority(value) {
  const v = String(value || '').trim().toLowerCase();
  return ['low', 'normal', 'high', 'urgent'].includes(v) ? v : 'normal';
}

function normalizeStatus(value) {
  const v = String(value || '').trim().toLowerCase();
  return ['open', 'in_progress', 'waiting', 'done', 'cancelled'].includes(v) ? v : 'open';
}

function normalizeNotifyChannel(value) {
  const v = String(value || '').trim().toLowerCase();
  return ['wa', 'email', 'both'].includes(v) ? v : 'wa';
}

function normalizeTriageTag(value) {
  const v = String(value || '').trim().toLowerCase();
  return ['red', 'yellow', 'green', 'none'].includes(v) ? v : 'none';
}

/**
 * Derive the correct triage_tag from task state.
 * Rules (in priority order):
 *   1. done/cancelled → green
 *   2. replied_at non-null → yellow
 *   3. open/in_progress + overdue + no reply → red
 *   4. otherwise → preserve manualTag (default 'none')
 */
function deriveTriageTag(status, dueAt, repliedAt, manualTag) {
  const s = String(status || '').toLowerCase();
  if (s === 'done' || s === 'cancelled') return 'green';
  if (repliedAt) return 'yellow';
  if ((s === 'open' || s === 'in_progress') && dueAt && new Date(dueAt) < new Date() && !repliedAt) return 'red';
  return normalizeTriageTag(manualTag);
}

// ── SELECT helper ────────────────────────────────────────────────────────────

function taskSelectSql() {
  return `
    SELECT t.*,
           COALESCE(t.assigned_to_name,  assignee.name)  AS assigned_to_name,
           COALESCE(t.assigned_to_email, assignee.email) AS assigned_to_email,
           creator.name AS assigned_by_name
    FROM mail_reply_tasks t
    LEFT JOIN users assignee ON assignee.id = t.assigned_to
    LEFT JOIN users creator  ON creator.id  = t.assigned_by
  `;
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/mail-tasks/users
router.get('/users', async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, email, role, avatar_initials
       FROM users
       WHERE is_active = TRUE
       ORDER BY name ASC`
    );
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/mail-tasks/
router.get('/', async (req, res) => {
  await ensureMailTasksTable();
  const status  = String(req.query.status || '').trim();
  const mine    = req.query.mine === '1';
  const panel   = req.query.panel === '1';
  const params  = [];
  const where   = [];

  if (panel) {
    where.push(`t.status IN ('open','in_progress','waiting')`);
  } else if (status && status !== 'all') {
    params.push(status);
    where.push(`t.status = $${params.length}`);
  }
  if (mine) {
    params.push(req.user.id);
    where.push(`t.assigned_to = $${params.length}`);
  }

  const orderBy = panel
    ? `ORDER BY
        CASE COALESCE(t.triage_tag,'none')
          WHEN 'red'    THEN 0
          WHEN 'yellow' THEN 1
          WHEN 'green'  THEN 2
          ELSE 3
        END,
        COALESCE(t.due_at, t.created_at + INTERVAL '30 days') ASC,
        t.created_at DESC`
    : `ORDER BY
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        COALESCE(t.due_at, t.created_at + INTERVAL '30 days') ASC,
        t.created_at DESC`;

  const sql = `${taskSelectSql()} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ${orderBy} LIMIT 200`;
  try {
    const r = await pool.query(sql, params);
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/mail-tasks/by-message/:messageId
router.get('/by-message/:messageId', async (req, res) => {
  await ensureMailTasksTable();
  try {
    const r = await pool.query(
      `${taskSelectSql()} WHERE t.message_id = $1 ORDER BY t.created_at DESC LIMIT 10`,
      [req.params.messageId]
    );
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/mail-tasks/
router.post('/', async (req, res) => {
  await ensureMailTasksTable();
  const {
    message_id,
    conversation_id,
    subject,
    sender_name,
    sender_email,
    preview,
    importance,
    assigned_to,
    assigned_to_name,
    assigned_to_email,
    assigned_to_phone,
    notify_channel,
    notify_before_minutes,
    triage_tag,
    replied_at,
    due_at,
    notes,
  } = req.body || {};

  if (!message_id) return res.status(400).json({ error: 'message_id is required' });
  if (!assigned_to && !assigned_to_name) return res.status(400).json({ error: 'assigned_to or assigned_to_name is required' });

  const priority      = normalizePriority(req.body.priority || (importance === 'high' ? 'high' : 'normal'));
  const status        = normalizeStatus(req.body.status || 'open');
  const channel       = normalizeNotifyChannel(notify_channel);
  const notifyMins    = parseInt(notify_before_minutes, 10) || 60;
  const repliedAtVal  = replied_at === 'now' ? new Date() : (replied_at || null);
  const triageTag     = deriveTriageTag(status, due_at, repliedAtVal, triage_tag);

  try {
    const inserted = await pool.query(
      `INSERT INTO mail_reply_tasks
        (message_id, conversation_id, subject, sender_name, sender_email, preview,
         importance, priority, status,
         assigned_to, assigned_by, assigned_to_name, assigned_to_email, assigned_to_phone,
         notify_channel, notify_before_minutes, triage_tag, replied_at,
         due_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [
        message_id,
        conversation_id || null,
        subject || '(no subject)',
        sender_name || null,
        sender_email || null,
        preview || null,
        importance || 'normal',
        priority,
        status,
        assigned_to || null,
        req.user.id,
        assigned_to_name || null,
        assigned_to_email || null,
        assigned_to_phone || null,
        channel,
        notifyMins,
        triageTag,
        repliedAtVal,
        due_at || null,
        notes || null,
      ]
    );

    const full = await pool.query(`${taskSelectSql()} WHERE t.id = $1`, [inserted.rows[0].id]);
    const task = full.rows[0];
    try {
      activityLog.append({
        type: 'info',
        service: 'outlook',
        message: `Mail reply task assigned: ${task.subject || '(no subject)'} → ${task.assigned_to_name || 'user #' + (assigned_to || assigned_to_name)}`,
        timestamp: new Date().toISOString(),
      });
    } catch (_) {}
    return res.status(201).json(task);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/mail-tasks/:id/triage  — quick triage update
router.patch('/:id/triage', async (req, res) => {
  await ensureMailTasksTable();
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });

  const tag = String(req.body.triage_tag || '').trim().toLowerCase();
  if (!['red', 'yellow', 'green', 'none'].includes(tag)) {
    return res.status(400).json({ error: `Invalid triage_tag '${tag}'. Allowed: red, yellow, green, none` });
  }

  try {
    const r = await pool.query(
      `UPDATE mail_reply_tasks SET triage_tag = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [tag, id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Task not found' });
    const full = await pool.query(`${taskSelectSql()} WHERE t.id = $1`, [id]);
    return res.json(full.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/mail-tasks/:id
router.patch('/:id', async (req, res) => {
  await ensureMailTasksTable();
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid task id' });

  // Fetch current task to derive triage correctly
  let current;
  try {
    const cr = await pool.query(`SELECT * FROM mail_reply_tasks WHERE id = $1`, [id]);
    if (!cr.rowCount) return res.status(404).json({ error: 'Task not found' });
    current = cr.rows[0];
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const newStatus    = req.body.status    !== undefined ? normalizeStatus(req.body.status)           : current.status;
  const newPriority  = req.body.priority  !== undefined ? normalizePriority(req.body.priority)       : current.priority;
  const newChannel   = req.body.notify_channel !== undefined ? normalizeNotifyChannel(req.body.notify_channel) : current.notify_channel;
  const newDueAt     = req.body.due_at    !== undefined ? (req.body.due_at || null)                  : current.due_at;
  const newNotes     = req.body.notes     !== undefined ? (req.body.notes || null)                   : current.notes;
  const newAssignedTo       = req.body.assigned_to       !== undefined ? (req.body.assigned_to || null)       : current.assigned_to;
  const newAssignedToName   = req.body.assigned_to_name  !== undefined ? (req.body.assigned_to_name || null)  : current.assigned_to_name;
  const newAssignedToEmail  = req.body.assigned_to_email !== undefined ? (req.body.assigned_to_email || null) : current.assigned_to_email;
  const newAssignedToPhone  = req.body.assigned_to_phone !== undefined ? (req.body.assigned_to_phone || null) : current.assigned_to_phone;
  const newNotifyMins       = req.body.notify_before_minutes !== undefined ? (parseInt(req.body.notify_before_minutes, 10) || 60) : current.notify_before_minutes;

  // replied_at: 'now' → current timestamp; explicit value → use it; undefined → keep current
  let newRepliedAt = current.replied_at;
  if (req.body.replied_at === 'now') newRepliedAt = new Date();
  else if (req.body.replied_at !== undefined) newRepliedAt = req.body.replied_at || null;

  // Manual triage override (only if explicitly provided and not auto-derived)
  const manualTag = req.body.triage_tag !== undefined ? req.body.triage_tag : current.triage_tag;
  const newTriageTag = deriveTriageTag(newStatus, newDueAt, newRepliedAt, manualTag);

  const completedAt = newStatus === 'done' ? 'NOW()' : null;

  try {
    const r = await pool.query(
      `UPDATE mail_reply_tasks SET
        status                = $1,
        priority              = $2,
        assigned_to           = $3,
        assigned_to_name      = $4,
        assigned_to_email     = $5,
        assigned_to_phone     = $6,
        notify_channel        = $7,
        notify_before_minutes = $8,
        triage_tag            = $9,
        replied_at            = $10,
        due_at                = $11,
        notes                 = $12,
        completed_at          = ${completedAt ? 'NOW()' : 'NULL'},
        updated_at            = NOW()
       WHERE id = $13
       RETURNING *`,
      [
        newStatus, newPriority,
        newAssignedTo, newAssignedToName, newAssignedToEmail, newAssignedToPhone,
        newChannel, newNotifyMins,
        newTriageTag, newRepliedAt,
        newDueAt, newNotes,
        id,
      ]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Task not found' });
    const full = await pool.query(`${taskSelectSql()} WHERE t.id = $1`, [id]);
    return res.json(full.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/mail-tasks/:id
router.delete('/:id', async (req, res) => {
  await ensureMailTasksTable();
  try {
    const r = await pool.query(`DELETE FROM mail_reply_tasks WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Task not found' });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.normalizeNotifyChannel = normalizeNotifyChannel;
module.exports.normalizeTriageTag     = normalizeTriageTag;
module.exports.deriveTriageTag        = deriveTriageTag;
module.exports.normalizePriority      = normalizePriority;
module.exports.normalizeStatus        = normalizeStatus;

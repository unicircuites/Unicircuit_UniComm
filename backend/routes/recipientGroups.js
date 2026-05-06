/**
 * Recipient Groups Routes
 * GET    /api/groups              — list all groups
 * POST   /api/groups              — create group
 * GET    /api/groups/:id          — get group with members
 * PUT    /api/groups/:id          — update group name/description
 * DELETE /api/groups/:id          — delete group
 * POST   /api/groups/:id/members  — add contacts to group
 * DELETE /api/groups/:id/members  — remove contacts from group
 */
const express = require('express');
const pool    = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recipient_groups (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(200) NOT NULL,
      description TEXT,
      created_by  INT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recipient_group_members (
      group_id   INT NOT NULL REFERENCES recipient_groups(id) ON DELETE CASCADE,
      contact_id INT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      added_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (group_id, contact_id)
    )
  `);
}
ensureTables().catch(e => console.error('[Groups] Table init:', e.message));

// ── GET /api/groups ───────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT g.id, g.name, g.description, g.created_at,
             COUNT(m.contact_id)::int AS member_count
      FROM recipient_groups g
      LEFT JOIN recipient_group_members m ON m.group_id = g.id
      GROUP BY g.id
      ORDER BY g.name ASC
    `);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/groups ──────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { name, description, contact_ids } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Group name required' });
  try {
    const r = await pool.query(
      `INSERT INTO recipient_groups (name, description, created_by)
       VALUES ($1,$2,$3) RETURNING *`,
      [name.trim(), description || null, req.user.id]
    );
    const group = r.rows[0];
    // Add initial contacts if provided
    if (Array.isArray(contact_ids) && contact_ids.length) {
      const vals = contact_ids.map((cid, i) => `($1, $${i+2})`).join(',');
      await pool.query(
        `INSERT INTO recipient_group_members (group_id, contact_id) VALUES ${vals} ON CONFLICT DO NOTHING`,
        [group.id, ...contact_ids]
      );
    }
    group.member_count = contact_ids ? contact_ids.length : 0;
    res.status(201).json(group);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/groups/:id ───────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const g = await pool.query(`SELECT * FROM recipient_groups WHERE id=$1`, [req.params.id]);
    if (!g.rowCount) return res.status(404).json({ error: 'Group not found' });
    const members = await pool.query(`
      SELECT c.id, c.fname, c.lname, c.company, c.email, c.phone,
             c.avatar_color, c.avatar_bg, c.initials, c.segment
      FROM recipient_group_members m
      JOIN contacts c ON c.id = m.contact_id
      WHERE m.group_id = $1
      ORDER BY c.fname, c.lname
    `, [req.params.id]);
    res.json({ ...g.rows[0], members: members.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/groups/:id ───────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Group name required' });
  try {
    const r = await pool.query(
      `UPDATE recipient_groups SET name=$1, description=$2, updated_at=NOW()
       WHERE id=$3 RETURNING *`,
      [name.trim(), description || null, req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Group not found' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/groups/:id ────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM recipient_groups WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/groups/:id/members — add contacts ───────────────────────────
router.post('/:id/members', async (req, res) => {
  const { contact_ids } = req.body;
  if (!Array.isArray(contact_ids) || !contact_ids.length)
    return res.status(400).json({ error: 'contact_ids array required' });
  try {
    const vals = contact_ids.map((cid, i) => `($1, $${i+2})`).join(',');
    await pool.query(
      `INSERT INTO recipient_group_members (group_id, contact_id) VALUES ${vals} ON CONFLICT DO NOTHING`,
      [req.params.id, ...contact_ids]
    );
    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM recipient_group_members WHERE group_id=$1`, [req.params.id]
    );
    res.json({ success: true, member_count: count.rows[0].n });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/groups/:id/members — remove contacts ─────────────────────
router.delete('/:id/members', async (req, res) => {
  const { contact_ids } = req.body;
  if (!Array.isArray(contact_ids) || !contact_ids.length)
    return res.status(400).json({ error: 'contact_ids array required' });
  try {
    await pool.query(
      `DELETE FROM recipient_group_members WHERE group_id=$1 AND contact_id = ANY($2::int[])`,
      [req.params.id, contact_ids]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

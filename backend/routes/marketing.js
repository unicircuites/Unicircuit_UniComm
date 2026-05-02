/**
 * Marketing Routes — Manual snapshot entry + retrieval
 */
const express = require('express');
const pool    = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ── ENSURE TABLES ─────────────────────────────────────────────────────────
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketing_snapshots (
      id                  SERIAL PRIMARY KEY,
      sync_date           DATE NOT NULL DEFAULT CURRENT_DATE,
      -- Email Stats
      email_sent          INT DEFAULT 0,
      email_bounces       INT DEFAULT 0,
      email_spam          INT DEFAULT 0,
      email_unsubscribes  INT DEFAULT 0,
      -- Landing Page
      lp_total_views      INT DEFAULT 0,
      lp_unique_views     INT DEFAULT 0,
      lp_submissions      INT DEFAULT 0,
      lp_mobile_views     INT DEFAULT 0,
      lp_desktop_views    INT DEFAULT 0,
      -- Contacts
      contact_total       INT DEFAULT 0,
      -- One to One Email
      oto_sent            INT DEFAULT 0,
      oto_opens           INT DEFAULT 0,
      oto_open_rate       NUMERIC(5,2) DEFAULT 0,
      oto_clicks          INT DEFAULT 0,
      oto_click_rate      NUMERIC(5,2) DEFAULT 0,
      -- Meta
      notes               TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(sync_date)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketing_broadcasts (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(300) NOT NULL,
      click_rate  NUMERIC(5,2) DEFAULT 0,
      sent_date   DATE,
      snapshot_id INT REFERENCES marketing_snapshots(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketing_contacts (
      id           SERIAL PRIMARY KEY,
      name         VARCHAR(200),
      email        VARCHAR(200),
      added_date   DATE,
      source       VARCHAR(100),
      snapshot_id  INT REFERENCES marketing_snapshots(id) ON DELETE CASCADE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}
ensureTables().catch(e => console.error('[Marketing] Table init error:', e.message));

// ── GET latest snapshot ───────────────────────────────────────────────────
router.get('/latest', async (req, res) => {
  try {
    const snap = await pool.query(
      `SELECT * FROM marketing_snapshots ORDER BY sync_date DESC LIMIT 1`
    );
    if (!snap.rows.length) return res.json(null);

    const snapId = snap.rows[0].id;
    const broadcasts = await pool.query(
      `SELECT * FROM marketing_broadcasts WHERE snapshot_id=$1 ORDER BY sent_date DESC`,
      [snapId]
    );
    const contacts = await pool.query(
      `SELECT * FROM marketing_contacts WHERE snapshot_id=$1 ORDER BY added_date DESC LIMIT 10`,
      [snapId]
    );
    res.json({
      ...snap.rows[0],
      broadcasts: broadcasts.rows,
      recent_contacts: contacts.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET last 7 snapshots (for trend) ─────────────────────────────────────
router.get('/history', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sync_date, email_sent, email_bounces, contact_total,
              lp_total_views, oto_open_rate, oto_click_rate
       FROM marketing_snapshots ORDER BY sync_date DESC LIMIT 7`
    );
    res.json(result.rows.reverse()); // oldest first for chart
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST save/update snapshot ─────────────────────────────────────────────
router.post('/snapshot', async (req, res) => {
  const {
    sync_date,
    email_sent, email_bounces, email_spam, email_unsubscribes,
    lp_total_views, lp_unique_views, lp_submissions, lp_mobile_views, lp_desktop_views,
    contact_total,
    oto_sent, oto_opens, oto_open_rate, oto_clicks, oto_click_rate,
    notes,
    broadcasts,   // array: [{name, click_rate, sent_date}]
    recent_contacts, // array: [{name, email, added_date, source}]
  } = req.body;

  const date = sync_date || new Date().toISOString().split('T')[0];

  try {
    // Upsert snapshot
    const result = await pool.query(`
      INSERT INTO marketing_snapshots
        (sync_date, email_sent, email_bounces, email_spam, email_unsubscribes,
         lp_total_views, lp_unique_views, lp_submissions, lp_mobile_views, lp_desktop_views,
         contact_total, oto_sent, oto_opens, oto_open_rate, oto_clicks, oto_click_rate, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (sync_date) DO UPDATE SET
        email_sent=$2, email_bounces=$3, email_spam=$4, email_unsubscribes=$5,
        lp_total_views=$6, lp_unique_views=$7, lp_submissions=$8,
        lp_mobile_views=$9, lp_desktop_views=$10,
        contact_total=$11, oto_sent=$12, oto_opens=$13, oto_open_rate=$14,
        oto_clicks=$15, oto_click_rate=$16, notes=$17,
        created_at=NOW()
      RETURNING *
    `, [date,
        email_sent||0, email_bounces||0, email_spam||0, email_unsubscribes||0,
        lp_total_views||0, lp_unique_views||0, lp_submissions||0,
        lp_mobile_views||0, lp_desktop_views||0,
        contact_total||0,
        oto_sent||0, oto_opens||0, oto_open_rate||0, oto_clicks||0, oto_click_rate||0,
        notes||null
    ]);

    const snapId = result.rows[0].id;

    // Replace broadcasts for this snapshot
    if (Array.isArray(broadcasts)) {
      await pool.query(`DELETE FROM marketing_broadcasts WHERE snapshot_id=$1`, [snapId]);
      for (const b of broadcasts) {
        if (!b.name) continue;
        await pool.query(
          `INSERT INTO marketing_broadcasts (name, click_rate, sent_date, snapshot_id)
           VALUES ($1,$2,$3,$4)`,
          [b.name, b.click_rate||0, b.sent_date||null, snapId]
        );
      }
    }

    // Replace recent contacts for this snapshot
    if (Array.isArray(recent_contacts)) {
      await pool.query(`DELETE FROM marketing_contacts WHERE snapshot_id=$1`, [snapId]);
      for (const c of recent_contacts) {
        if (!c.email && !c.name) continue;
        await pool.query(
          `INSERT INTO marketing_contacts (name, email, added_date, source, snapshot_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [c.name||null, c.email||null, c.added_date||null, c.source||null, snapId]
        );
      }
    }

    res.json({ success: true, snapshot: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

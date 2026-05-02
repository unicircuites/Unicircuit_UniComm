/**
 * outlook_mail_stats — DB cache for per-address mail counts.
 *
 * Schema (auto-created):
 *   email            TEXT PRIMARY KEY  (lowercased)
 *   sent_to_them     INT
 *   received_from    INT
 *   last_email_at    TIMESTAMPTZ
 *   synced_at        TIMESTAMPTZ
 *
 * Usage:
 *   POST /api/outlook/sync-stats  → calls buildAndStore() — scans all mail, upserts every address
 *   GET  /api/contacts/:id/activity → calls getForEmail() — instant DB read
 */
const pool      = require('../db/pool');
const mailStats = require('./outlookContactMailStats');

const TABLE = 'outlook_mail_stats';

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      email           TEXT PRIMARY KEY,
      sent_to_them    INT  NOT NULL DEFAULT 0,
      received_from   INT  NOT NULL DEFAULT 0,
      last_email_at   TIMESTAMPTZ,
      synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * Full scan: reads all Sent + Inbox pages via buildDirectoryStatsMap,
 * then upserts every address into the DB cache.
 * Called by POST /api/outlook/sync-stats.
 * @returns {{ upserted: number, synced_at: string }}
 */
async function buildAndStore(msEmail) {
  await ensureTable();
  const statsMap = await mailStats.buildDirectoryStatsMap(msEmail, mailStats.MAIL_SCAN_PAGES);
  const now = new Date();
  let upserted = 0;

  for (const [normEmail, st] of statsMap) {
    if (!normEmail) continue;
    await pool.query(
      `INSERT INTO ${TABLE} (email, sent_to_them, received_from, last_email_at, synced_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         sent_to_them  = EXCLUDED.sent_to_them,
         received_from = EXCLUDED.received_from,
         last_email_at = EXCLUDED.last_email_at,
         synced_at     = EXCLUDED.synced_at`,
      [
        normEmail,
        st.sentToThem       || 0,
        st.receivedFromThem || 0,
        st.lastEmailAt      || null,
        now,
      ]
    );
    upserted++;
  }

  return { upserted, synced_at: now.toISOString() };
}

/**
 * Read cached stats for one email address.
 * Returns null if never synced or address not found.
 * @returns {{ sent_to_them: number, received_from: number, last_email_at: string|null, synced_at: string|null } | null}
 */
async function getForEmail(email) {
  if (!email) return null;
  try {
    await ensureTable();
    const norm = String(email).toLowerCase().trim();
    const r = await pool.query(
      `SELECT sent_to_them, received_from, last_email_at, synced_at FROM ${TABLE} WHERE email = $1`,
      [norm]
    );
    return r.rows[0] || null;
  } catch (_) {
    return null;
  }
}

/**
 * When was the last sync run?
 * @returns {string|null} ISO timestamp or null
 */
async function lastSyncedAt() {
  try {
    await ensureTable();
    const r = await pool.query(`SELECT MAX(synced_at) AS t FROM ${TABLE}`);
    return r.rows[0]?.t ? new Date(r.rows[0].t).toISOString() : null;
  } catch (_) {
    return null;
  }
}

module.exports = { buildAndStore, getForEmail, lastSyncedAt, ensureTable };

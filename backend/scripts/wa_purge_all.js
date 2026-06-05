/**
 * Purge all WhatsApp chat/contact/message rows from DB for a fresh sync test.
 * Usage: node backend/scripts/wa_purge_all.js [--apply]
 * Without --apply, only prints counts (dry run).
 */
const pool = require('../db/pool');

const TABLES = ['wa_messages', 'wa_chats', 'wa_contacts', 'wa_chat_blocklist'];

async function counts() {
  const rows = [];
  for (const table of TABLES) {
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
    rows.push({ table, rows: r.rows[0].n });
  }
  const accounts = await pool.query(`
    SELECT account_phone, COUNT(*)::int AS chats
    FROM wa_chats
    GROUP BY account_phone
    ORDER BY chats DESC
  `);
  return { rows, accounts: accounts.rows };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const before = await counts();
  console.log('[WA purge] Before:', before);

  if (!apply) {
    console.log('[WA purge] Dry run only. Re-run with --apply to delete all WhatsApp DB rows.');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of TABLES) {
      const r = await client.query(`DELETE FROM ${table}`);
      console.log(`[WA purge] Deleted ${r.rowCount} from ${table}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const after = await counts();
  console.log('[WA purge] After:', after);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});

const pool = require('../db/pool');

async function main() {
  const acc = String(process.argv[2] || '').replace(/\D/g, '');
  if (!acc) {
    console.error('Usage: node backend/scripts/wa_msg_names.js <connected_account_phone>');
    process.exit(1);
  }
  const r = await pool.query(`
    SELECT sender, sender_name, COUNT(*)::int AS cnt
    FROM wa_messages
    WHERE account_phone = $1
      AND sender_name IS NOT NULL AND sender_name != ''
      AND sender_name !~ '^\\+?[0-9]'
      AND from_me = false
    GROUP BY sender, sender_name
    ORDER BY cnt DESC
    LIMIT 30
  `, [acc]);
  console.log('sender names in messages', r.rows);

  const chatNames = await pool.query(`
    SELECT id, name FROM wa_chats
    WHERE account_phone = $1 AND name IS NOT NULL AND name !~ '^\\+?[0-9]'
  `, [acc]);
  console.log('chat names', chatNames.rows);

  await pool.end();
}

main().catch(async (e) => { console.error(e); process.exit(1); });

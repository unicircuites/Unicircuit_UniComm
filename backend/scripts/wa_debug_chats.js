const pool = require('../db/pool');

async function main() {
  const accounts = await pool.query(`
    SELECT account_phone, COUNT(*)::int AS chats,
      (SELECT COUNT(*)::int FROM wa_messages m WHERE m.account_phone = c.account_phone) AS msgs
    FROM wa_chats c
    GROUP BY account_phone
    ORDER BY chats DESC
  `);
  console.log('Accounts:', accounts.rows);

  const phone = String(process.argv[2] || '').replace(/\D/g, '');
  if (phone) {
    const chats = await pool.query(`
      SELECT c.account_phone, c.id, c.name, c.phone,
        (SELECT COUNT(*)::int FROM wa_messages m WHERE m.chat_id = c.id AND m.account_phone = c.account_phone) AS msg_count
      FROM wa_chats c
      WHERE regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = $1
         OR split_part(c.id, '@', 1) = $1
         OR c.id LIKE $2
      ORDER BY msg_count DESC
      LIMIT 20
    `, [phone, phone + '%']);
    console.log('\nChats for', phone, ':', chats.rows);
  } else {
    console.log('\nOptional: pass a contact phone to inspect matching chats, e.g. node backend/scripts/wa_debug_chats.js 919994492496');
  }

  const lidOrphans = await pool.query(`
    SELECT c.id, c.phone, c.account_phone,
      (SELECT COUNT(*)::int FROM wa_messages m WHERE m.chat_id = c.id AND m.account_phone = c.account_phone) AS msgs
    FROM wa_chats c
    WHERE c.id LIKE '%@lid'
      AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') != ''
      AND NOT EXISTS (
        SELECT 1 FROM wa_chats p
        WHERE p.account_phone = c.account_phone
          AND p.id = regexp_replace(c.phone, '[^0-9]', '', 'g') || '@s.whatsapp.net'
      )
    LIMIT 10
  `);
  console.log('\nLID chats with phone but no phone-jid duplicate:', lidOrphans.rows);

  const msgMismatch = await pool.query(`
    SELECT COUNT(*)::int AS lid_msgs
    FROM wa_messages m
    JOIN wa_chats c ON c.id = m.chat_id AND c.account_phone = m.account_phone
    WHERE m.chat_id LIKE '%@lid'
      AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') ~ '^[0-9]{7,14}$'
  `);
  console.log('\nMessages stored under @lid chat_id with resolved phone:', msgMismatch.rows[0]);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});

const pool = require('../db/pool');

async function main() {
  const acc = String(process.argv[2] || '').replace(/\D/g, '');
  if (!acc) {
    console.error('Usage: node backend/scripts/wa_cleanup_account.js <connected_account_phone>');
    process.exit(1);
  }

  await pool.query(`
    UPDATE wa_contacts SET phone = NULL, updated_at = NOW()
    WHERE account_phone = $1 AND jid LIKE '%@lid'
      AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = split_part(jid, '@', 1)
  `, [acc]);

  await pool.query(`
    UPDATE wa_contacts SET name = NULL, updated_at = NOW()
    WHERE account_phone = $1
      AND (name ~ '^\\+?[0-9]' OR regexp_replace(COALESCE(name, ''), '[^0-9]', '', 'g') = split_part(jid, '@', 1))
  `, [acc]);

  await pool.query(`
    UPDATE wa_chats SET name = NULL, phone = NULL, updated_at = NOW()
    WHERE account_phone = $1 AND id LIKE '%@lid'
      AND (name ~ '^\\+?[0-9]' OR regexp_replace(COALESCE(name, ''), '[^0-9]', '', 'g') = split_part(id, '@', 1))
  `, [acc]);

  await pool.query(`
    UPDATE wa_chats SET phone = NULL, updated_at = NOW()
    WHERE account_phone = $1 AND id LIKE '%@lid'
      AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = split_part(id, '@', 1)
  `, [acc]);

  const removed = await pool.query(`
    DELETE FROM wa_chats
    WHERE account_phone = $1
      AND (id LIKE '%@newsletter' OR id LIKE '%@broadcast' OR id = 'status@broadcast')
    RETURNING id
  `, [acc]);

  const orphanLids = await pool.query(`
    DELETE FROM wa_chats c
    WHERE c.account_phone = $1
      AND c.id LIKE '%@lid'
      AND COALESCE(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), '') = ''
      AND COALESCE(NULLIF(c.name, ''), (
        SELECT NULLIF(wc.notify, '')
        FROM wa_contacts wc
        WHERE wc.jid = c.id AND wc.account_phone = c.account_phone
        LIMIT 1
      )) IS NULL
    RETURNING id
  `, [acc]);

  const stats = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM wa_chats WHERE account_phone = $1) AS chats,
      (SELECT COUNT(*)::int FROM wa_messages WHERE account_phone = $1) AS messages,
      (SELECT COUNT(*)::int FROM wa_contacts WHERE account_phone = $1) AS contacts
  `, [acc]);

  console.log('[WA cleanup]', acc, {
    removed_non_chats: removed.rowCount,
    removed_orphan_lids: orphanLids.rowCount,
    stats: stats.rows[0],
  });
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});

const pool = require('../db/pool');

function arg(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

async function section(title, sql, params = []) {
  console.log(`\n=== ${title} ===`);
  const result = await pool.query(sql, params);
  console.table(result.rows);
}

async function main() {
  const account = String(arg('account', '')).replace(/\D/g, '');
  const oldAccount = String(arg('old', '')).replace(/\D/g, '');
  const search = arg('search', 'Attendance');

  console.log('[WA DB Audit]', {
    account: account || '(not provided)',
    oldAccount,
    search,
    db: process.env.DB_NAME || 'unicomm_db',
    host: process.env.DB_HOST || 'localhost',
  });

  await section('wa_chats by account_phone', `
    SELECT account_phone, COUNT(*)::int AS chats,
      COUNT(*) FILTER (WHERE is_group)::int AS groups,
      COUNT(*) FILTER (WHERE id LIKE '%@s.whatsapp.net')::int AS phone_chats,
      COUNT(*) FILTER (WHERE id LIKE '%@lid')::int AS lid_chats,
      MAX(updated_at) AS latest_update
    FROM wa_chats
    GROUP BY account_phone
    ORDER BY chats DESC
  `);

  await section('wa_messages by account_phone', `
    SELECT account_phone, COUNT(*)::int AS messages, MAX(timestamp) AS latest_message
    FROM wa_messages
    GROUP BY account_phone
    ORDER BY messages DESC
  `);

  await section('wa_contacts by account_phone', `
    SELECT account_phone, COUNT(*)::int AS contacts,
      COUNT(*) FILTER (WHERE jid LIKE '%@lid')::int AS lid_contacts,
      COUNT(*) FILTER (WHERE phone IS NOT NULL AND phone <> '')::int AS with_phone,
      MAX(updated_at) AS latest_update
    FROM wa_contacts
    GROUP BY account_phone
    ORDER BY contacts DESC
  `);

  await section(`chats matching "${search}"`, `
    SELECT account_phone, id, name, phone, is_group, last_message, last_time, updated_at
    FROM wa_chats
    WHERE name ILIKE $1 OR last_message ILIKE $1 OR id ILIKE $1
    ORDER BY updated_at DESC NULLS LAST, last_time DESC NULLS LAST
    LIMIT 50
  `, [`%${search}%`]);

  if (account) {
    await section(`latest chats for current account ${account}`, `
      SELECT id, name, phone, is_group, last_message, last_time, updated_at
      FROM wa_chats
      WHERE account_phone = $1
      ORDER BY updated_at DESC NULLS LAST, last_time DESC NULLS LAST
      LIMIT 40
    `, [account]);

    await section(`possible old-number contamination under ${account}`, `
      SELECT id, name, phone, is_group, last_message, last_time, updated_at
      FROM wa_chats
      WHERE account_phone = $1
        AND (
          id LIKE $2
          OR phone LIKE $3
          OR name ILIKE '%Attendance%'
          OR last_message ILIKE '%Attendance%'
        )
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 50
    `, [account, `%${oldAccount}%`, `%${oldAccount}%`]);

    await section(`duplicate chat ids also present under ${account}`, `
      SELECT c.id, c.name, c.account_phone, other.account_phone AS also_in_account
      FROM wa_chats c
      JOIN wa_chats other ON other.id = c.id AND other.account_phone <> c.account_phone
      WHERE c.account_phone = $1
      ORDER BY c.updated_at DESC NULLS LAST
      LIMIT 50
    `, [account]);

    await section(`blocklist for ${account}`, `
      SELECT account_phone, chat_id, reason, created_at
      FROM wa_chat_blocklist
      WHERE account_phone = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [account]);
  }

  await section('unknown account rows', `
    SELECT 'wa_chats' AS table_name, COUNT(*)::int AS rows FROM wa_chats WHERE account_phone = 'unknown'
    UNION ALL
    SELECT 'wa_messages', COUNT(*)::int FROM wa_messages WHERE account_phone = 'unknown'
    UNION ALL
    SELECT 'wa_contacts', COUNT(*)::int FROM wa_contacts WHERE account_phone = 'unknown'
  `);

  await pool.end();
}

main().catch(async err => {
  console.error('[WA DB Audit] Failed:', err.message);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});

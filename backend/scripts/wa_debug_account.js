const pool = require('../db/pool');

async function main() {
  const acc = String(process.argv[2] || '').replace(/\D/g, '');
  if (!acc) {
    console.error('Usage: node backend/scripts/wa_debug_account.js <connected_account_phone>');
    process.exit(1);
  }
  const sample = await pool.query(`
    SELECT jid, name, phone, notify
    FROM wa_contacts
    WHERE account_phone = $1
    ORDER BY updated_at DESC
    LIMIT 15
  `, [acc]);
  console.log('Sample contacts:', sample.rows);

  const badPhones = await pool.query(`
    SELECT COUNT(*)::int AS cnt
    FROM wa_contacts
    WHERE account_phone = $1
      AND (
        regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = split_part(jid, '@', 1)
        OR length(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')) >= 15
      )
  `, [acc]);
  console.log('Contacts with LID-as-phone:', badPhones.rows[0]);

  const goodPhones = await pool.query(`
    SELECT COUNT(*)::int AS cnt
    FROM wa_contacts
    WHERE account_phone = $1
      AND phone IS NOT NULL AND phone != ''
      AND length(regexp_replace(phone, '[^0-9]', '', 'g')) BETWEEN 7 AND 14
      AND regexp_replace(phone, '[^0-9]', '', 'g') != split_part(jid, '@', 1)
  `, [acc]);
  console.log('Contacts with real resolved phone:', goodPhones.rows[0]);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});

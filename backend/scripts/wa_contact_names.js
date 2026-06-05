const pool = require('../db/pool');

async function main() {
  const acc = String(process.argv[2] || '').replace(/\D/g, '');
  if (!acc) {
    console.error('Usage: node backend/scripts/wa_contact_names.js <connected_account_phone>');
    process.exit(1);
  }
  const named = await pool.query(`
    SELECT name, notify, phone, jid
    FROM wa_contacts
    WHERE account_phone = $1
      AND (
        NULLIF(notify, '') IS NOT NULL
        OR (NULLIF(name, '') IS NOT NULL AND name !~ '^\\+?[0-9]')
      )
    LIMIT 40
  `, [acc]);
  console.log('named contacts', named.rows);

  const phoneAsName = await pool.query(`
    SELECT COUNT(*)::int AS cnt
    FROM wa_contacts WHERE account_phone = $1 AND name ~ '^\\+'
  `, [acc]);
  console.log('phone formatted as name', phoneAsName.rows[0]);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});

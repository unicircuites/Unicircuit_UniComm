const pool = require('../db/pool');

async function main() {
  const acc = String(process.argv[2] || '').replace(/\D/g, '');
  if (!acc) {
    console.error('Usage: node backend/scripts/wa_analyze_names.js <connected_account_phone>');
    process.exit(1);
  }

  const wa = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE NULLIF(name, '') IS NOT NULL)::int AS with_name,
      COUNT(*) FILTER (WHERE NULLIF(notify, '') IS NOT NULL)::int AS with_notify,
      COUNT(*) FILTER (WHERE NULLIF(phone, '') IS NOT NULL)::int AS with_phone
    FROM wa_contacts WHERE account_phone = $1
  `, [acc]);
  console.log('wa_contacts', wa.rows[0]);

  const crmSample = await pool.query(`
    SELECT fname, lname, phone, wa FROM contacts WHERE phone IS NOT NULL OR wa IS NOT NULL LIMIT 8
  `);
  console.log('crm sample', crmSample.rows);

  const matchPhone = await pool.query(`
    SELECT COUNT(*)::int AS matched
    FROM wa_contacts wc
    JOIN contacts c ON (
      regexp_replace(COALESCE(c.phone, c.wa, ''), '[^0-9]', '', 'g') = regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g')
      OR right(regexp_replace(COALESCE(c.phone, c.wa, ''), '[^0-9]', '', 'g'), 10) = right(regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g'), 10)
    )
    WHERE wc.account_phone = $1 AND wc.phone IS NOT NULL
  `, [acc]);
  console.log('crm matches', matchPhone.rows[0]);

  const msgNames = await pool.query(`
    SELECT COUNT(DISTINCT sender)::int AS senders
    FROM wa_messages
    WHERE account_phone = $1 AND sender_name IS NOT NULL AND sender_name != ''
      AND sender_name !~ '^\\+?[0-9]'
  `, [acc]);
  console.log('message sender names', msgNames.rows[0]);

  const enrichSample = await pool.query(`
    SELECT wc.phone, wc.name, wc.notify,
      (SELECT m.sender_name FROM wa_messages m
       WHERE m.account_phone = wc.account_phone
         AND (m.sender = wc.jid OR regexp_replace(split_part(COALESCE(m.sender,''), '@', 1), '[^0-9]', '', 'g') = regexp_replace(COALESCE(wc.phone,''), '[^0-9]', '', 'g'))
         AND m.sender_name IS NOT NULL AND m.sender_name !~ '^\\+?[0-9]'
       ORDER BY m.timestamp DESC LIMIT 1) AS msg_name,
      trim(concat(c.fname, ' ', c.lname)) AS crm_name
    FROM wa_contacts wc
    LEFT JOIN contacts c ON (
      regexp_replace(COALESCE(c.phone, c.wa, ''), '[^0-9]', '', 'g') = regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g')
      OR right(regexp_replace(COALESCE(c.phone, c.wa, ''), '[^0-9]', '', 'g'), 10) = right(regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g'), 10)
    )
    WHERE wc.account_phone = $1 AND wc.phone IS NOT NULL
    LIMIT 15
  `, [acc]);
  console.log('enrich samples', enrichSample.rows);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});

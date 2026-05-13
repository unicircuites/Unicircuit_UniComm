const pool = require('../db/pool');
async function check() {
  const chats = await pool.query(`SELECT COUNT(*) FROM wa_chats WHERE id LIKE '%@lid' AND phone IS NOT NULL AND phone != ''`);
  const contacts = await pool.query(`SELECT COUNT(*) FROM wa_contacts WHERE jid LIKE '%@lid' AND phone IS NOT NULL AND phone != '' AND phone ~ '^[0-9]'`);
  console.log('wa_chats LID with phone:', chats.rows[0].count);
  console.log('wa_contacts LID with phone:', contacts.rows[0].count);

  // Check the Attendance Group members specifically
  // From screenshot: +91 79729 83665, +91 93052 03546, etc.
  // Let's see what LIDs are in wa_contacts but NOT in wa_chats
  const onlyInContacts = await pool.query(`
    SELECT c.jid, c.name, c.phone
    FROM wa_contacts c
    WHERE c.jid LIKE '%@lid'
      AND c.phone IS NOT NULL AND c.phone != '' AND c.phone ~ '^[0-9]'
      AND NOT EXISTS (
        SELECT 1 FROM wa_chats ch WHERE ch.id = c.jid
      )
    LIMIT 10
  `);
  console.log('\nLID contacts in wa_contacts but NOT in wa_chats (sample):');
  console.log(onlyInContacts.rows);
  process.exit();
}
check().catch(e => { console.error(e.message); process.exit(1); });

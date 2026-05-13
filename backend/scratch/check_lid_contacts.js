const pool = require('../db/pool');

async function checkLidContacts() {
  try {
    const result = await pool.query(`
      SELECT jid, name, phone 
      FROM wa_contacts 
      WHERE jid LIKE '%@lid' 
      LIMIT 10
    `);
    console.log('LID Contacts in wa_contacts:');
    console.log(JSON.stringify(result.rows, null, 2));
    
    const msgResult = await pool.query(`
      SELECT DISTINCT m.sender, m.sender_name, c.phone
      FROM wa_messages m
      LEFT JOIN wa_contacts c ON c.jid = m.sender
      WHERE m.sender LIKE '%@lid'
      LIMIT 10
    `);
    console.log('\nLID Senders in wa_messages:');
    console.log(JSON.stringify(msgResult.rows, null, 2));
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    process.exit();
  }
}

checkLidContacts();

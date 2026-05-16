const pool = require('./backend/db/pool');

async function cleanup() {
  console.log('Cleaning up LID numbers accidentally saved as phone numbers in wa_contacts...');
  
  try {
    const res = await pool.query(`
      UPDATE wa_contacts 
      SET phone = NULL 
      WHERE jid LIKE '%@lid' AND phone = split_part(jid, '@', 1);
    `);
    
    console.log(`Cleaned up ${res.rowCount} records in wa_contacts.`);

    const res2 = await pool.query(`
      UPDATE wa_chats
      SET phone = NULL
      WHERE id LIKE '%@lid' AND phone = '+' || split_part(id, '@', 1);
    `);

    console.log(`Cleaned up ${res2.rowCount} records in wa_chats.`);

  } catch (err) {
    console.error('Error during cleanup:', err);
  } finally {
    process.exit(0);
  }
}

cleanup();

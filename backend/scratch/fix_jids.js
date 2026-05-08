const { Pool } = require('pg');
require('dotenv').config();

// Use individual env vars as per your .env file
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'unicomm_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || ''
});

async function fixJids() {
  console.log(`Fixing JIDs in database "${process.env.DB_NAME || 'unicomm_db'}"...`);
  try {
    // Fix wa_chats
    const res1 = await pool.query(`
      UPDATE wa_chats 
      SET id = split_part(id, ':', 1) || '@' || split_part(id, '@', 2) 
      WHERE id LIKE '%:%@%';
    `);
    console.log(`Updated ${res1.rowCount} rows in wa_chats.`);

    // Fix wa_messages
    const res2 = await pool.query(`
      UPDATE wa_messages 
      SET chat_id = split_part(chat_id, ':', 1) || '@' || split_part(chat_id, '@', 2) 
      WHERE chat_id LIKE '%:%@%';
    `);
    console.log(`Updated ${res2.rowCount} rows in wa_messages.`);

    // Fix wa_contacts
    const res3 = await pool.query(`
      UPDATE wa_contacts 
      SET jid = split_part(jid, ':', 1) || '@' || split_part(jid, '@', 2) 
      WHERE jid LIKE '%:%@%';
    `);
    console.log(`Updated ${res3.rowCount} rows in wa_contacts.`);

    console.log("Success! JIDs normalized.");

  } catch (err) {
    console.error("Error fixing JIDs:", err.message);
  } finally {
    await pool.end();
  }
}

fixJids();

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'unicomm_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || ''
});

async function checkLatestMessages() {
  const jidPrefix = '919545073545';
  console.log(`Checking latest messages for JID starting with ${jidPrefix}...`);
  try {
    const res = await pool.query(`
      SELECT chat_id, from_me, body, timestamp 
      FROM wa_messages 
      WHERE chat_id LIKE $1 || '%' 
      ORDER BY timestamp DESC 
      LIMIT 10
    `, [jidPrefix]);
    
    if (res.rows.length === 0) {
      console.log("No messages found for this number.");
    } else {
      console.table(res.rows);
    }
  } catch (err) {
    console.error("Error fetching messages:", err.message);
  } finally {
    await pool.end();
  }
}

checkLatestMessages();

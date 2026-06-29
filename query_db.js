process.env.DB_HOST = '192.168.0.200';
process.env.DB_PASSWORD = 'Unicircuit@2026';
const pool = require('./backend/db/pool');

async function run() {
  try {
    const contacts = await pool.query(
      "SELECT jid, name, phone FROM wa_contacts WHERE jid LIKE '%153390831108330%' LIMIT 5"
    );
    console.log("Contacts matching LID:", contacts.rows);

    const chats = await pool.query(
      "SELECT id, name, phone FROM wa_chats WHERE id LIKE '%153390831108330%' LIMIT 5"
    );
    console.log("Chats matching LID:", chats.rows);
  } catch (err) {
    console.error("DB Error:", err.message);
  } finally {
    await pool.end();
  }
}
run();

const pool = require('../db/pool');

async function run() {
  try {
    const lid = '153390831108330@lid';
    const phone = '917218442999';
    const accPhone = '919359475770';
    
    await pool.query(
      `INSERT INTO wa_contacts (jid, account_phone, name, notify, phone) 
       VALUES ($1, $2, 'Vijay Khatakte', 'Vijay Khatakte', $3) 
       ON CONFLICT (jid, account_phone) 
       DO UPDATE SET phone = EXCLUDED.phone`,
      [lid, accPhone, phone]
    );
    console.log(`\n✅ Successfully mapped JID ${lid} to Phone ${phone} in database!`);
    
    // Clear any previous cached null/error profile pic url to force a fresh fetch
    await pool.query(
      `UPDATE wa_chats SET profile_pic_url = NULL WHERE id = $1 AND account_phone = $2`,
      [lid, accPhone]
    );
    console.log(`✅ Cleared previous cached DP state for this chat to trigger a fresh fetch.`);

  } catch (err) {
    console.error('❌ Error mapping contact:', err.message);
  } finally {
    await pool.end();
  }
}

run();

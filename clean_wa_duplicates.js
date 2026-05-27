const pool = require('./backend/db/pool');

async function cleanupDuplicates() {
  console.log('[Cleanup] Starting deduplication of WhatsApp data...');
  try {
    for (const table of ['wa_contacts', 'wa_chats']) {
      const col = table === 'wa_contacts' ? 'jid' : 'id';
      const res = await pool.query(`SELECT ${col}, account_phone FROM ${table} WHERE ${col} LIKE '%@s.whatsapp.net@s.whatsapp.net' OR ${col} LIKE '%@g.us@g.us'`);
      for (const row of res.rows) {
        const badId = row[col];
        const accPhone = row.account_phone;
        const goodId = badId.replace('@s.whatsapp.net@s.whatsapp.net', '@s.whatsapp.net').replace('@g.us@g.us', '@g.us');
        
        try {
          // Check if goodId exists
          const exists = await pool.query(`SELECT 1 FROM ${table} WHERE ${col} = $1 AND account_phone = $2`, [goodId, accPhone]);
          if (exists.rows.length > 0) {
            // Just delete the bad one
            await pool.query(`DELETE FROM ${table} WHERE ${col} = $1 AND account_phone = $2`, [badId, accPhone]);
            console.log(`Deleted duplicate in ${table}: ${badId}`);
          } else {
            // Update bad to good
            await pool.query(`UPDATE ${table} SET ${col} = $1 WHERE ${col} = $2 AND account_phone = $3`, [goodId, badId, accPhone]);
            console.log(`Updated in ${table}: ${badId} -> ${goodId}`);
          }
        } catch (e) {
          console.error(`Error processing ${badId} in ${table}:`, e.message);
        }
      }
    }

    // Fix wa_messages chat_id and sender similarly
    // Since messages have chat_id, we just update it where we can
    await pool.query(`
      UPDATE wa_messages 
      SET chat_id = replace(replace(chat_id, '@s.whatsapp.net@s.whatsapp.net', '@s.whatsapp.net'), '@g.us@g.us', '@g.us')
      WHERE chat_id LIKE '%@s.whatsapp.net@s.whatsapp.net' OR chat_id LIKE '%@g.us@g.us';
    `);
    console.log('Updated wa_messages chat_id');

    await pool.query(`
      UPDATE wa_messages 
      SET sender = replace(replace(sender, '@s.whatsapp.net@s.whatsapp.net', '@s.whatsapp.net'), '@g.us@g.us', '@g.us')
      WHERE sender LIKE '%@s.whatsapp.net@s.whatsapp.net' OR sender LIKE '%@g.us@g.us';
    `);
    console.log('Updated wa_messages sender');

    console.log('[Cleanup] Double-suffix cleanup complete.');
    process.exit(0);
  } catch (err) {
    console.error('Error during cleanup:', err);
    process.exit(1);
  }
}

cleanupDuplicates();

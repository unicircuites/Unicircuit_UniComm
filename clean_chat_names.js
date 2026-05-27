const pool = require('./backend/db/pool');

async function fixNames() {
  console.log('[Cleanup] Fixing overwritten chat names...');
  try {
    // Some chats were overwritten with the user's own push name (e.g. 'Chinmay')
    // We can fix this by updating wa_chats.name with the name from wa_contacts if available,
    // or the phone number format.
    
    // 1. Get all chats that are not groups
    const chats = await pool.query(`SELECT id, account_phone FROM wa_chats WHERE is_group = false`);
    
    for (const chat of chats.rows) {
      const jid = chat.id;
      const acc = chat.account_phone;
      const phone = jid.split('@')[0].split(':')[0];
      
      // Try to get contact name from wa_contacts
      const contact = await pool.query(
        `SELECT name FROM wa_contacts WHERE (jid = $1 OR jid = $2 OR jid = $3) AND account_phone = $4 AND name IS NOT NULL AND name != '' LIMIT 1`, 
        [jid, phone + '@s.whatsapp.net', phone + '@lid', acc]
      );
      
      let newName = '';
      if (contact.rows.length > 0 && contact.rows[0].name) {
        newName = contact.rows[0].name;
      } else {
        // Fallback to formatted phone number
        if (phone.startsWith('91') && phone.length === 12) {
          newName = '+91 ' + phone.slice(2, 7) + ' ' + phone.slice(7);
        } else {
          newName = '+' + phone;
        }
      }
      
      if (newName) {
        await pool.query(`UPDATE wa_chats SET name = $1 WHERE id = $2 AND account_phone = $3`, [newName, jid, acc]);
      }
    }
    
    console.log('[Cleanup] Chat names restored from contacts or phone numbers.');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

fixNames();

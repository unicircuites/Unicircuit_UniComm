const pool = require('../db/pool');

async function testSenderPhone() {
  try {
    // Get a group chat JID
    const groupResult = await pool.query(`
      SELECT id FROM wa_chats 
      WHERE is_group = true 
      LIMIT 1
    `);
    
    if (groupResult.rows.length === 0) {
      console.log('No group chats found');
      process.exit();
      return;
    }
    
    const jid = groupResult.rows[0].id;
    console.log('Testing with group chat:', jid);
    
    const lidNum = jid.endsWith('@lid') ? jid.split('@')[0] : null;
    const limit = 10;
    
    const result = await pool.query(
      `SELECT m.id, m.sender, m.sender_name, m.body,
        CASE
          WHEN m.sender LIKE '%@lid' AND c.phone IS NOT NULL AND c.phone ~ '^[0-9]{7,}$'
            THEN CASE
              WHEN c.phone LIKE '91%' AND length(c.phone) = 12
              THEN '+91 ' || substring(c.phone, 3, 5) || ' ' || substring(c.phone, 8, 5)
              ELSE '+' || c.phone
            END
          WHEN m.sender NOT LIKE '%@lid' AND m.sender NOT LIKE '%@g.us' AND m.sender IS NOT NULL
            THEN CASE
              WHEN split_part(m.sender,'@',1) LIKE '91%' AND length(split_part(m.sender,'@',1)) = 12
              THEN '+91 ' || substring(split_part(m.sender,'@',1), 3, 5) || ' ' || substring(split_part(m.sender,'@',1), 8, 5)
              ELSE '+' || split_part(m.sender,'@',1)
            END
          ELSE NULL
        END AS sender_phone,
        c.phone as raw_phone
       FROM (
         SELECT * FROM wa_messages 
         WHERE chat_id=$1
            OR chat_id LIKE split_part($1, '@', 1) || ':%@' || split_part($1, '@', 2)
            OR ($3::text IS NOT NULL AND (
              chat_id = $3 || '@s.whatsapp.net'
              OR chat_id LIKE $3 || ':%@s.whatsapp.net'
            ))
         ORDER BY timestamp DESC LIMIT $2
       ) m
       LEFT JOIN wa_contacts c ON c.jid = m.sender
       ORDER BY m.timestamp ASC`,
      [jid, limit, lidNum]
    );
    
    console.log('\nMessages with sender_phone:');
    result.rows.forEach(row => {
      console.log({
        sender: row.sender,
        sender_name: row.sender_name,
        raw_phone: row.raw_phone,
        sender_phone: row.sender_phone,
        body: row.body?.substring(0, 30)
      });
    });
    
    const withPhone = result.rows.filter(r => r.sender_phone).length;
    const withoutPhone = result.rows.filter(r => !r.sender_phone && !r.from_me).length;
    
    console.log(`\n✅ Messages with phone: ${withPhone}`);
    console.log(`❌ Messages without phone: ${withoutPhone}`);
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    process.exit();
  }
}

testSenderPhone();

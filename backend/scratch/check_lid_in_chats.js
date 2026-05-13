const pool = require('../db/pool');

async function check() {
  try {
    // Check if the LID senders from messages exist in wa_chats
    const senders = [
      '272893648851001', '216745742725141', '98556631322839',
      '49804474351790', '138968129659098', '27763205484709',
      '229737968455913', '199454623838458', '6545664377022', '232989275496680'
    ];
    
    console.log('=== Checking LID senders in wa_chats ===');
    for (const lid of senders) {
      const r = await pool.query(
        `SELECT id, name, phone FROM wa_chats WHERE id = $1`,
        [lid + '@lid']
      );
      if (r.rows.length > 0) {
        console.log(`✅ ${lid}@lid → name: "${r.rows[0].name}", phone: "${r.rows[0].phone}"`);
      } else {
        console.log(`❌ ${lid}@lid → NOT in wa_chats`);
      }
    }
    
    console.log('\n=== Checking LID senders in wa_contacts ===');
    for (const lid of senders) {
      const r = await pool.query(
        `SELECT jid, name, phone FROM wa_contacts WHERE jid = $1`,
        [lid + '@lid']
      );
      if (r.rows.length > 0) {
        console.log(`✅ ${lid}@lid → name: "${r.rows[0].name}", phone: "${r.rows[0].phone}"`);
      } else {
        console.log(`❌ ${lid}@lid → NOT in wa_contacts`);
      }
    }
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    process.exit();
  }
}

check();

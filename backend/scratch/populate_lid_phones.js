const pool = require('../db/pool');
const wa = require('../services/whatsapp');

async function populateLidPhoneNumbers() {
  try {
    // Wait for WhatsApp to connect
    let attempts = 0;
    while (!wa.getStatus().connected && attempts < 30) {
      console.log('Waiting for WhatsApp connection...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }
    
    if (!wa.getStatus().connected) {
      console.log('WhatsApp not connected after 30 seconds');
      process.exit(1);
      return;
    }
    
    // Get all group chats
    const groups = await pool.query(`SELECT id FROM wa_chats WHERE is_group = true`);
    console.log(`Populating LID phone numbers from ${groups.rows.length} groups...`);
    
    let updated = 0;
    for (const group of groups.rows) {
      try {
        const meta = await wa.getGroupMetadata(group.id);
        
        // Update phone numbers for all @lid participants
        for (const p of meta.participants) {
          if (p.jid.endsWith('@lid') && p.phone) {
            const realPhone = p.phone.replace(/[^0-9]/g, '');
            
            // Update wa_contacts with real phone number
            await pool.query(`
              INSERT INTO wa_contacts (jid, phone)
              VALUES ($1, $2)
              ON CONFLICT (jid) DO UPDATE SET
                phone = EXCLUDED.phone,
                updated_at = NOW()
            `, [p.jid, realPhone]);
            
            console.log(`Updated ${p.jid} -> ${realPhone}`);
            updated++;
          }
        }
      } catch (err) {
        // Skip groups that fail (might be removed or no permission)
        console.warn(`Failed to get metadata for ${group.id}:`, err.message);
      }
    }
    
    console.log(`✅ Updated ${updated} LID phone numbers from group metadata`);
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    process.exit();
  }
}

populateLidPhoneNumbers();

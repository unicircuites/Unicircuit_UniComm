const pool = require('../db/pool');

async function diagnose() {
  console.log('=== WA PROFILE PICTURE & LID RESOLUTION DIAGNOSTIC ===\n');
  try {
    // 1. Audit overall LID counts
    const auditRes = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE jid LIKE '%@lid')::int AS total_lids,
        COUNT(*) FILTER (WHERE jid LIKE '%@lid' AND phone IS NOT NULL AND phone != '')::int AS resolved_lids,
        COUNT(*) FILTER (WHERE jid LIKE '%@lid' AND (phone IS NULL OR phone = ''))::int AS unresolved_lids
      FROM wa_contacts
    `);
    
    const { total_lids, resolved_lids, unresolved_lids } = auditRes.rows[0] || {};
    const percent = total_lids > 0 ? ((resolved_lids / total_lids) * 100).toFixed(1) : '0.0';
    console.log(`[LID STATS]`);
    console.log(`- Total LID contacts in wa_contacts: ${total_lids}`);
    console.log(`- Resolved to phone: ${resolved_lids} (${percent}%)`);
    console.log(`- Unresolved (pending): ${unresolved_lids}\n`);

    // 2. Query target LID "153390831108330@lid"
    const targetLid = '153390831108330@lid';
    console.log(`[TARGET CONTACT AUDIT] Querying for: ${targetLid}`);
    
    const contactRes = await pool.query(
      `SELECT jid, name, notify, phone, updated_at FROM wa_contacts WHERE jid = $1`,
      [targetLid]
    );

    if (contactRes.rows.length === 0) {
      console.log(`❌ Contact with JID ${targetLid} does NOT exist in wa_contacts table!`);
    } else {
      const row = contactRes.rows[0];
      console.log(`✅ Contact Found in wa_contacts:`);
      console.log(`  - JID:        ${row.jid}`);
      console.log(`  - Name:       ${row.name || '(null)'}`);
      console.log(`  - Notify (WA): ${row.notify || '(null)'}`);
      console.log(`  - Phone (DB): ${row.phone || '(null)'} ${row.phone ? '👈 RESOLVED!' : '❌ NOT RESOLVED YET'}`);
      console.log(`  - Updated At: ${row.updated_at}`);
    }

    // 3. Query chats table for the target
    const chatRes = await pool.query(
      `SELECT id, name, phone, profile_pic_url FROM wa_chats WHERE id = $1`,
      [targetLid]
    );

    if (chatRes.rows.length === 0) {
      console.log(`\n❌ Chat with ID ${targetLid} does NOT exist in wa_chats table!`);
    } else {
      const row = chatRes.rows[0];
      console.log(`\n✅ Chat Found in wa_chats:`);
      console.log(`  - ID:              ${row.id}`);
      console.log(`  - Name:            ${row.name || '(null)'}`);
      console.log(`  - Phone (DB):      ${row.phone || '(null)'}`);
      console.log(`  - Profile Pic URL: ${row.profile_pic_url || '(null)'} ${row.profile_pic_url ? '👈 SET!' : '❌ NOT SET'}`);
    }

    // 4. Fallback trace: CRM Match check
    console.log(`\n[CRM FALLBACK SIMULATION]`);
    let chatName = chatRes.rows[0]?.name || contactRes.rows[0]?.name || contactRes.rows[0]?.notify;
    if (chatName) {
      const cleanedName = String(chatName).trim();
      console.log(`  - Chat/Contact name is: "${cleanedName}"`);
      const crmRes = await pool.query(
        `SELECT id, fname, lname, phone, wa FROM contacts 
         WHERE (TRIM(COALESCE(fname, '')) || ' ' || TRIM(COALESCE(lname, ''))) ILIKE $1
            OR fname ILIKE $1
            OR lname ILIKE $1
         LIMIT 3`,
        [cleanedName]
      );
      if (crmRes.rows.length > 0) {
        console.log(`  - Found matching CRM contact(s):`);
        crmRes.rows.forEach(crm => {
          console.log(`    * [ID: ${crm.id}] ${crm.fname || ''} ${crm.lname || ''} | Phone: ${crm.phone || '(null)'} | WA: ${crm.wa || '(null)'}`);
        });
      } else {
        console.log(`  - ❌ No matching CRM contact found for name "${cleanedName}" in contacts table.`);
      }
    } else {
      console.log(`  - ❌ No name found on the contact/chat to perform CRM matching.`);
    }

  } catch (err) {
    console.error('❌ Diagnostic Error:', err.stack);
  } finally {
    await pool.end();
    console.log('\nDiagnostic finished.');
  }
}

diagnose();

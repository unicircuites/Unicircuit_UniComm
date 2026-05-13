const pool = require('../db/pool');

async function checkCoverage() {
  try {
    // Check LID contacts in wa_contacts
    const contactsResult = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(phone) FILTER (WHERE phone IS NOT NULL AND phone != '') as with_phone,
        COUNT(*) FILTER (WHERE phone IS NULL OR phone = '') as without_phone
      FROM wa_contacts 
      WHERE jid LIKE '%@lid'
    `);
    
    console.log('LID Contacts in wa_contacts:');
    console.log(contactsResult.rows[0]);
    
    // Check unique LID senders in messages
    const sendersResult = await pool.query(`
      SELECT 
        COUNT(DISTINCT sender) as unique_senders
      FROM wa_messages 
      WHERE sender LIKE '%@lid'
    `);
    
    console.log('\nUnique LID senders in wa_messages:');
    console.log(sendersResult.rows[0]);
    
    // Check how many LID senders have phone numbers
    const coverageResult = await pool.query(`
      SELECT 
        COUNT(DISTINCT m.sender) as total_senders,
        COUNT(DISTINCT m.sender) FILTER (WHERE c.phone IS NOT NULL AND c.phone != '') as senders_with_phone
      FROM wa_messages m
      LEFT JOIN wa_contacts c ON c.jid = m.sender
      WHERE m.sender LIKE '%@lid'
    `);
    
    console.log('\nLID Senders Coverage:');
    console.log(coverageResult.rows[0]);
    const coverage = coverageResult.rows[0];
    const percentage = (coverage.senders_with_phone / coverage.total_senders * 100).toFixed(1);
    console.log(`Coverage: ${coverage.senders_with_phone}/${coverage.total_senders} (${percentage}%)`);
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    process.exit();
  }
}

checkCoverage();

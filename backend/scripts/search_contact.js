const pool = require('../db/pool');

async function search() {
  try {
    const res = await pool.query(
      `SELECT fname, lname, phone, wa FROM contacts 
       WHERE fname ILIKE '%Vijay%' 
          OR lname ILIKE '%Vijay%' 
          OR fname ILIKE '%Khatakte%' 
          OR lname ILIKE '%Khatakte%'`
    );
    console.log('\n=== CRM Contacts Matching "Vijay" or "Khatakte" ===');
    console.log(res.rows);
  } catch (err) {
    console.error('Error querying CRM contacts:', err.message);
  } finally {
    await pool.end();
  }
}

search();

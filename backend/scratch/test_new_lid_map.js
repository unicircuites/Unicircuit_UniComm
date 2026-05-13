const pool = require('../db/pool');
async function test() {
  const result = await pool.query(`
    SELECT lid_num, name, phone FROM (
      SELECT split_part(id, '@', 1) AS lid_num, name, phone
      FROM wa_chats WHERE id LIKE '%@lid' AND phone IS NOT NULL AND phone != ''
      UNION
      SELECT split_part(jid, '@', 1) AS lid_num, name, phone
      FROM wa_contacts WHERE jid LIKE '%@lid' AND phone IS NOT NULL AND phone != '' AND phone ~ '^[0-9]'
    ) combined
  `);
  console.log('Total LID entries in merged map:', result.rows.length);

  // Check the Attendance Group members from screenshot
  const testLids = ['117841068052621', '11910061813919', '195073622982815'];
  for (const lid of testLids) {
    const found = result.rows.find(r => r.lid_num === lid);
    console.log(lid, '→', found ? `${found.name} / ${found.phone}` : 'NOT FOUND');
  }
  process.exit();
}
test().catch(e => { console.error(e.message); process.exit(1); });

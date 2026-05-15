const pool = require('./db/pool');

async function check() {
  try {
    const res = await pool.query(`
      SELECT id, TO_CHAR(call_date, 'YYYY-MM-DD') as d, call_time
      FROM call_logs 
      ORDER BY call_date DESC NULLS LAST, call_time DESC NULLS LAST, created_at DESC
    `);
    const all = res.rows;
    console.log(`Total DB rows: ${all.length}`);
    const may10 = all.filter(r => r.d === '2026-05-10');
    console.log(`May 10 records:`, may10);
    
    // Find where the May 10 record is in the list
    if (may10.length > 0) {
      const idx = all.findIndex(r => r.id === may10[0].id);
      console.log(`The May 10 record is at index ${idx} out of ${all.length}`);
      console.log(`Which would be on page ${Math.floor(idx / 25) + 1} (if 25 per page)`);
    } else {
      console.log("May 10 record not found in the unfiltered query!");
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
check();

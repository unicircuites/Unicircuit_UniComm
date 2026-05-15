const pool = require('./db/pool');

async function run() {
  try {
    const res = await pool.query(`
      SELECT call_date, COUNT(*) 
      FROM call_logs 
      GROUP BY call_date 
      ORDER BY call_date DESC NULLS LAST
    `);
    console.log("Distribution of call_date:");
    console.table(res.rows);

    const res2 = await pool.query(`
      SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as created_day, COUNT(*) 
      FROM call_logs 
      WHERE call_date IS NULL
      GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD')
      ORDER BY created_day DESC
    `);
    console.log("\nNULL call_dates by created_at:");
    console.table(res2.rows);

  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
run();

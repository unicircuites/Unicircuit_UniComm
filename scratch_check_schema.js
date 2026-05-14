const pool = require('./backend/db/pool');

async function checkSchema() {
  try {
    const res = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'contacts'
    `);
    console.log('Columns in contacts table:');
    res.rows.forEach(row => console.log(`${row.column_name}: ${row.data_type}`));
    
    const sample = await pool.query('SELECT * FROM contacts LIMIT 1');
    console.log('\nSample row:', sample.rows[0]);
    
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkSchema();

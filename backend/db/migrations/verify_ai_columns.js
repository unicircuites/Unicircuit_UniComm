const pool = require('../pool');

async function verify() {
  try {
    const result = await pool.query(`
      SELECT column_name, data_type, character_maximum_length 
      FROM information_schema.columns 
      WHERE table_name = 'outlook_emails_cache' 
      AND column_name LIKE 'ai_%' 
      ORDER BY column_name
    `);
    
    console.log('AI Assistant Columns in outlook_emails_cache:');
    result.rows.forEach(col => {
      const type = col.character_maximum_length 
        ? `${col.data_type}(${col.character_maximum_length})`
        : col.data_type;
      console.log(`  ✓ ${col.column_name} (${type})`);
    });
    
    console.log(`\nTotal AI columns: ${result.rows.length}/5`);
    process.exit(0);
  } catch (error) {
    console.error('Verification failed:', error.message);
    process.exit(1);
  }
}

verify();

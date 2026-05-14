const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`
});

async function updateSchema() {
  try {
    console.log('Checking database schema...');
    await pool.query(`
      ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS recording_file TEXT;
    `);
    console.log('✅ Column "recording_file" ensured in call_logs table.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Schema update failed:', err.message);
    process.exit(1);
  }
}

updateSchema();

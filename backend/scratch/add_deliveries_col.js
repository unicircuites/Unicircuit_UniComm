require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');
const p = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});
p.query("ALTER TABLE email_broadcasts ADD COLUMN IF NOT EXISTS deliveries JSONB DEFAULT '[]'")
  .then(() => { console.log('✅ deliveries column added!'); p.end(); })
  .catch(e => { console.error('❌', e.message); p.end(); });

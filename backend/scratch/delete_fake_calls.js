/**
 * Delete fake/simulator call records from DB
 * Run: node backend/scratch/delete_fake_calls.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');
const p = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

async function run() {
  // Delete records where destination contains fake names like 'ABB India', 'Schneider Electric'
  // AND caller is generic extension numbers with fake phone patterns
  // Simulator used: 9187654XXXXX, 9198765XXXXX patterns and names like BHEL Procurement, ABB India, Schneider Electric
  const result = await p.query(`
    DELETE FROM call_logs
    WHERE created_at::date = '2026-05-05'
    AND (
      destination IN ('ABB India', 'Schneider Electric', 'BHEL Procurement', 'Adani Power', 'L&T ECC', 'Siemens India')
      OR caller IN ('ABB India', 'Schneider Electric', 'BHEL Procurement', 'Adani Power', 'L&T ECC', 'Siemens India')
      OR destination LIKE '9187654%'
      OR destination LIKE '9198765%'
      OR caller LIKE '9187654%'
      OR caller LIKE '9198765%'
    )
    RETURNING id
  `);
  console.log('Deleted', result.rowCount, 'fake records');
  await p.end();
}

run().catch(console.error);

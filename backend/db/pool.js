/**
 * PostgreSQL connection pool
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');

console.log('[DB-Pool-Init] Initializing pool with:', {
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || '5432',
  database: process.env.DB_NAME     || 'unicomm_db',
  user:     process.env.DB_USER     || 'postgres',
  hasPassword: !!process.env.DB_PASSWORD
});

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'unicomm_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 50, // Increased to prevent pool exhaustion during startup
  idleTimeoutMillis: 60000, // 60s
  connectionTimeoutMillis: 30000, // 30s
  options: '-c client_encoding=UTF8',
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

module.exports = pool;

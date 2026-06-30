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
  max: 30, // Keep enough concurrency without letting hung requests pile up
  idleTimeoutMillis: 30000, // 30s
  connectionTimeoutMillis: 6000, // Fail fast instead of buffering UI requests
  query_timeout: 10000, // Client-side guard for long-running queries
  options: '-c client_encoding=UTF8 -c statement_timeout=10000',
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

module.exports = pool;

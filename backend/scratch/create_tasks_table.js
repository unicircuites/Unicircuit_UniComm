const pool = require('../db/pool');

async function createTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_tasks (
        id          SERIAL PRIMARY KEY,
        status      VARCHAR(20) NOT NULL DEFAULT 'pending',
        type        VARCHAR(50) NOT NULL,
        payload     JSONB NOT NULL,
        result      JSONB,
        error       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ai_tasks_status ON ai_tasks (status);
    `);
    console.log('✅ ai_tasks table ensured.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to create table:', err.message);
    process.exit(1);
  }
}

createTable();

const pool = require('./backend/db/pool');

async function setup() {
  try {
    await pool.query(`
      CREATE OR REPLACE FUNCTION phone_norm(p text) RETURNS text AS $$
        SELECT NULLIF(RIGHT(regexp_replace(COALESCE(p, ''), '[^0-9]', '', 'g'), 10), '');
      $$ LANGUAGE sql IMMUTABLE;
    `);
    console.log('Created phone_norm function');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id            SERIAL PRIMARY KEY,
        lead_name     VARCHAR(200) NOT NULL,
        subject       VARCHAR(300),
        notes         TEXT,
        platform      VARCHAR(50) DEFAULT 'pbx',
        lead_date     DATE,
        lead_time     TIME,
        contact_phone VARCHAR(50),
        contact_tags  TEXT[],
        created_by    INTEGER,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Created leads table');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    process.exit(0);
  }
}

setup();

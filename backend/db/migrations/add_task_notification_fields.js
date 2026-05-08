/**
 * Migration: add notification + triage fields to mail_reply_tasks
 * Safe to run multiple times (uses ADD COLUMN IF NOT EXISTS)
 * Run: node backend/db/migrations/add_task_notification_fields.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pool = require('../pool');

async function migrate() {
  const cols = [
    `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS assigned_to_name      TEXT`,
    `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS assigned_to_email     VARCHAR(200)`,
    `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS assigned_to_phone     VARCHAR(30)`,
    `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS notify_channel        VARCHAR(10)  DEFAULT 'wa'`,
    `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS notify_before_minutes INTEGER      DEFAULT 60`,
    `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS triage_tag            VARCHAR(10)  DEFAULT 'none'`,
    `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS replied_at            TIMESTAMPTZ`,
    `ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS notified_at           TIMESTAMPTZ`,
  ];

  for (const sql of cols) {
    await pool.query(sql);
    console.log('OK:', sql.replace('ALTER TABLE mail_reply_tasks ADD COLUMN IF NOT EXISTS ', '').split(' ')[0]);
  }

  // Back-fill defaults for existing rows
  await pool.query(`UPDATE mail_reply_tasks SET notify_channel = 'wa'   WHERE notify_channel IS NULL`);
  await pool.query(`UPDATE mail_reply_tasks SET notify_before_minutes = 60 WHERE notify_before_minutes IS NULL`);
  await pool.query(`UPDATE mail_reply_tasks SET triage_tag = 'none'     WHERE triage_tag IS NULL`);

  console.log('Migration complete.');
  await pool.end();
}

migrate().catch(err => { console.error('Migration failed:', err.message); process.exit(1); });

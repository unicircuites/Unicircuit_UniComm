/**
 * Database Migration: Add AI Email Intelligence Assistant Columns
 * 
 * This migration adds 5 new columns to the outlook_emails_cache table
 * to support AI-powered email analysis and cleanup recommendations.
 * 
 * New columns:
 * - ai_analyzed_at: Timestamp of last AI analysis
 * - ai_cleanup_recommended: Flag for deletion recommendation
 * - ai_priority_score: Calculated priority (0-100)
 * - ai_detected_intent: Detected intent category
 * - ai_detected_sentiment: Detected sentiment
 */

const pool = require('../pool');

async function migrate() {
  console.log('[Migration] Adding AI assistant columns to outlook_emails_cache...');
  
  try {
    // Add new columns
    await pool.query(`
      ALTER TABLE outlook_emails_cache
      ADD COLUMN IF NOT EXISTS ai_analyzed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS ai_cleanup_recommended BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS ai_priority_score SMALLINT CHECK (ai_priority_score >= 0 AND ai_priority_score <= 100),
      ADD COLUMN IF NOT EXISTS ai_detected_intent VARCHAR(50),
      ADD COLUMN IF NOT EXISTS ai_detected_sentiment VARCHAR(30)
    `);
    console.log('[Migration] ✓ Columns added successfully');
    
    // Create index on ai_analyzed_at for efficient query performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_outlook_emails_ai_analyzed 
      ON outlook_emails_cache (ai_analyzed_at)
    `);
    console.log('[Migration] ✓ Index on ai_analyzed_at created');
    
    // Create index on received_datetime DESC for time-based filtering
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_outlook_emails_received 
      ON outlook_emails_cache (received_datetime DESC)
    `);
    console.log('[Migration] ✓ Index on received_datetime created');
    
    // Create partial index on ai_cleanup_recommended for cleanup queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_outlook_emails_cleanup 
      ON outlook_emails_cache (ai_cleanup_recommended) 
      WHERE ai_cleanup_recommended = TRUE
    `);
    console.log('[Migration] ✓ Partial index on ai_cleanup_recommended created');
    
    console.log('[Migration] ✅ AI assistant columns migration completed successfully');
    
  } catch (error) {
    console.error('[Migration] ❌ Migration failed:', error.message);
    throw error;
  }
}

// Run migration if executed directly
if (require.main === module) {
  migrate()
    .then(() => {
      console.log('[Migration] Exiting...');
      process.exit(0);
    })
    .catch((error) => {
      console.error('[Migration] Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { migrate };

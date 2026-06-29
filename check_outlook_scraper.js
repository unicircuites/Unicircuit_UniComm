const path = require('path');
require(path.join(__dirname, 'backend', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, 'backend', '.env') });
const pool = require('./backend/db/pool');
const scraper = require('./outlook_lead_scrape/module/outlookLeadScrapeService');

async function check() {
  try {
    console.log('\n--- OUTLOOK SCRAPER DIAGNOSTICS ---\n');

    // 1. Check emails cache
    const { rows: cacheRows } = await pool.query(`SELECT COUNT(*) as cnt FROM outlook_emails_cache`);
    console.log(`[Cache] Total emails in outlook_emails_cache: ${cacheRows[0].cnt}`);

    // 2. Check processed table
    const { rows: procRows } = await pool.query(`SELECT COUNT(*) as cnt FROM outlook_lead_processed`);
    console.log(`[Processed] Total emails already processed: ${procRows[0].cnt}`);

    // 3. Manually run the scraper once
    console.log('\n[Scraper] Manually triggering runOnce()...');
    const summary = await scraper.runOnce({ trigger: 'manual_diagnostic', lookbackHours: 72 });
    
    console.log('\n[Scraper Result]:');
    console.log(JSON.stringify(summary, null, 2));

  } catch (err) {
    console.error('Diagnostic error:', err);
  } finally {
    process.exit(0);
  }
}

check();

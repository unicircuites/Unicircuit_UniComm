'use strict';

/**
 * ensureTables.js — Creates the idempotency table for Outlook Lead Scrape on first run.
 */

const POOL_PATHS = [
  '../../backend/db/pool',
  '../../../backend/db/pool',
  '../backend/db/pool',
];

function getPool() {
  for (const p of POOL_PATHS) {
    try {
      const mod = require(p); // eslint-disable-line global-require
      return mod.pool || mod.default || mod;
    } catch (e) { /* try next */ }
  }
  return null;
}

/**
 * CREATE TABLE IF NOT EXISTS outlook_lead_processed.
 * Safe to call on every runOnce().
 */
async function ensureOutlookLeadProcessedTable() {
  const pool = getPool();
  if (!pool) {
    console.error('[OutlookLeadScrape] ensureTables: pool unavailable');
    return false;
  }
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS outlook_lead_processed (
        message_id    TEXT PRIMARY KEY,
        lead_id       INTEGER REFERENCES leads(id) ON DELETE SET NULL,
        confidence    NUMERIC(4,3),
        status        VARCHAR(20) NOT NULL,
        reason        TEXT,
        processed_at  TIMESTAMPTZ DEFAULT NOW()
      );`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_outlook_lead_processed_at
       ON outlook_lead_processed (processed_at DESC)`
    );
    return true;
  } catch (e) {
    console.error('[OutlookLeadScrape] ensureOutlookLeadProcessedTable failed:', e.message);
    return false;
  }
}

module.exports = { ensureOutlookLeadProcessedTable, getPool };
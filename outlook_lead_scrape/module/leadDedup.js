'use strict';

/**
 * leadDedup.js — Idempotency + duplicate detection helpers for Outlook Lead Scrape.
 *
 * Exports:
 *   isAlreadyProcessed(messageId)                 → async → boolean
 *   findDuplicateLead(phone, subject, fromAddress) → async → lead row | null
 *   recordProcessed(messageId, status, leadId, confidence, reason)
 *   _setPool(poolInstance)                          → inject mock pool for tests
 */

const POOL_PATHS = [
  '../../backend/db/pool',
  '../../../backend/db/pool',
  '../backend/db/pool',
];

let _mockPool = null;

function _setPool(p) {
  _mockPool = p;
}

function getPool() {
  if (_mockPool) return _mockPool;
  for (const p of POOL_PATHS) {
    try {
      const mod = require(p); // eslint-disable-line global-require
      return mod.pool || mod.default || mod;
    } catch (e) { /* try next */ }
  }
  return null;
}

/**
 * Has this Graph message_id already been processed (inserted / rejected / duplicate)?
 */
async function isAlreadyProcessed(messageId) {
  const pool = getPool();
  if (!pool) return false;
  try {
    const r = await pool.query(
      'SELECT 1 FROM outlook_lead_processed WHERE message_id = $1',
      [messageId]
    );
    return !!(r.rows && r.rows.length);
  } catch (e) {
    console.error('[OutlookLeadScrape] isAlreadyProcessed failed:', e.message);
    return false;
  }
}

/**
 * Find an existing outlook lead that duplicates this one.
 * Rules:
 *   1. Same normalized phone within 14 days (same buyer, likely repeat).
 *   2. Exact same subject within 7 days.
 * Uses the DB-side phone_norm() function (assumed to exist in the UniComm Pro DB).
 */
async function findDuplicateLead(phone, subject, fromAddress) {
  const pool = getPool();
  if (!pool) return null;

  try {
    if (phone) {
      const r = await pool.query(
        `SELECT * FROM leads
         WHERE platform = 'outlook'
           AND contact_phone IS NOT NULL
           AND phone_norm(contact_phone) = phone_norm($1)
           AND lead_date >= NOW() - INTERVAL '14 days'
         ORDER BY id DESC LIMIT 1`,
        [phone]
      );
      if (r.rows && r.rows.length) return r.rows[0];
    }

    if (subject) {
      const r = await pool.query(
        `SELECT * FROM leads
         WHERE platform = 'outlook'
           AND subject = $1
           AND lead_date >= NOW() - INTERVAL '7 days'
         ORDER BY id DESC LIMIT 1`,
        [subject.slice(0, 300)]
      );
      if (r.rows && r.rows.length) return r.rows[0];
    }

    // Optional: match by sender address embedded in notes (from_address is not a
    // dedicated leads column, but notes often contains it for traceability).
    if (fromAddress) {
      const r = await pool.query(
        `SELECT * FROM leads
         WHERE platform = 'outlook'
           AND notes ILIKE $1
           AND lead_date >= NOW() - INTERVAL '7 days'
         ORDER BY id DESC LIMIT 1`,
        [`%${fromAddress.slice(0, 120)}%`]
      );
      if (r.rows && r.rows.length) return r.rows[0];
    }

    return null;
  } catch (e) {
    console.error('[OutlookLeadScrape] findDuplicateLead failed:', e.message);
    return null;
  }
}

/**
 * Record the outcome of processing a message — inserted / rejected / duplicate / error.
 * Idempotent: ON CONFLICT updates the existing row.
 */
async function recordProcessed(messageId, status, leadId, confidence, reason) {
  const pool = getPool();
  if (!pool) return;
  const conf = confidence == null ? null : Number(Number(confidence).toFixed(3));
  try {
    await pool.query(
      `INSERT INTO outlook_lead_processed (message_id, lead_id, confidence, status, reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_id) DO UPDATE SET
         lead_id      = EXCLUDED.lead_id,
         confidence   = EXCLUDED.confidence,
         status       = EXCLUDED.status,
         reason       = EXCLUDED.reason,
         processed_at = NOW()`,
      [messageId, leadId || null, conf, status, reason || null]
    );
  } catch (e) {
    console.error('[OutlookLeadScrape] recordProcessed failed:', e.message);
  }
}

module.exports = {
  isAlreadyProcessed,
  findDuplicateLead,
  recordProcessed,
  _setPool,
  getPool,
};
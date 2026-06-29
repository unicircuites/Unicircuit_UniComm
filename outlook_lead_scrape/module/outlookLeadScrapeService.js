'use strict';

/**
 * outlookLeadScrapeService.js — Background worker for Outlook Lead Scrape.
 *
 * Exports:
 *   start(io, intervalMinutes) → starts periodic scheduler
 *   stop()                     → clean shutdown
 *   runOnce(options)           → async → summary { scanned, inserted, skipped, duplicates, rejected, errors }
 *
 * Flow per runOnce():
 *   1. ensureOutlookLeadProcessedTable()
 *   2. Query unprocessed mail snapshots from outlook_emails_cache
 *   3. Pre-rank by priority (unread + importance + lead keywords)
 *   4. For each: classify → (fetch full body if needed) → extract → dedup → insert
 *   5. Log + socket emit + return summary
 */

const brain = require('./leadBrain');
const dedup = require('./leadDedup');
const { ensureOutlookLeadProcessedTable } = require('./ensureTables');

let intervalHandle = null;
let isRunning = false;

// ─── Lazy loaders (paths may need adjusting by integrator) ──────────────────

function getPool() {
  const paths = ['../../backend/db/pool', '../../../backend/db/pool', '../backend/db/pool'];
  for (const p of paths) {
    try {
      const mod = require(p); // eslint-disable-line global-require
      return mod.pool || mod.default || mod;
    } catch (e) { /* next */ }
  }
  return null;
}

function getMsGraph() {
  const paths = ['../../backend/services/msGraph', '../../../backend/services/msGraph', '../backend/services/msGraph'];
  for (const p of paths) {
    try {
      const mod = require(p); // eslint-disable-line global-require
      if (mod && typeof mod.graphGet === 'function') return mod;
    } catch (e) { /* next */ }
  }
  return null;
}

function getActivityLog() {
  const paths = ['../../backend/services/activityLog', '../../../backend/services/activityLog', '../backend/services/activityLog'];
  for (const p of paths) {
    try {
      const mod = require(p); // eslint-disable-line global-require
      if (mod && typeof mod.append === 'function') return mod;
    } catch (e) { /* next */ }
  }
  return null;
}

// ─── Config from env ────────────────────────────────────────────────────────

function cfg(overrides) {
  overrides = overrides || {};
  return {
    maxEmails: parseInt(overrides.maxEmails ?? process.env.LEAD_SCRAPE_MAX_EMAILS ?? '50', 10),
    sinceHours: parseInt(overrides.sinceHours ?? process.env.LEAD_SCRAPE_SINCE_HOURS ?? '24', 10),
    minConfidence: parseFloat(overrides.minConfidence ?? process.env.LEAD_SCRAPE_MIN_CONFIDENCE ?? '0.60'),
    intervalMinutes: parseInt(process.env.LEAD_SCRAPE_INTERVAL_MIN || '5', 10),
    useAi: ['1', 'true', 'yes'].includes((process.env.LEAD_SCRAPE_USE_AI || '').toLowerCase()),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fetchFullBody(messageId) {
  const graph = getMsGraph();
  if (!graph) return null;
  const msEmail = process.env.MS_USER_EMAIL;
  if (!msEmail) return null;
  try {
    const data = await graph.graphGet(
      `/me/messages/${encodeURIComponent(messageId)}?$select=body,subject,from,receivedDateTime`,
      msEmail
    );
    return data.body && data.body.content ? data.body.content : '';
  } catch (e) {
    console.error('[OutlookLeadScrape] full body fetch failed for', messageId, ':', e.message);
    return null;
  }
}

function rankSnapshots(rows) {
  const score = (r) => {
    let s = 0;
    if (!r.is_read) s += 3;
    if (r.importance === 'high') s += 2;
    const prev = (r.body_preview || '').toLowerCase();
    if (/enquiry|inquiry|quotation|requirement|biometric|cctv/.test(prev)) s += 2;
    if (/@(indiamart|tradeindia|exportersindia)\.com/.test((r.from_address || '').toLowerCase())) s += 5;
    return s;
  };
  return rows
    .map((r) => ({ r, s: score(r) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.r);
}

const PORTAL_DOMAINS = ['indiamart.com', 'tradeindia.com', 'exportersindia.com'];

// ─── Main pass ──────────────────────────────────────────────────────────────

async function runOnce(options) {
  options = options || {};
  if (isRunning) {
    console.log('[OutlookLeadScrape] runOnce already in progress, skipping');
    return { skipped: true, reason: 'already_running' };
  }
  isRunning = true;

  const summary = {
    trigger: options.trigger || 'manual',
    scanned: 0,
    inserted: 0,
    skipped: 0,
    duplicates: 0,
    rejected: 0,
    errors: 0,
    inserted_ids: [],
  };

  const pool = getPool();
  if (!pool) {
    isRunning = false;
    summary.error = 'pool_unavailable';
    console.error('[OutlookLeadScrape] runOnce aborted: pool unavailable');
    return summary;
  }

  try {
    await ensureOutlookLeadProcessedTable();
    const c = cfg(options);

    const res = await pool.query(
      `SELECT id, conversation_id, subject, from_address, from_name, to_recipients,
              received_datetime, body_preview, has_attachments, importance, folder,
              category, is_read
       FROM outlook_emails_cache
       WHERE folder = 'inbox'
         AND received_datetime >= NOW() - ($1 || ' hours')::interval
         AND id NOT IN (SELECT message_id FROM outlook_lead_processed)
       ORDER BY received_datetime DESC
       LIMIT $2`,
      [String(c.sinceHours), c.maxEmails]
    );

    let snapshots = res.rows || [];
    snapshots = rankSnapshots(snapshots);

    for (const snap of snapshots) {
      summary.scanned++;
      try {
        const verdict = brain.classifyLeadEmail(snap);

        // Hard reject
        if (!verdict.isLead && verdict.confidence === 0) {
          await dedup.recordProcessed(snap.id, 'rejected', null, 0, verdict.reason);
          summary.rejected++;
          continue;
        }

        // Fetch full body always if it's a lead so we can save the raw HTML in notes
        let fullBody = await fetchFullBody(snap.id);
        const previewHasPhone = brain.extractIndianMobile(snap.body_preview || '');

        const result = await brain.extractLeadFields(snap, fullBody);
        const conf = result.confidence || 0;
        const isPortal = PORTAL_DOMAINS.includes((snap.from_address || '').toLowerCase().split('@')[1] || '');

        // Insert threshold: ≥ minConfidence, or Tier-1 portal at ≥ 0.60
        const passes = conf >= c.minConfidence || (isPortal && conf >= 0.6 && verdict.tier === 'tier1');
        if (!result.isLead || !passes || !result.lead) {
          await dedup.recordProcessed(snap.id, 'rejected', null, conf, result.reason || verdict.reason);
          summary.rejected++;
          continue;
        }

        // Dedup
        const dup = await dedup.findDuplicateLead(
          result.lead.contact_phone || null,
          result.lead.subject || '',
          snap.from_address || ''
        );
        if (dup) {
          await dedup.recordProcessed(snap.id, 'duplicate', dup.id, conf, 'Duplicate of lead #' + dup.id);
          summary.duplicates++;
          continue;
        }

        // Insert into leads
        const lead = result.lead;
        const ins = await pool.query(
          `INSERT INTO leads
             (lead_name, subject, notes, platform, lead_date, lead_time, contact_phone, contact_tags, created_by)
           VALUES ($1, $2, $3, 'outlook', $4, $5, $6, $7, NULL)
           RETURNING *`,
          [
            lead.lead_name,
            lead.subject,
            lead.notes,
            lead.lead_date,
            lead.lead_time,
            lead.contact_phone,
            lead.contact_tags,
          ]
        );
        const inserted = ins.rows[0];
        await dedup.recordProcessed(snap.id, 'inserted', inserted.id, conf, verdict.reason);
        summary.inserted++;
        summary.inserted_ids.push(inserted.id);
      } catch (err) {
        console.error('[OutlookLeadScrape] error processing', snap.id, ':', err.message);
        summary.errors++;
        try {
          await dedup.recordProcessed(snap.id, 'error', null, 0, err.message);
        } catch (e) { /* ignore */ }
      }
    }

    // Activity log
    const al = getActivityLog();
    if (al && al.append) {
      try {
        await al.append({
          type: 'info',
          service: 'outlook_lead_scrape',
          message: `Scanned ${summary.scanned}, inserted ${summary.inserted}, rejected ${summary.rejected}, duplicates ${summary.duplicates}`,
        });
      } catch (e) { /* ignore */ }
    }

    // Socket notify
    const io = options.io;
    if (io && io.emit) {
      try {
        io.emit('leads:updated', { inserted: summary.inserted, skipped: summary.skipped });
      } catch (e) { /* ignore */ }
    }

    console.log('[OutlookLeadScrape] runOnce done:', JSON.stringify(summary));
    return summary;
  } catch (err) {
    console.error('[OutlookLeadScrape] runOnce fatal:', err.message);
    summary.error = err.message;
    return summary;
  } finally {
    isRunning = false;
  }
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

function start(io, intervalMinutes) {
  if (intervalHandle) {
    console.log('[OutlookLeadScrape] already started');
    return;
  }
  const mins = intervalMinutes || cfg().intervalMinutes || 5;
  const ms = Math.max(1, mins) * 60 * 1000;
  console.log(`[OutlookLeadScrape] starting scheduler every ${mins} min`);
  // staggered initial run
  setTimeout(() => { runOnce({ trigger: 'startup', io }).catch(() => {}); }, 10 * 1000);
  intervalHandle = setInterval(() => { runOnce({ trigger: 'timer', io }).catch(() => {}); }, ms);
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[OutlookLeadScrape] stopped');
  }
}

module.exports = { start, stop, runOnce };
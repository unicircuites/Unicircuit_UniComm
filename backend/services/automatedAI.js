/**
 * Automated Background AI Analysis Service - Stable Execution Control Layer
 * 
 * Periodically triggers AI email analysis with strict locks, adaptive triggers,
 * batch limits, and retry logic to ensure system stability with heavy models.
 */

const emailAnalyzer = require('./emailAnalyzer');
const activityLog = require('./activityLog');
const activityMonitor = require('./activityMonitor');
const pool = require('../db/pool');

let isRunning = false;
let intervalId = null;
let ioInstance = null;
let lastAnalysisTime = 0;

/**
 * Start the automated AI analysis scheduler with a delayed start
 * @param {Object} io - Socket.IO instance
 * @param {number} intervalMinutes - Interval in minutes (default: 4)
 */
function start(io, intervalMinutes = 4) {
  if (intervalId) {
    console.warn('[Automated AI] Scheduler is already running.');
    return;
  }

  ioInstance = io;
  console.log(`[Automated AI] Scheduler initialized. First run in 60 seconds...`);
  
  // Delayed Start: Wait 60 seconds before first execution
  setTimeout(() => {
    runAnalysis();
    // Set up periodic staggered execution
    intervalId = setInterval(runAnalysis, intervalMinutes * 60 * 1000);
  }, 60000);
}

/**
 * Stop the automated AI analysis scheduler
 */
function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Automated AI] Scheduler stopped.');
  }
}

/**
 * Execute a single AI analysis pass with strict control layer
 */
async function runAnalysis(retryLimit = 15) {
  // 1. AI EXECUTION LOCK
  if (isRunning) {
    console.log('[Automated AI] AI execution skipped (lock active)');
    return;
  }

  isRunning = true;

  try {
    // 2. ADAPTIVE TRIGGER CONDITIONS
    // Fetch recent emails for evaluation (limit 50 to have enough for sorting)
    const recentEmails = await pool.query(`
      SELECT * FROM outlook_emails_cache 
      WHERE received_datetime >= NOW() - INTERVAL '48 hours'
      ORDER BY received_datetime DESC
      LIMIT 50
    `).then(r => r.rows);

    // Filter for unread or important
    const relevantEmails = recentEmails.filter(e => !e.is_read || e.importance === 'high');

    if (relevantEmails.length < 5) {
      console.log('[Automated AI] AI skipped - low activity');
      isRunning = false;
      return;
    }

    // Check if system recently analyzed (prevent rapid re-runs)
    const now = Date.now();
    if (now - lastAnalysisTime < 120000) { // 2 minute minimum gap
      console.log('[Automated AI] AI skipped - analyzed too recently');
      isRunning = false;
      return;
    }

    // 7. PRIORITY-BASED PROCESSING
    // Sort: High Importance > Unread > Recent
    relevantEmails.sort((a, b) => {
      if (a.importance === 'high' && b.importance !== 'high') return -1;
      if (a.importance !== 'high' && b.importance === 'high') return 1;
      if (!a.is_read && b.is_read) return -1;
      if (a.is_read && !b.is_read) return 1;
      return new Date(b.received_datetime) - new Date(a.received_datetime);
    });

    // 3. SAFE BATCH LIMIT
    const batch = relevantEmails.slice(0, retryLimit);
    
    console.log('[Automated AI] AI analysis queued');

    // Queue the analysis task (returns immediately)
    await emailAnalyzer.analyzeEmails({
      emails: batch,
      userId: 1
    });

    lastAnalysisTime = Date.now();

  } catch (error) {
    console.error('[Automated AI] Execution error:', error.message);
    
    // Log to system activity
    try {
      activityLog.append({
        type: 'error',
        service: 'system',
        message: `AI Queue failed: ${error.message}`,
        timestamp: new Date().toISOString()
      });
    } catch (_) {}
  } finally {
    isRunning = false;
  }
}

module.exports = {
  start,
  stop
};

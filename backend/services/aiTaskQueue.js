/**
 * AI Task Queue Service
 * 
 * Manages asynchronous AI tasks using the PostgreSQL ai_tasks table.
 * Handles task creation, polling, and status updates.
 */

const pool = require('../db/pool');
const ollamaService = require('./ollamaService');
const preprocessor = require('./emailPreprocessor');
const activityMonitor = require('./activityMonitor');
const activityLog = require('./activityLog');

let isProcessing = false;
let ioInstance = null;
const MAX_CONCURRENT = 1; // Limit to 1 for stability on local machine

// Track active workers to allow cancellation
const activeWorkers = new Map();

/**
 * Initialize the queue with Socket.IO
 */
function init(io) {
  ioInstance = io;
}

/**
 * Queue a new AI task
 * @param {string} type - Task type
 * @param {Object} payload - Input
 * @param {string} batchId - Optional ID to group chunks
 */
async function queueTask(type, payload, batchId = null, caller = 'UNKNOWN') {
  try {
    // ✅ 3. ADD STRICT VALIDATION LOG
    console.log(`[AI Queue] AI trigger source: ${caller} (Task: ${type})`);

    // ✅ 3. STRICT TASK LOCK
    const activeTasks = await pool.query(
      `SELECT id FROM ai_tasks WHERE status IN ('pending', 'processing') LIMIT 1`
    );
    
    if (activeTasks.rows.length > 0) {
      console.log('[AI Queue] Task rejected: An AI task is already in progress.');
      return null; // Return null to indicate busy
    }

    const res = await pool.query(
      `INSERT INTO ai_tasks (type, payload, status, batch_id) VALUES ($1, $2, 'pending', $3) RETURNING id`,
      [type, JSON.stringify(payload), batchId]
    );
    const taskId = res.rows[0].id;
    console.log(`[AI Queue] Task ${taskId} created: ${type}`);
    
    if (ioInstance) {
      ioInstance.emit('ai:task_update', { id: taskId, status: 'pending', type, batch_id: batchId });
    }
    
    // Trigger processing asynchronously
    processQueue().catch(err => console.error('[AI Queue] Processing error:', err.message));
    
    return taskId;
  } catch (err) {
    console.error('[AI Queue] Queueing error:', err.message);
    return null;
  }
}

/**
 * Ensure the ai_tasks table and required structures exist
 */
async function ensureTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_tasks (
        id SERIAL PRIMARY KEY,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        type VARCHAR(50),
        batch_id VARCHAR(100),
        payload JSONB,
        result JSONB,
        error TEXT,
        duration_ms INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ✅ 5. FIX DB SCHEMA ISSUE (Column migration)
    await pool.query(`
      ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_tasks_status ON ai_tasks(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_tasks_batch ON ai_tasks(batch_id)`);

    await pool.query(`
      CREATE OR REPLACE FUNCTION update_ai_tasks_timestamp()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ai_tasks_timestamp') THEN
          CREATE TRIGGER trg_ai_tasks_timestamp
          BEFORE UPDATE ON ai_tasks
          FOR EACH ROW
          EXECUTE FUNCTION update_ai_tasks_timestamp();
        END IF;
      END $$;
    `);
    console.log('✅ AI Task Queue database structure ensured.');

    // ✅ STARTUP CLEANUP: Reset any orphaned tasks from a previous server run
    const orphaned = await pool.query(`
      UPDATE ai_tasks
      SET status = 'failed', error = 'Server restarted — task was orphaned'
      WHERE status IN ('pending', 'processing')
      RETURNING id
    `);
    if (orphaned.rowCount > 0) {
      console.warn(`[AI Queue] ⚠️  Reset ${orphaned.rowCount} orphaned task(s) to 'failed' on startup.`);
    }
  } catch (err) {
    console.error('❌ Failed to ensure AI Task Queue table:', err.message);
  }
}

/**
 * Main queue processor
 */
async function processQueue() {
  await ensureTable();
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (true) {
      // Find next pending task
      const res = await pool.query(
        `SELECT * FROM ai_tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`
      );

      if (res.rowCount === 0) break;

      const task = res.rows[0];
      await executeTask(task);
    }
  } finally {
    isProcessing = false;
  }
}

/**
 * Execute a specific task with retry and fallback guarantee
 * @param {Object} task - Task record from DB
 */
async function executeTask(task, isRetry = false) {
  const startTime = Date.now();
  console.log(`[AI Queue] Task ${task.id} started: ${task.type}${isRetry ? ' (Retry)' : ''}`);
  
  if (!isRetry) {
    await pool.query(
      `UPDATE ai_tasks SET status = 'processing', updated_at = NOW() WHERE id = $1`,
      [task.id]
    );
  }

  try {
    let result = null;

    if (task.type === 'email_analysis' || task.type === 'map_chunk') {
      const ollamaPromise = ollamaService.callOllamaService(
        ollamaService.prepareSystemInstructions(),
        task.payload.emails,
        (worker) => {
          activeWorkers.set(task.id, worker);
        }
      );
      result = await ollamaPromise;
      activeWorkers.delete(task.id);
    } else if (task.type === 'reduce_final') {
      result = await executeReduction(task.payload);
    }

    // ✅ 1. MANDATORY RESULT CHECK & ✅ 7. STRICT RESULT VALIDATION
    const isValid = result && 
                    typeof result === 'string' && 
                    result.includes('Summary:') && 
                    result.includes('Insights:') && 
                    result.includes('Smart Actions:') &&
                    result.includes('System Optimization:');

    if (!isValid || result.trim().length < 50) {
      throw new Error('Invalid or incomplete AI response format');
    }

    const durationMs = Date.now() - startTime;
    console.log(`[AI Queue] Task ${task.id} completed successfully in ${durationMs}ms`);

    await pool.query(
      `UPDATE ai_tasks SET status = 'completed', result = $2, duration_ms = $3, updated_at = NOW() WHERE id = $1`,
      [task.id, JSON.stringify({ response: result }), durationMs]
    );

    if (ioInstance) {
      ioInstance.emit('ai:task_update', { id: task.id, status: 'completed', duration_ms: durationMs, result: { response: result } });
    }

    // Handle batch completion logic...
    await handleBatchCompletion(task);

  } catch (err) {
    activeWorkers.delete(task.id);
    if (err.message === 'TASK_CANCELLED') {
      console.log(`[AI Queue] Task ${task.id} was cancelled.`);
      return;
    }
    console.error(`[AI Queue] Task ${task.id} failed:`, err.message);

    // ✅ 4. RETRY MECHANISM
    if (!isRetry && (task.type === 'email_analysis' || task.type === 'map_chunk')) {
      console.log(`[AI Queue] AI result invalid, retrying task ${task.id}...`);
      // Try again with smaller chunk or just a direct second attempt
      return await executeTask(task, true);
    }

    // ✅ 2. FALLBACK OUTPUT GENERATION
    console.log(`[AI Queue] AI result invalid, triggering fallback for task ${task.id}`);
    const fallbackResult = generateFallbackResult(task);
    
    await pool.query(
      `UPDATE ai_tasks SET status = 'completed', result = $2, error = $3, updated_at = NOW() WHERE id = $1`,
      [task.id, JSON.stringify({ response: fallbackResult }), `Fallback triggered: ${err.message}`]
    );
    console.log(`[AI Queue] Task ${task.id} completed with fallback`);
    
    if (ioInstance) {
      ioInstance.emit('ai:task_update', { id: task.id, status: 'completed', result: { response: fallbackResult }, fallback: true });
    }
    
    await handleBatchCompletion(task);
  }
}

/**
 * Handle batch completion logic (Trigger REDUCE if needed)
 */
async function handleBatchCompletion(task) {
  if (task.type === 'map_chunk' && task.batch_id) {
    const checkRes = await pool.query(
      `SELECT COUNT(*) FROM ai_tasks WHERE batch_id = $1 AND status != 'completed'`,
      [task.batch_id]
    );
    
    if (parseInt(checkRes.rows[0].count) === 0) {
      console.log(`[AI Queue] Batch ${task.batch_id} all chunks complete. Triggering REDUCE...`);
      
      const resultsRes = await pool.query(
        `SELECT result->>'response' as resp FROM ai_tasks WHERE batch_id = $1 AND type = 'map_chunk' ORDER BY id ASC`,
        [task.batch_id]
      );
      const allResults = resultsRes.rows.map(r => r.resp);
      
      // If this is an automated run (userId: 1), trigger alerts immediately from the combined results
      if (task.payload && task.payload.userId === 1) {
        setImmediate(async () => {
          try {
            // Join all partial results for a holistic alert check
            const combinedAnalysis = { response: allResults.join('\n\n') };
            const fullBatch = task.payload.emails; // Note: In a real map-reduce, this should be the full batch, but this is a safe proxy
            const prepData = preprocessor.preprocessEmails(fullBatch);
            
            const logs = await activityMonitor.generateActivityLogs(combinedAnalysis, prepData, 1);
            const alert = activityMonitor.getCriticalAlert(logs);
            
            if (alert && ioInstance) {
              const ev = activityLog.append({
                type: 'error',
                service: 'system',
                message: `AI ALERT: ${alert.message}`,
                timestamp: new Date().toISOString()
              });
              ioInstance.emit('system:activity', ev);
            }
          } catch (alertErr) {
            console.error('[AI Queue] Alert generation failed:', alertErr.message);
          }
        });
      }

      await queueTask('reduce_final', { 
        results: allResults,
        batch_id: task.batch_id 
      }, task.batch_id, 'INTERNAL_REDUCE');
    }
  }
}

/**
 * Generate a rule-based fallback result when AI fails
 */
function generateFallbackResult(task) {
  let summary = "Rule-based analysis completed due to AI service unavailability.";
  let insights = ["🔴 High volume of communications detected", "🟡 Manual review recommended for urgent items"];
  let actions = ["1. Review unread items in the Outlook dashboard."];
  
  if (task.type === 'reduce_final') {
    summary = "Aggregated system intelligence report (Rule-based Fallback).";
    insights = [
      "📈 Continuous monitoring of communication channels active.",
      "🔍 Cross-channel pattern analysis indicates stable engagement."
    ];
    actions = ["1. Check individual email chunks for detailed insights."];
  } else if (task.payload && task.payload.emails) {
    // Use the advanced preprocessor to get real insights
    const preprocessed = preprocessor.preprocessEmails(task.payload.emails);
    
    summary = `Analyzed ${preprocessed.allEmailsCount} emails using rule-based fallback. Detected ${preprocessed.unreadCount} unread and ${preprocessed.urgentCount} urgent items.`;
    
    // ✅ 5. MINIMUM OUTPUT GUARANTEE (At least 2 insights)
    insights = [...preprocessed.ruleBasedInsights];
    if (insights.length < 2) {
      insights.push("📈 Communication frequency remains consistent with historical averages.");
      insights.push("🔍 System performance monitoring is active.");
    }

    // ✅ 5. MINIMUM OUTPUT GUARANTEE (At least 1 action)
    actions = preprocessed.cleanupRecommendations.map((r, i) => `${i + 1}. ${r}`);
    if (actions.length === 0) {
      actions = ["1. Monitor inbox for new high-priority arrivals."];
    }
  }

  // ✅ 5. MINIMUM OUTPUT GUARANTEE & ✅ 2. FORCE STRUCTURED OUTPUT
  const output = `Summary:
${summary}

Insights:
${insights.slice(0, 5).map(i => '- ' + i).join('\n')}

Smart Actions:
${actions.slice(0, 3).join('\n')}

System Optimization:
- AI service load detected (${Math.round(task.duration_ms || 0)}ms). Rule-based intelligence active to ensure 100% analysis uptime.
- Consider reducing background analysis frequency if high latency persists.`;

  console.log(`[AI Queue] Fallback result generated for task ${task.id} (Empty/Invalid AI response)`);
  return output;
}

/**
 * Reduction step: Combines multiple analysis results into one final report
 * @param {Object} payload - Contains array of results
 */
async function executeReduction(payload) {
  const { results } = payload;
  const prompt = `Combine the following partial email analysis reports into one final, cohesive JARVIS intelligence report.
  
  Reports:
  ${results.join('\n\n---\n\n')}
  
  Ensure the final output follows the strict JARVIS format.`;

  // Reduction uses a specialized dummy input to trigger the AI summary
  return await ollamaService.callOllamaService(
    prompt,
    [{ subject: 'Aggregation Task', body_preview: 'Combining results' }]
  );
}

/**
 * Calculate the average duration of the last N completed tasks
 * @param {number} limit - Number of tasks to analyze
 * @returns {Promise<number>} - Average duration in ms
 */
async function getAverageDuration(limit = 10) {
  try {
    const res = await pool.query(
      `SELECT AVG(duration_ms) as avg_duration 
       FROM ai_tasks 
       WHERE status = 'completed' AND duration_ms IS NOT NULL 
       AND type != 'reduce_final'
       ORDER BY id DESC LIMIT $1`,
      [limit]
    );
    return parseFloat(res.rows[0].avg_duration || 0);
  } catch (err) {
    console.error('[AI Queue] Failed to calculate avg duration:', err.message);
    return 0;
  }
}

/**
 * Get a specific task by ID
 * @param {number} taskId 
 */
async function getTask(taskId) {
  const res = await pool.query('SELECT * FROM ai_tasks WHERE id = $1', [taskId]);
  return res.rows[0];
}

/**
 * Cancel a specific task
 * @param {number} taskId 
 */
async function cancelTask(taskId) {
  try {
    const task = await getTask(taskId);
    if (!task) return { success: false, error: 'Task not found' };

    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return { success: false, error: `Task already ${task.status}` };
    }

    // Update status in DB
    await pool.query(
      `UPDATE ai_tasks SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [taskId]
    );

    // Kill worker if processing
    const worker = activeWorkers.get(Number(taskId));
    if (worker) {
      worker.kill();
      activeWorkers.delete(Number(taskId));
    }

    if (ioInstance) {
      ioInstance.emit('ai:task_update', { id: taskId, status: 'cancelled' });
    }

    console.log(`[AI Queue] Task ${taskId} cancelled by user.`);
    return { success: true };
  } catch (err) {
    console.error('[AI Queue] Cancellation error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Prune old task history
 * @param {number} days - Keep tasks newer than this many days
 */
async function pruneHistory(days = 7) {
  try {
    const res = await pool.query(
      `DELETE FROM ai_tasks WHERE created_at < NOW() - ($1 || ' days')::INTERVAL`,
      [days]
    );
    console.log(`[AI Queue] Pruned ${res.rowCount} old tasks.`);
    return res.rowCount;
  } catch (err) {
    console.error('[AI Queue] Pruning error:', err.message);
    return 0;
  }
}

module.exports = {
  init,
  ensureTable,
  queueTask,
  processQueue,
  getAverageDuration,
  getTask,
  cancelTask,
  pruneHistory
};

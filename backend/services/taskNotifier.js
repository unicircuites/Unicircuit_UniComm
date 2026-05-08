/**
 * Task Notification Scheduler
 * Runs every 30 seconds, sends WhatsApp and/or Outlook email reminders
 * for mail_reply_tasks that are within their notify_before_minutes window.
 *
 * Usage (in server.js):
 *   const taskNotifier = require('./services/taskNotifier');
 *   taskNotifier.start(pool);
 */
const cron       = require('node-cron');
const pool       = require('../db/pool');
const activityLog = require('./activityLog');

// Lazy-require to avoid circular deps at startup
function getWA()    { try { return require('./whatsapp'); }  catch (_) { return null; } }
function getGraph() { try { return require('./msGraph');  }  catch (_) { return null; } }

// ── Pure helpers (exported for testing) ─────────────────────────────────────

/**
 * Returns true if the task should receive a notification right now.
 * @param {object} task  - DB row from mail_reply_tasks
 * @param {Date}   now   - current time (injectable for testing)
 */
function shouldNotify(task, now) {
  if (!task) return false;
  if (task.notified_at) return false;                                   // already sent
  if (!['open', 'in_progress'].includes(String(task.status || ''))) return false;
  if (!task.due_at) return false;
  if (!task.notify_channel || task.notify_channel === 'none') return false;

  const dueMs    = new Date(task.due_at).getTime();
  const nowMs    = (now || new Date()).getTime();
  const windowMs = (parseInt(task.notify_before_minutes, 10) || 60) * 60 * 1000;

  return nowMs >= (dueMs - windowMs) && nowMs < dueMs;
}

/**
 * Convert a phone number to a WhatsApp JID.
 * Handles Indian local format (leading 0 → 91) and bare 10-digit numbers.
 */
function phoneToJid(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  let normalized = digits;
  if (normalized.startsWith('0')) normalized = '91' + normalized.slice(1);
  if (normalized.length === 10) normalized = '91' + normalized;
  return normalized + '@s.whatsapp.net';
}

/**
 * Build the WhatsApp reminder message text.
 */
function buildWaMessage(task) {
  const due = task.due_at
    ? new Date(task.due_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
    : 'N/A';
  const lines = [
    '📋 *Task Reminder*',
    `Subject: ${task.subject || '(no subject)'}`,
    `Due: ${due}`,
    task.sender_name ? `From: ${task.sender_name}` : null,
    task.notes       ? `Notes: ${task.notes}`       : null,
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * Build the Outlook email payload for Graph API sendMail.
 */
function buildEmailPayload(task) {
  const due = task.due_at
    ? new Date(task.due_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
    : 'N/A';
  const toEmail = task.assigned_to_email;
  if (!toEmail) return null;

  const bodyHtml = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;">
      <h3 style="color:#f5a623;">📋 Task Reminder</h3>
      <table style="border-collapse:collapse;">
        <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Subject</td><td>${escHtml(task.subject || '(no subject)')}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Due</td><td>${escHtml(due)}</td></tr>
        ${task.sender_name ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold;">From</td><td>${escHtml(task.sender_name)}</td></tr>` : ''}
        ${task.notes ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Notes</td><td>${escHtml(task.notes)}</td></tr>` : ''}
      </table>
    </div>`;

  return {
    message: {
      subject: `Task Reminder: ${task.subject || '(no subject)'}`,
      body: { contentType: 'HTML', content: bodyHtml },
      toRecipients: [{ emailAddress: { address: toEmail } }],
    },
    saveToSentItems: false,
  };
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Scheduler tick ───────────────────────────────────────────────────────────

async function runTick(db) {
  let tasks;
  try {
    const r = await db.query(`
      SELECT * FROM mail_reply_tasks
      WHERE status IN ('open', 'in_progress')
        AND due_at IS NOT NULL
        AND notify_channel IS NOT NULL
        AND notify_channel != 'none'
        AND notified_at IS NULL
        AND due_at > NOW()
        AND due_at <= NOW() + (COALESCE(notify_before_minutes, 60) * INTERVAL '1 minute')
    `);
    tasks = r.rows;
  } catch (err) {
    console.error('[TaskNotifier] DB query failed:', err.message);
    return;
  }

  if (!tasks.length) return;

  const wa    = getWA();
  const graph = getGraph();
  const now   = new Date();

  for (const task of tasks) {
    if (!shouldNotify(task, now)) continue;

    let sent = false;

    // WhatsApp notification
    if ((task.notify_channel === 'wa' || task.notify_channel === 'both') && task.assigned_to_phone) {
      const jid = phoneToJid(task.assigned_to_phone);
      if (jid && wa && typeof wa.sendMessage === 'function') {
        try {
          await wa.sendMessage(jid, buildWaMessage(task));
          sent = true;
          console.log(`[TaskNotifier] WA sent for task #${task.id} → ${jid}`);
        } catch (err) {
          console.error(`[TaskNotifier] WA send failed for task #${task.id}:`, err.message);
          try { activityLog.append({ type: 'error', service: 'task-notifier', message: `WA notification failed for task #${task.id}: ${err.message}`, timestamp: new Date().toISOString() }); } catch (_) {}
        }
      }
    }

    // Email notification
    if ((task.notify_channel === 'email' || task.notify_channel === 'both') && task.assigned_to_email) {
      const payload = buildEmailPayload(task);
      if (payload && graph && typeof graph.graphPost === 'function') {
        try {
          await graph.graphPost('/me/sendMail', payload);
          sent = true;
          console.log(`[TaskNotifier] Email sent for task #${task.id} → ${task.assigned_to_email}`);
        } catch (err) {
          console.error(`[TaskNotifier] Email send failed for task #${task.id}:`, err.message);
          try { activityLog.append({ type: 'error', service: 'task-notifier', message: `Email notification failed for task #${task.id}: ${err.message}`, timestamp: new Date().toISOString() }); } catch (_) {}
        }
      }
    }

    // Mark notified (even if one channel failed — prevents spam)
    if (sent) {
      try {
        await db.query(`UPDATE mail_reply_tasks SET notified_at = NOW() WHERE id = $1`, [task.id]);
      } catch (err) {
        console.error(`[TaskNotifier] Failed to mark notified for task #${task.id}:`, err.message);
      }
    }
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

function start(dbPool) {
  const db = dbPool || pool;

  // Every 30 seconds
  cron.schedule('*/30 * * * * *', () => {
    runTick(db).catch(err => {
      console.error('[TaskNotifier] Tick error:', err.message);
    });
  });

  console.log('[TaskNotifier] Scheduler started — checking every 30s');
}

module.exports = { start, shouldNotify, phoneToJid, buildWaMessage, buildEmailPayload };

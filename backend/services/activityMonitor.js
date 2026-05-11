/**
 * AI Activity Monitor Service
 * 
 * Generates intelligent, real-time activity log entries based on email analysis insights.
 * Operates independently without interfering with core email analysis pipeline.
 * 
 * Key Features:
 * - Analyzes processed email insights (not raw data)
 * - Generates concise, single-line activity logs
 * - Integrates with existing activity log system
 * - Runs asynchronously to avoid blocking main flow
 */

const activityLog = require('./activityLog');

/**
 * Generate AI-driven activity log entries from email analysis results
 * @param {Object} analysisResult - Completed email analysis from emailAnalyzer
 * @param {Object} preprocessedData - Preprocessed email statistics
 * @param {number} userId - User ID for activity logging
 * @returns {Promise<Array>} - Array of generated log entries
 */
async function generateActivityLogs(analysisResult, preprocessedData, userId = null) {
  const logs = [];

  try {
    // Extract key metrics from preprocessed data
    const { allEmailsCount, unreadCount, urgentCount, topEmails } = preprocessedData;

    // 🔴 CRITICAL: Urgent emails requiring immediate response
    if (urgentCount > 0) {
      const urgentEmails = topEmails.filter(e => e.importance === 'high' && !e.isRead);
      if (urgentEmails.length === 1) {
        logs.push({
          severity: 'critical',
          emoji: '🔴',
          category: 'URGENT',
          message: 'High-priority email requires immediate response.',
        });
      } else if (urgentEmails.length > 1) {
        logs.push({
          severity: 'critical',
          emoji: '🔴',
          category: 'URGENT',
          message: `${urgentEmails.length} high-priority emails require immediate attention.`,
        });
      }
    }

    // 🟡 FOLLOW-UP: Emails unread for extended duration (24+ hours)
    const oldUnread = topEmails.filter(e => !e.isRead && e.unread_duration_hours >= 24);
    if (oldUnread.length > 0) {
      const maxUnreadHours = Math.max(...oldUnread.map(e => e.unread_duration_hours));
      if (maxUnreadHours >= 48) {
        logs.push({
          severity: 'warning',
          emoji: '🟡',
          category: 'FOLLOW-UP',
          message: `Email thread pending reply for over ${Math.floor(maxUnreadHours / 24)} days.`,
        });
      } else {
        logs.push({
          severity: 'warning',
          emoji: '🟡',
          category: 'FOLLOW-UP',
          message: `${oldUnread.length} email${oldUnread.length > 1 ? 's' : ''} unread for more than 24 hours.`,
        });
      }
    }

    // ⚠️ ALERT: High email workload or sudden spikes
    if (unreadCount > 50) {
      logs.push({
        severity: 'alert',
        emoji: '⚠️',
        category: 'ALERT',
        message: `High email workload detected with ${unreadCount} unread messages.`,
      });
    } else if (unreadCount > 30) {
      logs.push({
        severity: 'alert',
        emoji: '⚠️',
        category: 'ALERT',
        message: `Elevated inbox activity with ${unreadCount} unread emails.`,
      });
    }

    // 📈 INSIGHT: Email volume patterns
    if (allEmailsCount > 100) {
      logs.push({
        severity: 'info',
        emoji: '📈',
        category: 'INSIGHT',
        message: `High email volume detected with ${allEmailsCount} messages in analysis window.`,
      });
    }

    // 📈 INSIGHT: Emails with attachments requiring review
    const withAttachments = topEmails.filter(e => e.has_attachments);
    if (withAttachments.length > 10) {
      logs.push({
        severity: 'info',
        emoji: '📈',
        category: 'INSIGHT',
        message: `${withAttachments.length} emails with attachments may require document review.`,
      });
    }

    // 🧹 CLEANUP: Old emails suitable for deletion
    const oldEmails = topEmails.filter(e => {
      const ageHours = calculateEmailAge(e);
      return ageHours > 168; // 7 days
    });
    
    if (oldEmails.length > 20) {
      const storageSavings = (oldEmails.length * 0.05).toFixed(1);
      logs.push({
        severity: 'info',
        emoji: '🧹',
        category: 'CLEANUP',
        message: `${oldEmails.length} emails older than 7 days identified for archival (${storageSavings} MB estimated savings).`,
      });
    }

    // 🧹 CLEANUP: Read emails older than 3 days
    const oldReadEmails = topEmails.filter(e => {
      const ageHours = calculateEmailAge(e);
      return e.isRead && ageHours > 72; // 3 days
    });
    
    if (oldReadEmails.length > 30) {
      logs.push({
        severity: 'info',
        emoji: '🧹',
        category: 'CLEANUP',
        message: `${oldReadEmails.length} read emails older than 3 days can be moved to archive.`,
      });
    }

    // Persist logs to database (asynchronously, non-blocking)
    await persistActivityLogs(logs, userId);

    return logs;

  } catch (error) {
    console.error('[Activity Monitor] Failed to generate activity logs:', error.message);
    return [];
  }
}

/**
 * Calculate email age in hours
 * @param {Object} email - Email record
 * @returns {number} - Age in hours
 */
function calculateEmailAge(email) {
  const receivedDate = new Date(email.received_datetime || email.sent_datetime);
  const now = new Date();
  const ageMs = now - receivedDate;
  return ageMs / (1000 * 60 * 60); // Convert to hours
}

/**
 * Persist activity logs to database
 * @param {Array} logs - Array of log entries
 * @param {number} userId - User ID
 * @returns {Promise<void>}
 */
async function persistActivityLogs(logs, userId) {
  try {
    for (const log of logs) {
      const logMessage = `${log.emoji} ${log.category}: ${log.message}`;
      
      await activityLog.logEvent({
        user_id: userId,
        action: 'ai_email_monitor',
        entity_type: 'email_intelligence',
        entity_id: null,
        metadata: {
          source: 'AI',
          severity: log.severity,
          category: log.category,
          emoji: log.emoji,
          message: log.message,
        },
        description: logMessage,
      });
    }
  } catch (error) {
    console.error('[Activity Monitor] Failed to persist logs:', error.message);
  }
}

/**
 * Generate critical alert for immediate UI notification
 * @param {Array} logs - Generated log entries
 * @returns {Object|null} - Critical alert object or null
 */
function getCriticalAlert(logs) {
  const criticalLog = logs.find(log => log.severity === 'critical');
  
  if (criticalLog) {
    return {
      severity: 'critical',
      message: `${criticalLog.emoji} ${criticalLog.message}`,
      category: criticalLog.category,
    };
  }
  
  return null;
}

module.exports = {
  generateActivityLogs,
  getCriticalAlert,
};

/**
 * Email Preprocessor Component
 * 
 * Rule-based preprocessing for email analysis before AI processing.
 * Calculates priority scores, filters top emails, and generates basic insights.
 * 
 * Key Features:
 * - Multi-factor priority scoring (0-100)
 * - Unread duration calculation
 * - Top-N email filtering for batch optimization
 * - Rule-based insight generation
 * - Cleanup recommendations
 */

/**
 * Preprocess emails for AI analysis
 * @param {Array} emails - Raw email records from database
 * @returns {Object} - Preprocessed data with top emails, insights, and recommendations
 */
function preprocessEmails(emails) {
  if (!Array.isArray(emails) || emails.length === 0) {
    return {
      topEmails: [],
      allEmailsCount: 0,
      unreadCount: 0,
      urgentCount: 0,
      ruleBasedInsights: [],
      cleanupRecommendations: [],
    };
  }

  // Calculate priority scores and unread duration for all emails
  const scoredEmails = emails.map(email => {
    const calculated_priority = calculatePriorityScore(email);
    const unread_duration_hours = email.is_read ? 0 : calculateUnreadDuration(email);
    
    return {
      ...email,
      calculated_priority,
      unread_duration_hours,
      isRead: email.is_read,
      importance: email.importance || 'normal',
    };
  });

  // Sort by priority (descending)
  scoredEmails.sort((a, b) => b.calculated_priority - a.calculated_priority);

  // Filter top 10-20 emails for AI analysis (batch size optimization)
  const batchSize = parseInt(process.env.AI_ASSISTANT_BATCH_SIZE || '20');
  const topEmails = scoredEmails.slice(0, Math.min(batchSize, scoredEmails.length));

  // Calculate statistics
  const unreadCount = scoredEmails.filter(e => !e.is_read).length;
  const urgentCount = scoredEmails.filter(e => e.importance === 'high' && !e.is_read).length;

  // Generate rule-based insights
  const ruleBasedInsights = generateRuleBasedInsights(scoredEmails, unreadCount, urgentCount);

  // Generate cleanup recommendations
  const cleanupRecommendations = generateCleanupRecommendations(scoredEmails);

  return {
    topEmails,
    allEmailsCount: scoredEmails.length,
    unreadCount,
    urgentCount,
    ruleBasedInsights,
    cleanupRecommendations,
  };
}

/**
 * Calculate priority score for an email (0-100)
 * @param {Object} email - Email record
 * @returns {number} - Priority score 0-100
 */
function calculatePriorityScore(email) {
  let score = 0;

  // Factor 1: Importance flag (0-40 points)
  if (email.importance === 'high') {
    score += 40;
  } else if (email.importance === 'normal') {
    score += 20;
  } else {
    score += 5; // low importance
  }

  // Factor 2: Read status (0-25 points)
  if (!email.is_read) {
    score += 25;
  }

  // Factor 3: Email age - recent emails weighted more heavily (0-25 points)
  const ageHours = calculateEmailAge(email);
  if (ageHours <= 24) {
    score += 25; // Last 24 hours
  } else if (ageHours <= 48) {
    score += 20; // Last 48 hours
  } else if (ageHours <= 72) {
    score += 15; // Last 3 days
  } else if (ageHours <= 168) {
    score += 10; // Last week
  } else {
    score += 5; // Older than a week
  }

  // Factor 4: Has attachments (0-10 points)
  if (email.has_attachments) {
    score += 10;
  }

  return Math.min(100, Math.max(0, score));
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
 * Calculate unread duration in hours
 * @param {Object} email - Email record
 * @returns {number} - Unread duration in hours
 */
function calculateUnreadDuration(email) {
  if (email.is_read) return 0;
  return calculateEmailAge(email);
}

/**
 * Generate rule-based insights
 * @param {Array} emails - Scored emails
 * @param {number} unreadCount - Total unread count
 * @param {number} urgentCount - Urgent unread count
 * @returns {Array} - Insights array with emoji indicators
 */
function generateRuleBasedInsights(emails, unreadCount, urgentCount) {
  const insights = [];

  // Urgent unread emails
  if (urgentCount > 0) {
    insights.push(`🔴 ${urgentCount} urgent unread email${urgentCount > 1 ? 's' : ''} requiring immediate attention`);
  }

  // High unread count
  if (unreadCount > 20) {
    insights.push(`🟡 ${unreadCount} unread emails detected - inbox cleanup recommended`);
  } else if (unreadCount > 0) {
    insights.push(`🟡 ${unreadCount} unread email${unreadCount > 1 ? 's' : ''} pending review`);
  }

  // Old unread emails (>48 hours)
  const oldUnread = emails.filter(e => !e.is_read && calculateEmailAge(e) > 48);
  if (oldUnread.length > 5) {
    insights.push(`📈 ${oldUnread.length} emails unread for more than 48 hours - potential missed follow-ups`);
  }

  // Emails with attachments
  const withAttachments = emails.filter(e => e.has_attachments);
  if (withAttachments.length > 10) {
    insights.push(`📈 ${withAttachments.length} emails with attachments - may require document review`);
  }

  return insights;
}

/**
 * Generate cleanup recommendations
 * @param {Array} emails - All emails
 * @returns {Array} - Cleanup recommendation strings
 */
function generateCleanupRecommendations(emails) {
  const recommendations = [];

  // Identify old emails (>7 days)
  const oldEmails = emails.filter(e => calculateEmailAge(e) > 168); // 7 days = 168 hours
  
  if (oldEmails.length > 0) {
    const storageSavings = (oldEmails.length * 0.05).toFixed(2); // 0.05 MB per email average
    recommendations.push(`${oldEmails.length} emails older than 7 days can be archived (estimated ${storageSavings} MB savings)`);
  }

  // Identify read emails older than 3 days
  const oldReadEmails = emails.filter(e => e.is_read && calculateEmailAge(e) > 72);
  if (oldReadEmails.length > 20) {
    recommendations.push(`${oldReadEmails.length} read emails older than 3 days can be moved to archive`);
  }

  // Low importance emails
  const lowImportance = emails.filter(e => e.importance === 'low');
  if (lowImportance.length > 10) {
    recommendations.push(`${lowImportance.length} low-importance emails detected - consider bulk archiving`);
  }

  return recommendations;
}

module.exports = {
  preprocessEmails,
  calculatePriorityScore,
  calculateEmailAge,
  calculateUnreadDuration,
  generateRuleBasedInsights,
  generateCleanupRecommendations,
};

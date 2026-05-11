/**
 * Email Analyzer Orchestrator
 * 
 * Main orchestration component for AI email intelligence analysis.
 * Coordinates database queries, preprocessing, AI service calls, and result formatting.
 * 
 * Key Features:
 * - Parameter validation
 * - Database query orchestration
 * - Hybrid analysis (rule-based + AI)
 * - Fallback to rule-based analysis on AI failure
 * - Error handling and logging
 */

const pool = require('../db/pool');
const preprocessor = require('./emailPreprocessor');
const ollamaService = require('./ollamaService');
const activityMonitor = require('./activityMonitor');

const aiTaskQueue = require('./aiTaskQueue');

/**
 * Analyze emails with AI intelligence (Asynchronous Queue Version)
 * @param {Object} params - Analysis parameters
 */
async function analyzeEmails(params = {}) {
  const timeframe = Math.max(1, Math.min(168, parseInt(params.timeframe || 48)));
  const includeRead = params.includeRead !== false;
  const maxEmails = Math.max(1, Math.min(500, parseInt(params.maxEmails || 500)));
  const userId = params.userId || null;
  const caller = params.caller || 'MANUAL_UI';

  try {
    // ✅ 5. ADD LOG (Manual Trigger Confirmation)
    console.log(`[AI Queue] AI started via manual trigger (Caller: ${caller})`);

    let emails = params.emails || await queryEmailsForAnalysis(timeframe, includeRead, maxEmails);
    
    // ✅ 1. FORCE SINGLE EMAIL (Strict Testing Mode)
    if (emails.length > 0) {
      emails = emails.slice(0, 1);
      console.log(`[AI Queue] Analyzing email subject: "${emails[0].subject || 'No Subject'}"`);
    } else {
      console.log('[AI Queue] No emails found for analysis.');
      return { success: false, message: 'No emails found' };
    }

    const batchId = `batch_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    
    // ✅ 2. DISABLE BULK TASK CREATION (Only one task ever)
    const taskId = await aiTaskQueue.queueTask('map_chunk', {
      emails: emails,
      userId
    }, batchId, caller);

    if (!taskId) {
      return {
        success: false,
        status: 'busy',
        message: 'Analysis already in progress. Please wait for current task to complete.'
      };
    }

    return {
      success: true,
      status: 'pending',
      batchId,
      message: `AI analysis started for single email: ${emails[0].subject || 'Untitled'}`,
      taskIds: [taskId],
      metadata: {
        emailsAnalyzed: 1,
        chunks: 1,
        timestamp: new Date().toISOString()
      }
    };

  } catch (error) {
    console.error('[Email Analyzer] Analysis orchestration failed:', error.message);
    throw error;
  }
}

/**
 * Query emails from database for analysis
 * @param {number} timeframe - Hours to look back
 * @param {boolean} includeRead - Include read emails
 * @param {number} maxEmails - Maximum emails to return
 * @returns {Promise<Array>} - Email records
 */
async function queryEmailsForAnalysis(timeframe, includeRead, maxEmails) {
  try {
    let query = `
      SELECT 
        id, conversation_id, subject, from_address, from_name,
        to_recipients, cc_recipients, received_datetime, sent_datetime,
        is_read, body_preview, has_attachments, importance, folder, category
      FROM outlook_emails_cache
      WHERE received_datetime >= NOW() - INTERVAL '${timeframe} hours'
    `;

    // Apply read status filter if needed
    if (!includeRead) {
      query += ` AND is_read = false`;
    }

    // Order by received date (most recent first)
    query += ` ORDER BY received_datetime DESC`;

    // Limit results
    query += ` LIMIT ${maxEmails}`;

    const result = await pool.query(query);
    return result.rows;

  } catch (error) {
    console.error('[Email Analyzer] Database query failed:', error.message);
    throw new Error('Email cache temporarily unavailable');
  }
}

/**
 * Perform hybrid email analysis (rule-based + AI)
 * @param {Array} emails - Email records
 * @returns {Promise<Object>} - Analysis results
 */
async function hybridEmailAnalysis(emails) {
  try {
    // Step 1: Rule-based preprocessing
    const preprocessed = preprocessor.preprocessEmails(emails);

    // Step 2: Call Ollama service with top emails
    let aiResponse = null;
    let fallback = false;
    let fallbackReason = null;

    try {
      aiResponse = await ollamaService.callAIService(
        ollamaService.prepareSystemInstructions(),
        preprocessed.topEmails
      );
    } catch (aiError) {
      console.warn('[Email Analyzer] AI service failed, using rule-based fallback:', aiError.message);
      fallback = true;
      fallbackReason = aiError.message;
    }

    // Step 3: Combine rule-based and AI insights
    if (fallback || !aiResponse) {
      // Fallback to rule-based analysis only
      return generateRuleBasedFallbackResponse(preprocessed, fallbackReason);
    }

    // Parse AI response and combine with rule-based insights
    const analysis = parseAIResponse(aiResponse);

    // Merge cleanup recommendations from preprocessing
    if (preprocessed.cleanupRecommendations.length > 0) {
      analysis.systemOptimization = [
        ...analysis.systemOptimization,
        ...preprocessed.cleanupRecommendations,
      ];
    }

    return {
      ...analysis,
      fallback: false,
    };

  } catch (error) {
    console.error('[Email Analyzer] Hybrid analysis failed:', error.message);
    throw error;
  }
}

/**
 * Generate rule-based fallback response when AI is unavailable
 * @param {Object} preprocessed - Preprocessed email data
 * @param {string} fallbackReason - Reason for fallback
 * @returns {Object} - Fallback analysis response
 */
function generateRuleBasedFallbackResponse(preprocessed, fallbackReason) {
  const { allEmailsCount, unreadCount, urgentCount, ruleBasedInsights, cleanupRecommendations } = preprocessed;

  // Generate summary
  const summary = `Email system analysis complete. ${allEmailsCount} emails analyzed from your inbox. ${unreadCount} unread emails detected${urgentCount > 0 ? `, including ${urgentCount} marked as high importance` : ''}.`;

  // Generate smart actions based on rules
  const smartActions = [];
  if (urgentCount > 0) {
    smartActions.push('1. Review and respond to urgent high-importance emails immediately.');
  }
  if (unreadCount > 10) {
    smartActions.push(`${smartActions.length + 1}. Process ${unreadCount} unread emails to maintain inbox zero.`);
  }
  if (allEmailsCount > 50) {
    smartActions.push(`${smartActions.length + 1}. Consider archiving older emails to improve inbox organization.`);
  }
  if (smartActions.length === 0) {
    smartActions.push('1. Inbox is in good shape. Continue monitoring for new messages.');
  }

  return {
    summary,
    insights: ruleBasedInsights,
    smartActions,
    systemOptimization: cleanupRecommendations,
    fallback: true,
    fallbackReason: fallbackReason || 'AI service unavailable',
  };
}

/**
 * Parse AI response text into structured format
 * @param {string} aiResponse - Raw AI response text
 * @returns {Object} - Parsed analysis object
 */
function parseAIResponse(aiResponse) {
  const sections = {
    summary: '',
    insights: [],
    smartActions: [],
    systemOptimization: [],
  };

  try {
    const lines = aiResponse.split('\n').map(line => line.trim()).filter(Boolean);
    let currentSection = null;

    for (const line of lines) {
      // Detect section headers
      if (/^Summary:/i.test(line)) {
        currentSection = 'summary';
        const content = line.replace(/^Summary:/i, '').trim();
        if (content) sections.summary = content;
        continue;
      }
      if (/^Insights:/i.test(line)) {
        currentSection = 'insights';
        continue;
      }
      if (/^Smart Actions/i.test(line)) {
        currentSection = 'smartActions';
        continue;
      }
      if (/^System Optimization:/i.test(line)) {
        currentSection = 'systemOptimization';
        continue;
      }

      // Add content to current section
      if (currentSection === 'summary' && !sections.summary) {
        sections.summary = line;
      } else if (currentSection === 'insights' && (line.startsWith('🔴') || line.startsWith('🟡') || line.startsWith('📈') || line.startsWith('-') || line.startsWith('•'))) {
        sections.insights.push(line.replace(/^[-•]\s*/, ''));
      } else if (currentSection === 'smartActions' && /^\d+\./.test(line)) {
        sections.smartActions.push(line);
      } else if (currentSection === 'systemOptimization' && (line.startsWith('-') || line.startsWith('•') || line.startsWith('→'))) {
        sections.systemOptimization.push(line.replace(/^[-•→]\s*/, ''));
      }
    }

    // Ensure summary is not empty
    if (!sections.summary) {
      sections.summary = 'Email analysis complete. Review insights and recommended actions below.';
    }

  } catch (parseError) {
    console.warn('[Email Analyzer] Failed to parse AI response:', parseError.message);
    // Return minimal structure on parse failure
    return {
      summary: 'Email analysis complete. AI response parsing encountered an issue.',
      insights: ['Analysis completed with partial results.'],
      smartActions: ['1. Review emails manually for important items.'],
      systemOptimization: [],
    };
  }

  return sections;
}

module.exports = {
  analyzeEmails,
  queryEmailsForAnalysis,
  hybridEmailAnalysis,
  generateRuleBasedFallbackResponse,
  parseAIResponse,
};

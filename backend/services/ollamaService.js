/**
 * Ollama Service Integration
 * 
 * Local AI service client for privacy-first, cost-free email intelligence analysis.
 * Uses Ollama (phi3:mini) running locally at http://localhost:11434
 * 
 * Key Features:
 * - Zero cost (no external API calls)
 * - Complete privacy (email data never leaves the system)
 * - Offline capable (no internet required)
 * - Adaptive intelligence (SMALL/MEDIUM/LARGE complexity levels)
 */

const { fork } = require('child_process');
const path = require('path');
const DEFAULT_FAST_MODEL = 'llama-3.1-8b-instant';

function safeGroqModel(value, fallback = DEFAULT_FAST_MODEL) {
  const model = String(value || '').trim();
  if (!model || /^gemma2-9b-it$/i.test(model)) return fallback;
  return model;
}

async function callOllamaService(prompt, preprocessedEmails, onWorker = null) {
  // ── GROQ CLOUD API (Priority) ──────────────────────────────────────────
  if (process.env.AI_API_KEY) {
    try {
      console.log('[AI] Using PicoClaw/Groq API for analysis...');
      return await callGroqService(prompt, preprocessedEmails);
    } catch (err) {
      console.warn('[AI] PicoClaw/Groq API failed:', err.message);
      if (process.env.AI_ALLOW_OLLAMA_FALLBACK !== 'true') throw err;
    }
  }

  // ── LOCAL OLLAMA (Fallback) ─────────────────────────────────────────────
  if (process.env.AI_ALLOW_OLLAMA_FALLBACK !== 'true') {
    throw new Error('AI API unavailable and Ollama fallback is disabled');
  }

  const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
  const ollamaModel = process.env.OLLAMA_MODEL || 'phi3:mini';
  
  const systemInstructions = (preprocessedEmails && preprocessedEmails.length > 0) ? prepareSystemInstructions() : '';
  const userPrompt = (preprocessedEmails && preprocessedEmails.length > 0) ? buildUserPrompt(preprocessedEmails) : prompt;
  const constructedPrompt = systemInstructions ? `${systemInstructions}\n\n${userPrompt}` : userPrompt;

  console.log('[AI] Starting AI worker...');

  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'aiWorker.js');
    const worker = fork(workerPath);

    if (onWorker) onWorker(worker);

    const timeoutId = setTimeout(() => {
      worker.kill();
      reject(new Error('AI worker execution timeout (300s)'));
    }, 300000);

    worker.send({
      ollamaHost,
      ollamaModel,
      prompt: constructedPrompt
    });

    worker.on('message', (msg) => {
      clearTimeout(timeoutId);
      worker.kill();

      if (msg.error) {
        console.error('[AI] AI worker error:', msg.error);
        reject(new Error(msg.error));
      } else {
        console.log('[AI] AI worker completed');
        resolve(msg.response);
      }
    });

    worker.on('error', (err) => {
      clearTimeout(timeoutId);
      worker.kill();
      console.error('[AI] AI worker process error:', err.message);
      reject(err);
    });

    worker.on('exit', (code) => {
      clearTimeout(timeoutId);
      if (code === null) {
        // Process was killed (likely cancelled)
        reject(new Error('TASK_CANCELLED'));
      } else if (code !== 0) {
        reject(new Error(`AI worker exited with code ${code}`));
      }
    });
  });
}

/**
 * Prepare system instructions for JARVIS-style behavior with adaptive intelligence
 * @returns {string} - System instructions for Ollama
 */
function prepareSystemInstructions() {
  return `You are an AI email intelligence assistant (JARVIS-style) for a B2B sales CRM.
Analyze emails and respond ONLY in this exact format — no extra text:

Summary:
(1-2 sentences on the overall situation.)

Insights:
- 🔴 [urgent issue or critical item]
- 🟡 [follow-up needed]
- 📈 [pattern or opportunity]

Smart Actions:
1. [action + reason]
2. [action + reason]
3. [action + reason]

System Optimization:
- [cleanup or efficiency tip]

Rules: Be concise. No questions. No reasoning. End every sentence with punctuation.`;
}

/**
 * Build user prompt with adaptive complexity detection
 * @param {Array} preprocessedEmails - Preprocessed email data
 * @returns {string} - User prompt for Ollama
 */
function buildUserPrompt(preprocessedEmails) {
  const emailCount = preprocessedEmails.length;
  const urgentCount = preprocessedEmails.filter(e => e.importance === 'high' && !e.isRead).length;
  const unreadCount = preprocessedEmails.filter(e => !e.isRead).length;

  // Determine complexity level for adaptive analysis
  let complexityLevel = 'SMALL';
  if (emailCount > 20) {
    complexityLevel = 'LARGE';
  } else if (emailCount > 10) {
    complexityLevel = 'MEDIUM';
  }

  const emailSummaries = preprocessedEmails.map(e => ({
    from: e.from_name || e.from_address,
    subject: e.subject,
    preview: e.body_preview?.substring(0, 100),
    unreadHours: e.unread_duration_hours,
    priority: e.calculated_priority,
    importance: e.importance,
    isRead: e.isRead
  }));

  return `Analyze these ${emailCount} emails (Complexity: ${complexityLevel}):

Email Data:
${JSON.stringify(emailSummaries, null, 2)}

Metadata:
- Total emails: ${emailCount}
- Unread: ${unreadCount}
- High-importance unread: ${urgentCount}

Provide a JARVIS-style intelligence report following the exact format specified. Adapt your analysis depth based on the complexity level indicated above.`;
}

/**
 * Main AI service call with fallback support
 * @param {string} prompt - System instructions
 * @param {Array} emails - Email data
 * @returns {Promise<string>} - AI-generated analysis
 */
async function callAIService(prompt, emails) {
  // Primary: Try Ollama first
  try {
    return await callOllamaService(prompt, emails);
  } catch (error) {
    console.error('[AI] Ollama failed:', error.message);

    // Fallback: Only if explicitly enabled
    if (process.env.AI_EXTERNAL_ENABLED === 'true') {
      console.log('[AI] Attempting external AI fallback...');
      return await callExternalAIService(prompt, emails);
    }

    // No fallback: Throw error to trigger rule-based analysis
    throw error;
  }
}

/**
 * External AI service fallback (OpenAI/Claude) - disabled by default
 * @param {string} prompt - System instructions
 * @param {Array} emails - Email data
 * @returns {Promise<string>} - AI-generated analysis
 */
async function callExternalAIService(prompt, emails) {
  const provider = process.env.AI_EXTERNAL_PROVIDER;

  if (provider === 'openai') {
    return await callOpenAI(prompt, emails);
  } else if (provider === 'anthropic') {
    return await callAnthropic(prompt, emails);
  }

  throw new Error('External AI provider not configured');
}

/**
 * OpenAI fallback (only if AI_EXTERNAL_ENABLED=true)
 * @param {string} prompt - System instructions
 * @param {Array} emails - Email data
 * @returns {Promise<string>} - AI-generated analysis
 */
async function callOpenAI(prompt, emails) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.AI_EXTERNAL_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.AI_EXTERNAL_MODEL || 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: prepareSystemInstructions() },
        { role: 'user', content: buildUserPrompt(emails) }
      ],
      temperature: 0.7,
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * Anthropic Claude fallback (only if AI_EXTERNAL_ENABLED=true)
 * @param {string} prompt - System instructions
 * @param {Array} emails - Email data
 * @returns {Promise<string>} - AI-generated analysis
 */
async function callAnthropic(prompt, emails) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.AI_EXTERNAL_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.AI_EXTERNAL_MODEL || 'claude-3-opus-20240229',
      max_tokens: 2000,
      system: prepareSystemInstructions(),
      messages: [
        { role: 'user', content: buildUserPrompt(emails) }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

/**
 * Groq Cloud API implementation
 * @param {string} prompt - Full prompt or system instructions
 * @param {Array} emails - Optional email data for context
 */
async function callGroqService(prompt, emails, retryCount = 0) {
  const apiKey = process.env.AI_API_KEY;
  const host   = process.env.AI_API_HOST || 'https://api.groq.com/openai/v1';
  const model = safeGroqModel(process.env.AI_FAST_MODEL || process.env.AI_API_MODEL);
  const maxTokens = Math.min(parseInt(process.env.AI_MAX_TOKENS || '160', 10) || 160, 220);

  const systemContent = (emails && emails.length > 0) ? prepareSystemInstructions() : 'You are a professional CRM assistant.';
  const userContent   = (emails && emails.length > 0) ? buildUserPrompt(emails) : prompt;

  const aiBody = {
    model: model,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ],
    temperature: 0.2,
    max_tokens: maxTokens
  };
  if (/^groq\/compound/i.test(model)) {
    aiBody.search_settings = { country: 'india' };
  }

  const response = await fetch(`${host}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(aiBody)
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    
    // Handle Rate Limit with a single retry after a delay
    if (response.status === 429 && retryCount < 1) {
      console.warn('[AI] Groq Rate Limit hit. Retrying in 12 seconds...');
      await new Promise(resolve => setTimeout(resolve, 12000));
      return callGroqService(prompt, emails, retryCount + 1);
    }

    throw new Error(`Groq API error: ${response.status} ${errData.error?.message || ''}`);
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

module.exports = {
  callOllamaService,
  callGroqService,
  callAIService,
  prepareSystemInstructions,
  buildUserPrompt
};

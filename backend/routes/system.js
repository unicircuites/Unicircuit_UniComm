/**
 * System Routes
 * GET /api/system/status  — live service health (requires auth)
 * GET /api/system/log     — recent activity log entries (requires auth)
 */
const express    = require('express');
const net        = require('net');
const { authenticate } = require('../middleware/auth');
const activityLog = require('../services/activityLog');
const pool       = require('../db/pool');

const router = express.Router();
const DEFAULT_FAST_MODEL = 'llama-3.1-8b-instant';
const DEFAULT_CURRENT_MODEL = 'groq/compound-mini';
const PBX_HOST = process.env.PBX_HOST || '192.168.0.81';
const CTI_PORT = parseInt(process.env.CTI_PORT || '4000', 10);

function makeTraceId(prefix = 'SYS') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function resolveAIModel() {
  const configuredModel = String(process.env.AI_API_MODEL || '').trim();
  if (!configuredModel || /^gemma2-9b-it$/i.test(configuredModel)) return DEFAULT_FAST_MODEL;
  return configuredModel;
}

function safeModel(value, fallback) {
  const model = String(value || '').trim();
  if (!model || /^gemma2-9b-it$/i.test(model)) return fallback;
  return model;
}

function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok, error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, error });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (err) => done(false, err.message));
    socket.connect(port, host);
  });
}

function shortText(value, max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function detectNeedsCurrentInfo(text) {
  return /\b(latest|current|news|recent|up[- ]?to[- ]?date|web|search|price|weather|law|rule|regulation|market|stock)\b/i
    .test(String(text || ''));
}

function detectPrivateBusinessContext(text) {
  return /\b(crm|outlook|email|mail|whatsapp|call|pbx|contact|lead|deal|pipeline|payment|invoice|quotation|quote|tender|po|pending action|follow[- ]?up|client|customer)\b/i
    .test(String(text || ''));
}

function compactMessages(messages, options = {}) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const historyLimit = options.historyLimit || 6;
  const charLimit = options.charLimit || 700;
  return safeMessages
    .filter(msg => msg && msg.role && typeof msg.content === 'string')
    .filter(msg => msg.role !== 'system')
    .slice(-historyLimit)
    .map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: shortText(msg.content, charLimit)
    }));
}

function planAIRequest(req) {
  const operation = String(req.body.operation || 'chat').trim().toLowerCase();
  const preferredModel = String(req.body.preferredModel || req.body.modelMode || 'auto').trim().toLowerCase();
  const rawMessages = Array.isArray(req.body.messages) ? req.body.messages : [];
  const lastUser = [...rawMessages].reverse().find(msg => msg && msg.role !== 'assistant');
  const lastText = lastUser?.content || '';
  const isMailAI = operation === 'mail_ai';
  const isPrivateBusinessContext = isMailAI || detectPrivateBusinessContext(lastText);
  const needsCurrentInfo = preferredModel === 'current' || operation === 'current_info' || (detectNeedsCurrentInfo(lastText) && !isPrivateBusinessContext);
  const asksDraft = /\b(draft|write|compose|reply|email|message)\b/i.test(lastText);
  const asksForList = /\b(list|formats?|types?|all|complete|full)\b/i.test(lastText);

  const fastModel = safeModel(process.env.AI_FAST_MODEL || process.env.AI_API_MODEL, DEFAULT_FAST_MODEL);
  const currentModel = safeModel(process.env.AI_CURRENT_MODEL, DEFAULT_CURRENT_MODEL);
  const deepModel = safeModel(process.env.AI_DEEP_MODEL || process.env.AI_API_MODEL, fastModel);
  const model = preferredModel === 'current'
    ? currentModel
    : preferredModel === 'deep'
      ? deepModel
      : preferredModel === 'fast'
        ? fastModel
        : (needsCurrentInfo && !isMailAI ? currentModel : fastModel);
  const requestedMax = parseInt(process.env.AI_MAX_TOKENS || '1200', 10) || 1200;
  const targetMaxTokens = preferredModel === 'deep'
    ? 1800
    : asksDraft
      ? 1200
      : (asksForList ? 1500 : 850);

  return {
    operation,
    preferredModel,
    model,
    needsCurrentInfo: needsCurrentInfo && !isMailAI,
    includeCrmContext: !isMailAI,
    historyLimit: isMailAI ? 3 : 6,
    charLimit: isMailAI ? 1800 : 700,
    maxTokens: Math.min(Math.max(requestedMax, targetMaxTokens), preferredModel === 'deep' ? 2400 : 1800)
  };
}

function getRetryAfterSeconds(response, bodyText) {
  const headerValue = response.headers.get('retry-after');
  const headerSeconds = Number.parseFloat(headerValue);
  if (Number.isFinite(headerSeconds)) return Math.ceil(headerSeconds);

  const match = String(bodyText || '').match(/try again in\s+([\d.]+)s/i);
  return match ? Math.ceil(Number.parseFloat(match[1])) : 30;
}

/**
 * Shared service state — updated by server.js bridge and probes.
 * Exported so server.js can import and mutate it directly.
 */
const serviceState = {
  whatsapp: { status: 'offline', lastConnected: null, lastDisconnected: null, phone: null },
  pbx:      { status: 'offline', lastConnected: null, lastDisconnected: null, port: 5001, mode: 'server', clientHost: null },
  outlook:  { status: 'offline', lastConnected: null, lastDisconnected: null, email: null },
  postgres: { status: 'offline', lastConnected: null, lastDisconnected: null },
};

// ── GET /api/system/status ────────────────────────────────────────────────
router.get('/status', authenticate, async (req, res) => {
  const traceId = makeTraceId('SYS-STATUS');
  console.log(`[${traceId}] GET /api/system/status started`, {
    user: req.user?.id || req.user?.email || null,
    ip: req.ip,
    ua: req.get('user-agent'),
    currentPbxState: serviceState.pbx,
  });

  // Probe PostgreSQL live with a 3000ms timeout
  try {
    console.log(`[${traceId}] PostgreSQL probe started`);
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('PostgreSQL probe timed out')), 3000)
      ),
    ]);
    serviceState.postgres.status = 'online';
    console.log(`[${traceId}] PostgreSQL probe success`);
  } catch (err) {
    serviceState.postgres.status = 'offline';
    console.error(`[${traceId}] PostgreSQL probe failed`, {
      message: err.message,
      stack: err.stack,
    });
  }

  try {
    console.log(`[${traceId}] Matrix PBX CTI reachability probe started`, {
      host: PBX_HOST,
      port: CTI_PORT,
    });
    const pbxProbe = await probeTcp(PBX_HOST, CTI_PORT);
    if (pbxProbe.ok) {
      serviceState.pbx.status = 'connected';
      serviceState.pbx.clientHost = PBX_HOST;
      serviceState.pbx.mode = serviceState.pbx.mode || 'server';
      serviceState.pbx.port = serviceState.pbx.port || parseInt(process.env.SMDR_PORT || '5001', 10);
      serviceState.pbx.lastConnected = serviceState.pbx.lastConnected || new Date().toISOString();
      serviceState.pbx.reachability = 'cti';
      serviceState.pbx.ctiPort = CTI_PORT;
      console.log(`[${traceId}] Matrix PBX CTI probe success`);
    } else {
      serviceState.pbx.status = 'offline';
      serviceState.pbx.clientHost = null;
      serviceState.pbx.lastDisconnected = new Date().toISOString();
      serviceState.pbx.reachability = 'cti';
      serviceState.pbx.ctiPort = CTI_PORT;
      serviceState.pbx.lastError = pbxProbe.error;
      console.warn(`[${traceId}] Matrix PBX CTI probe failed`, pbxProbe);
    }
  } catch (err) {
    serviceState.pbx.status = 'offline';
    serviceState.pbx.clientHost = null;
    serviceState.pbx.lastDisconnected = new Date().toISOString();
    serviceState.pbx.lastError = err.message;
    console.error(`[${traceId}] Matrix PBX CTI probe error`, {
      message: err.message,
      stack: err.stack,
    });
  }

  console.log(`[${traceId}] GET /api/system/status response`, serviceState);
  return res.json(serviceState);
});

// ── GET /api/system/log ───────────────────────────────────────────────────
router.get('/log', authenticate, (req, res) => {
  const rawLimit = parseInt(req.query.limit, 10);
  const limit = isNaN(rawLimit) || rawLimit <= 0
    ? 100
    : Math.min(rawLimit, 500);

  const all    = activityLog.getRecent(activityLog.size());
  const sliced = all.slice(-limit).reverse(); // newest first

  return res.json({ events: sliced, total: sliced.length });
});

// ── GET /api/system/ai-tasks/:id ──────────────────────────────────────────
router.get('/ai-tasks/:id', authenticate, async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const result = await pool.query(
      'SELECT id, status, result, error, created_at, updated_at FROM ai_tasks WHERE id = $1', 
      [taskId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Task not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/system/ai-tasks ──────────────────────────────────────────────
router.get('/ai-tasks', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, type, status, created_at FROM ai_tasks ORDER BY created_at DESC LIMIT 50'
    );
    return res.json({ tasks: result.rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/system/ai/chat ──────────────────────────────────────────────
router.post('/ai/chat', async (req, res) => {
  const fetch = require('node-fetch');
  const aiHost  = process.env.PICOCLAW_API_HOST || process.env.AI_API_HOST || 'https://api.groq.com/openai/v1';
  const aiPlan = planAIRequest(req);
  const aiModel = aiPlan.model || resolveAIModel();
  const aiToken = process.env.PICOCLAW_API_KEY || process.env.AI_API_KEY || '';
  const maxTokens = aiPlan.maxTokens;

  try {
    if (!aiToken) {
      return res.status(503).json({ error: 'AI is not configured. Set PICOCLAW_API_KEY or AI_API_KEY on the server.' });
    }

    const headers = { 'Content-Type': 'application/json' };
    if (aiToken) headers['Authorization'] = `Bearer ${aiToken}`;

    const userMessages = compactMessages(req.body.messages, aiPlan);
    
    // Inject real-time CRM context
    let emailContext = "";
    let contextData = "";

    if (aiPlan.includeCrmContext) {
      const msGraph = require('../services/msGraph');
      try {
        const [emailData, inboxInfo, sentInfo, draftsInfo, deletedInfo] = await Promise.all([
          msGraph.graphGet('/me/messages?$top=2&$select=subject,sender,bodyPreview'),
          msGraph.graphGet('/me/mailFolders/inbox').catch(() => ({ totalItemCount: 0, unreadItemCount: 0 })),
          msGraph.graphGet('/me/mailFolders/sentitems').catch(() => ({ totalItemCount: 0 })),
          msGraph.graphGet('/me/mailFolders/drafts').catch(() => ({ totalItemCount: 0 })),
          msGraph.graphGet('/me/mailFolders/deleteditems').catch(() => ({ totalItemCount: 0 }))
        ]);

        emailContext = `\nOUTLOOK MAILBOX STATISTICS:\n`;
        emailContext += `- Inbox: ${inboxInfo.totalItemCount} total, ${inboxInfo.unreadItemCount} unread\n`;
        emailContext += `- Sent Items: ${sentInfo.totalItemCount} total\n`;
        emailContext += `- Drafts: ${draftsInfo.totalItemCount} total\n`;
        emailContext += `- Deleted Items: ${deletedInfo.totalItemCount} total\n`;

        if (emailData && emailData.value) {
          emailContext += "\nRecent Outlook Emails:\n";
          emailData.value.forEach(em => {
            const sender = shortText(em.sender?.emailAddress?.name || 'Unknown', 40);
            emailContext += `- ${sender}: ${shortText(em.subject, 80)} | ${shortText(em.bodyPreview, 140)}\n`;
          });
        }
      } catch (e) {
        emailContext = "\n(Outlook Emails temporarily unavailable)\n";
      }

      const [deals, calls, contacts] = await Promise.all([
        pool.query("SELECT name, company, value, stage, due_date FROM pipeline_deals WHERE stage != 'Won' ORDER BY due_date NULLS LAST LIMIT 5"),
        pool.query("SELECT caller, ai_summary FROM call_logs WHERE ai_summary IS NOT NULL ORDER BY created_at DESC LIMIT 3"),
        pool.query("SELECT fname, lname, company, segment, notes FROM contacts WHERE notes IS NOT NULL ORDER BY created_at DESC LIMIT 3")
      ]);

      contextData = "CURRENT CRM CONTEXT:\n\nPending Pipeline Deals:\n";
      deals.rows.forEach(d => contextData += `- ${shortText(d.name, 60)} (${shortText(d.company, 50)}): ${d.value}, ${d.stage}, Due: ${d.due_date}\n`);
      contextData += "\nRecent Call Summaries (Action Items):\n";
      calls.rows.forEach(c => contextData += `- ${shortText(c.caller, 40)}: ${shortText(c.ai_summary, 160)}\n`);
      contextData += "\nKey Client Notes (WhatsApp/Contact Context):\n";
      contacts.rows.forEach(c => contextData += `- ${shortText(`${c.fname} ${c.lname}`, 50)} (${shortText(c.company, 50)}): ${shortText(c.notes, 160)}\n`);
      contextData += emailContext;
    }

    const callerSystem = typeof req.body.system === 'string' ? req.body.system.trim() : '';
    const systemPrompt = `${callerSystem || 'You are UniComm AI for Unicircuit Engineering Services LLP.'}
Token optimization and model utilization is active.
Answer clearly and completely. Keep normal answers concise, but when the user asks for a list, comparison, steps, or formats, provide the full requested list without cutting it short.
Use only the provided private CRM/email context unless the request explicitly needs current public info.
Do not show reasoning. If unsure, say what to verify.

${contextData || 'No extra CRM context injected for this optimized operation.'}`;

    const msgs = [
      { role: 'system', content: systemPrompt },
      ...userMessages
    ];

    const aiBody = {
      model: aiModel,
      messages: msgs,
      max_tokens: maxTokens,
      temperature: 0.2
    };
    if (aiPlan.needsCurrentInfo && /^groq\/compound/i.test(aiModel)) {
      aiBody.search_settings = { country: 'india' };
    }

    const parts = [];
    let finishReason = null;
    let completionMessages = msgs.slice();
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const maxContinuationRounds = 3;

    for (let round = 0; round <= maxContinuationRounds; round += 1) {
      const response = await fetch(`${aiHost}/chat/completions`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ ...aiBody, messages: completionMessages })
      });

      if (!response.ok) {
        const txt = await response.text();
        if (response.status === 401 || response.status === 403) {
          console.warn('[AI-CHAT] AI provider rejected the configured API key.');
          return res.status(503).json({ error: 'AI provider rejected the configured API key.' });
        }
        console.error('[AI-CHAT] Error from API:', txt);
        if (response.status === 429) {
          return res.status(429).json({
            error: 'AI rate limit reached. Please retry shortly.',
            retryAfter: getRetryAfterSeconds(response, txt)
          });
        }
        return res.status(503).json({ error: `API Error: ${response.status}` });
      }

      const data = await response.json();
      const choice = data.choices?.[0] || {};
      const chunk = choice.message?.content || '';
      finishReason = choice.finish_reason || null;
      if (chunk) parts.push(chunk);
      if (data.usage) {
        usage.prompt_tokens += data.usage.prompt_tokens || 0;
        usage.completion_tokens += data.usage.completion_tokens || 0;
        usage.total_tokens += data.usage.total_tokens || 0;
      }

      if (finishReason !== 'length') break;

      completionMessages = [
        ...msgs,
        { role: 'assistant', content: parts.join('\n\n') },
        { role: 'user', content: 'Continue from exactly where you stopped. Do not repeat earlier text. Finish the answer completely.' }
      ];
    }

    const reply = parts.join('\n\n').trim() || 'Sorry, I could not generate a response.';
    return res.json({
      reply,
      utilization: {
        provider: 'PicoClaw',
        operation: aiPlan.operation,
        preferredModel: aiPlan.preferredModel,
        model: aiModel,
        maxTokens,
        finishReason,
        continued: parts.length > 1,
        rounds: parts.length,
        usage,
        currentInfo: aiPlan.needsCurrentInfo
      }
    });
  } catch (err) {
    console.error('[AI-CHAT] Exception:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/system/ai/sessions ──────────────────────────────────────────────
router.post('/ai/sessions', authenticate, async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ai_chat_sessions (
      id VARCHAR(100) PRIMARY KEY,
      title VARCHAR(255),
      messages JSONB,
      messages_html TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    const { id, title, messages, messagesHtml } = req.body;
    if (!messages || messages.length === 0) {
      return res.json({ success: true, ignored: true });
    }
    await pool.query(
      `INSERT INTO ai_chat_sessions (id, title, messages, messages_html, updated_at) 
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, messages = EXCLUDED.messages, messages_html = EXCLUDED.messages_html, updated_at = NOW()`,
      [id, title, JSON.stringify(messages), messagesHtml]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[AI-SESSIONS] Error saving:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/system/ai/sessions ──────────────────────────────────────────────
router.get('/ai/sessions', authenticate, async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ai_chat_sessions (
      id VARCHAR(100) PRIMARY KEY,
      title VARCHAR(255),
      messages JSONB,
      messages_html TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    const result = await pool.query('SELECT id, title, messages, messages_html FROM ai_chat_sessions ORDER BY updated_at DESC');
    res.json({ sessions: result.rows });
  } catch (err) {
    console.error('[AI-SESSIONS] Error fetching:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const maintenance = require('../services/maintenance');

// ── POST /api/system/maintenance/reconcile-calls ─────────────────────────
router.post('/maintenance/reconcile-calls', authenticate, async (req, res) => {
  try {
    // 1. Strip VMS pilot (390) from extensions, rebuild real hop chains, attach recordings
    const vms = await maintenance.normalizeVmsExtensions(pool);
    // 2. Refresh the deduped view the dashboard reads from (so the UI reflects the changes)
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY call_logs_deduped')
      .catch(async () => { await pool.query('REFRESH MATERIALIZED VIEW call_logs_deduped').catch(e => console.warn('[Maintenance] matview refresh failed:', e.message)); });
    // 3. Reconcile CRM contact call counts
    const updated = await maintenance.reconcileCallCounts(pool);
    return res.json({
      success: true,
      message: `Reconciled ${updated} contacts · fixed ${vms.updated} call rows (390 → real extension)${vms.recCopied ? ` · ${vms.recCopied} recordings linked` : ''}.`
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.serviceState = serviceState;
module.exports = router;

/**
 * System Routes
 * GET /api/system/status  — live service health (requires auth)
 * GET /api/system/log     — recent activity log entries (requires auth)
 */
const express    = require('express');
const { authenticate } = require('../middleware/auth');
const activityLog = require('../services/activityLog');
const pool       = require('../db/pool');

const router = express.Router();

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
  // Probe PostgreSQL live with a 3000ms timeout
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('PostgreSQL probe timed out')), 3000)
      ),
    ]);
    serviceState.postgres.status = 'online';
  } catch (_) {
    serviceState.postgres.status = 'offline';
  }

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
  const aiHost  = process.env.AI_API_HOST  || 'https://api.groq.com/openai/v1';
  const aiModel = process.env.AI_API_MODEL || 'llama-3.1-8b-instant';
  const aiToken = process.env.AI_API_KEY   || '';

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (aiToken) headers['Authorization'] = `Bearer ${aiToken}`;

    // Add a system prompt if not present
    let msgs = req.body.messages || [];
    
    // Inject real-time CRM context
    const msGraph = require('../services/msGraph');
    let emailContext = "";
    try {
      const [emailData, inboxInfo, sentInfo, draftsInfo, deletedInfo] = await Promise.all([
        msGraph.graphGet('/me/messages?$top=5&$select=subject,sender,bodyPreview'),
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
          const sender = em.sender?.emailAddress?.name || 'Unknown';
          emailContext += `- From ${sender}: [${em.subject}] ${em.bodyPreview}\n`;
        });
      }
    } catch (e) {
      emailContext = "\n(Outlook Emails temporarily unavailable)\n";
    }

    const [deals, calls, contacts] = await Promise.all([
      pool.query("SELECT name, company, value, stage, due_date FROM pipeline_deals WHERE stage != 'Won'"),
      pool.query("SELECT caller, ai_summary FROM call_logs WHERE ai_summary IS NOT NULL LIMIT 5"),
      pool.query("SELECT fname, lname, company, segment, notes FROM contacts WHERE notes IS NOT NULL LIMIT 5")
    ]);

    let contextData = "CURRENT CRM CONTEXT:\n\nPending Pipeline Deals:\n";
    deals.rows.forEach(d => contextData += `- ${d.name} (${d.company}): ${d.value}, Stage: ${d.stage}, Due: ${d.due_date}\n`);
    contextData += "\nRecent Call Summaries (Action Items):\n";
    calls.rows.forEach(c => contextData += `- ${c.caller}: ${c.ai_summary}\n`);
    contextData += "\nKey Client Notes (WhatsApp/Contact Context):\n";
    contacts.rows.forEach(c => contextData += `- ${c.fname} ${c.lname} (${c.company}): ${c.notes}\n`);
    contextData += emailContext;

    const systemPrompt = `You are the UniComm AI assistant for Unicircuit Engineering Services LLP. You have access to real-time CRM data, Outlook emails, and WhatsApp logs. When asked to summarize actions or give updates, strictly use the provided context below. Keep answers extremely concise, professional, and use tabular format (Markdown tables) when summarizing data or statistics if requested.\n\n${contextData}`;

    if (msgs.length === 0 || msgs[0].role !== 'system') {
      msgs.unshift({ role: 'system', content: systemPrompt });
    } else {
      msgs[0].content = systemPrompt; // Ensure context is always fresh
    }

    const response = await fetch(`${aiHost}/chat/completions`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: aiModel,
        messages: msgs,
        max_tokens: 1000,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const txt = await response.text();
      console.error('[AI-CHAT] Error from API:', txt);
      return res.status(503).json({ error: `API Error: ${response.status}` });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';
    return res.json({ reply });
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
    const updated = await maintenance.reconcileCallCounts(pool);
    return res.json({ success: true, message: `Reconciled counts for ${updated} contacts.` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.serviceState = serviceState;
module.exports = router;

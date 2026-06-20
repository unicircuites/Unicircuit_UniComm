const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const crmSchema = require('../config/crm_schema.json');

const router = express.Router();

const LEAD_WRITABLE_COLUMNS = new Set([
  'fname', 'lname', 'company', 'designation', 'dept', 'phone', 'wa', 'email',
  'segment', 'score', 'products', 'city', 'notes', 'enrichment_status', 'tier',
  'scored', 'outreach_status', 'lead_source', 'raw_lead_json'
]);

const DEAL_WRITABLE_COLUMNS = new Set([
  'name', 'company', 'value', 'stage', 'probability', 'score', 'owner', 'due_date'
]);

const schemaReady = ensureCrmIntegrationSchema();

async function ensureCrmIntegrationSchema() {
  await pool.query(`
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enrichment_status VARCHAR(40) DEFAULT 'pending';
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tier VARCHAR(30);
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS scored BOOLEAN DEFAULT FALSE;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS outreach_status VARCHAR(40) DEFAULT 'not_started';
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lead_source VARCHAR(80);
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS raw_lead_json JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE pipeline_deals ADD COLUMN IF NOT EXISTS probability SMALLINT DEFAULT 0;

    CREATE TABLE IF NOT EXISTS crm_agent_audit (
      id SERIAL PRIMARY KEY,
      agent_id VARCHAR(120) NOT NULL,
      endpoint VARCHAR(160) NOT NULL,
      method VARCHAR(12) NOT NULL,
      payload_hash VARCHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS crm_agent_activities (
      id SERIAL PRIMARY KEY,
      lead_id INT REFERENCES contacts(id) ON DELETE CASCADE,
      deal_id INT REFERENCES pipeline_deals(id) ON DELETE SET NULL,
      agent_id VARCHAR(120),
      activity_type VARCHAR(80) NOT NULL,
      summary TEXT,
      payload JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS crm_alerts (
      id SERIAL PRIMARY KEY,
      lead_id INT REFERENCES contacts(id) ON DELETE CASCADE,
      deal_id INT REFERENCES pipeline_deals(id) ON DELETE SET NULL,
      agent_id VARCHAR(120),
      alert_type VARCHAR(80) NOT NULL,
      severity VARCHAR(30) DEFAULT 'medium',
      message TEXT NOT NULL,
      payload JSONB DEFAULT '{}'::jsonb,
      status VARCHAR(30) DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS crm_lead_blacklist (
      id SERIAL PRIMARY KEY,
      email VARCHAR(200),
      domain VARCHAR(200),
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT crm_lead_blacklist_value CHECK (email IS NOT NULL OR domain IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_email_lower
      ON contacts (LOWER(email)) WHERE email IS NOT NULL AND email <> '';
    CREATE INDEX IF NOT EXISTS idx_contacts_agent_filters
      ON contacts (enrichment_status, tier, scored, outreach_status);
    CREATE INDEX IF NOT EXISTS idx_crm_activities_lead_id
      ON crm_agent_activities (lead_id, created_at DESC);
  `);
}

function parseAgentTokens() {
  const tokens = new Map();
  const configured = String(process.env.CRM_AGENT_TOKENS || '').trim();
  for (const part of configured.split(',').map(v => v.trim()).filter(Boolean)) {
    const idx = part.indexOf(':');
    if (idx > 0) tokens.set(part.slice(idx + 1), part.slice(0, idx));
  }
  if (process.env.CRM_AGENT_TOKEN) {
    tokens.set(process.env.CRM_AGENT_TOKEN, process.env.CRM_AGENT_ID || 'default_agent');
  }
  return tokens;
}

function authenticateAgent(req, res, next) {
  const header = String(req.headers.authorization || '');
  console.log('[AUTH DEBUG] Incoming Auth Header:', header);
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const tokens = parseAgentTokens();
  if (!token || !tokens.has(token)) {
    return res.status(401).json({ error: 'Missing or invalid CRM agent bearer token.' });
  }
  req.agent = { id: tokens.get(token), token };
  return next();
}

const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.agent.id,
  message: { error: 'CRM agent rate limit exceeded.' },
});

router.use(async (_req, _res, next) => {
  try {
    await schemaReady;
    next();
  } catch (err) {
    next(err);
  }
});
router.use(authenticateAgent, agentLimiter);

function payloadHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');
}

async function auditAgentWrite(req) {
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return;
  await pool.query(
    `INSERT INTO crm_agent_audit (agent_id, endpoint, method, payload_hash)
     VALUES ($1, $2, $3, $4)`,
    [req.agent.id, req.originalUrl, req.method, payloadHash(req.body)]
  );
}

async function emitWebhook(event, entity, data) {
  const url = process.env.CRM_N8N_WEBHOOK_URL;
  if (!url) return;
  const payload = {
    event,
    entity,
    data,
    emitted_at: new Date().toISOString(),
    source: 'uni_crm_integration_layer',
  };
  axios.post(url, payload, {
    timeout: parseInt(process.env.CRM_WEBHOOK_TIMEOUT_MS || '5000', 10),
    headers: process.env.CRM_WEBHOOK_TOKEN
      ? { Authorization: `Bearer ${process.env.CRM_WEBHOOK_TOKEN}` }
      : undefined,
  }).catch(err => {
    console.warn('[CRM Integration] Webhook emit failed:', err.message);
  });
}

function initials(firstName, lastName) {
  return `${String(firstName || 'L')[0]}${String(lastName || 'D')[0]}`.toUpperCase();
}

function splitName(input) {
  const name = String(input || '').trim();
  if (!name) return { first: 'Unknown', last: 'Lead' };
  const parts = name.split(/\s+/);
  return { first: parts[0] || 'Unknown', last: parts.slice(1).join(' ') || 'Lead' };
}

function mapLeadToInternal(lead) {
  const mapping = crmSchema.entities.lead.canonicalToInternal;
  const out = {};
  for (const [canonical, internal] of Object.entries(mapping)) {
    if (Object.prototype.hasOwnProperty.call(lead, canonical) && LEAD_WRITABLE_COLUMNS.has(internal)) {
      out[internal] = lead[canonical];
    }
  }
  if (lead.full_name || lead.name) {
    const name = splitName(lead.full_name || lead.name);
    if (!out.fname) out.fname = name.first;
    if (!out.lname) out.lname = name.last;
  }
  if (!out.fname) out.fname = lead.email ? String(lead.email).split('@')[0] : 'Unknown';
  if (!out.lname) out.lname = 'Lead';
  if (!out.company) out.company = 'Unknown Company';
  if (!out.segment) out.segment = 'Prospect';
  if (out.score === undefined || out.score === null || out.score === '') out.score = 50;
  if (out.scored === undefined && out.score !== undefined) out.scored = true;
  if (!out.raw_lead_json) out.raw_lead_json = lead.raw || lead;
  return out;
}

function mapLeadToCanonical(row) {
  return {
    id: row.id,
    first_name: row.fname,
    last_name: row.lname,
    company: row.company,
    title: row.designation,
    department: row.dept,
    phone: row.phone,
    whatsapp: row.wa,
    email: row.email,
    city: row.city,
    segment: row.segment,
    score: row.score,
    products: row.products,
    notes: row.notes,
    enrichment_status: row.enrichment_status,
    tier: row.tier,
    scored: row.scored,
    outreach_status: row.outreach_status,
    source: row.lead_source,
    raw: row.raw_lead_json,
    created_at: row.created_at,
  };
}

function mapDealToCanonical(row) {
  return {
    id: row.id,
    name: row.name,
    company: row.company,
    value: row.value,
    stage: row.stage,
    probability: row.probability,
    score: row.score,
    owner: row.owner,
    due_date: row.due_date,
    created_at: row.created_at,
  };
}

function buildUpdate(tableAlias, input, allowedColumns, mapping) {
  const sets = [];
  const values = [];
  for (const [canonical, value] of Object.entries(input)) {
    const col = mapping[canonical] || canonical;
    if (!allowedColumns.has(col)) continue;
    values.push(value);
    sets.push(`${col} = $${values.length}`);
  }
  if (!sets.length) return null;
  return { sql: sets.join(', '), values };
}

async function insertLead(lead) {
  const data = mapLeadToInternal(lead);
  data.initials = initials(data.fname, data.lname);
  const email = String(data.email || '').trim().toLowerCase();

  if (email) {
    const existing = await pool.query(`SELECT * FROM contacts WHERE LOWER(email) = $1 LIMIT 1`, [email]);
    if (existing.rowCount) {
      const update = buildUpdate('contacts', lead, LEAD_WRITABLE_COLUMNS, crmSchema.entities.lead.canonicalToInternal);
      if (!update) return { action: 'unchanged', row: existing.rows[0] };
      update.values.push(existing.rows[0].id);
      const result = await pool.query(
        `UPDATE contacts SET ${update.sql} WHERE id = $${update.values.length} RETURNING *`,
        update.values
      );
      return { action: 'updated', row: result.rows[0] };
    }
  }

  const columns = Object.keys(data).filter(col => LEAD_WRITABLE_COLUMNS.has(col) || col === 'initials');
  const values = columns.map(col => data[col]);
  const placeholders = values.map((_, idx) => `$${idx + 1}`);
  const result = await pool.query(
    `INSERT INTO contacts (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    values
  );
  return { action: 'created', row: result.rows[0] };
}

function pagination(req) {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 500);
  const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
  return { limit, offset };
}

router.post('/leads/batch', async (req, res, next) => {
  try {
    const leads = Array.isArray(req.body) ? req.body : req.body.leads;
    if (!Array.isArray(leads)) return res.status(400).json({ error: 'Expected leads array.' });
    await auditAgentWrite(req);
    const results = [];
    for (const lead of leads) {
      const result = await insertLead(lead || {});
      results.push({ action: result.action, lead: mapLeadToCanonical(result.row) });
      if (result.action === 'created') emitWebhook('lead_created', 'lead', mapLeadToCanonical(result.row));
    }
    return res.status(207).json({ count: results.length, results });
  } catch (err) {
    next(err);
  }
});

router.get('/leads', async (req, res, next) => {
  try {
    const { limit, offset } = pagination(req);
    const filters = [];
    const values = [];
    for (const key of ['enrichment_status', 'tier', 'outreach_status']) {
      if (req.query[key]) {
        values.push(req.query[key]);
        filters.push(`${key} = $${values.length}`);
      }
    }
    if (req.query.scored !== undefined) {
      values.push(String(req.query.scored) === 'true');
      filters.push(`scored = $${values.length}`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    values.push(limit, offset);
    const result = await pool.query(
      `SELECT * FROM contacts ${where} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return res.json({ data: result.rows.map(mapLeadToCanonical), limit, offset });
  } catch (err) {
    next(err);
  }
});

router.patch('/leads/:id', async (req, res, next) => {
  try {
    const before = await pool.query(`SELECT * FROM contacts WHERE id = $1`, [req.params.id]);
    if (!before.rowCount) return res.status(404).json({ error: 'Lead not found.' });
    const update = buildUpdate('contacts', req.body, LEAD_WRITABLE_COLUMNS, crmSchema.entities.lead.canonicalToInternal);
    if (!update) return res.status(400).json({ error: 'No writable lead fields provided.' });
    await auditAgentWrite(req);
    update.values.push(req.params.id);
    const result = await pool.query(
      `UPDATE contacts SET ${update.sql} WHERE id = $${update.values.length} RETURNING *`,
      update.values
    );
    const row = result.rows[0];
    if (before.rows[0].tier !== row.tier) emitWebhook('lead_tier_changed', 'lead', mapLeadToCanonical(row));
    if (before.rows[0].segment !== 'Client' && row.segment === 'Client') emitWebhook('customer_created', 'customer', mapLeadToCanonical(row));
    return res.json(mapLeadToCanonical(row));
  } catch (err) {
    next(err);
  }
});

router.post('/activities', async (req, res, next) => {
  try {
    const activityType = req.body.type || req.body.activity_type;
    if (!activityType) return res.status(400).json({ error: 'Activity type is required.' });
    await auditAgentWrite(req);
    const result = await pool.query(
      `INSERT INTO crm_agent_activities (lead_id, deal_id, agent_id, activity_type, summary, payload)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.body.lead_id || null, req.body.deal_id || null, req.agent.id, activityType, req.body.summary || null, req.body.payload || req.body]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/activities', async (req, res, next) => {
  try {
    if (!req.query.lead_id) return res.status(400).json({ error: 'lead_id query param is required.' });
    const { limit, offset } = pagination(req);
    const result = await pool.query(
      `SELECT * FROM crm_agent_activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.query.lead_id, limit, offset]
    );
    return res.json({ data: result.rows, limit, offset });
  } catch (err) {
    next(err);
  }
});

router.post('/deals', async (req, res, next) => {
  try {
    if (!req.body.name) return res.status(400).json({ error: 'Deal name is required.' });
    await auditAgentWrite(req);
    const result = await pool.query(
      `INSERT INTO pipeline_deals (name, company, value, stage, probability, score, owner, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        req.body.name,
        req.body.company || null,
        req.body.value || null,
        req.body.stage || 'Prospect',
        req.body.probability || 0,
        req.body.score || 50,
        req.body.owner || null,
        req.body.due_date || null,
      ]
    );
    return res.status(201).json(mapDealToCanonical(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

router.patch('/deals/:id', async (req, res, next) => {
  try {
    const before = await pool.query(`SELECT * FROM pipeline_deals WHERE id = $1`, [req.params.id]);
    if (!before.rowCount) return res.status(404).json({ error: 'Deal not found.' });
    const update = buildUpdate('pipeline_deals', req.body, DEAL_WRITABLE_COLUMNS, crmSchema.entities.deal.canonicalToInternal);
    if (!update) return res.status(400).json({ error: 'No writable deal fields provided.' });
    await auditAgentWrite(req);
    update.values.push(req.params.id);
    const result = await pool.query(
      `UPDATE pipeline_deals SET ${update.sql} WHERE id = $${update.values.length} RETURNING *`,
      update.values
    );
    const row = result.rows[0];
    if (before.rows[0].stage !== row.stage) emitWebhook('deal_stage_changed', 'deal', mapDealToCanonical(row));
    return res.json(mapDealToCanonical(row));
  } catch (err) {
    next(err);
  }
});

router.get('/deals/stats', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM pipeline_deals) AS total_deals,
        (SELECT COALESCE(SUM(NULLIF(REGEXP_REPLACE(value, '[^0-9.]', '', 'g'), '')::numeric), 0)::float FROM pipeline_deals) AS numeric_pipeline_value,
        COALESCE(jsonb_object_agg(stage, count), '{}'::jsonb) AS by_stage
      FROM (SELECT stage, COUNT(*)::int AS count FROM pipeline_deals GROUP BY stage) s
    `);
    return res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/leads/stats', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM contacts) AS total_leads,
        (SELECT COUNT(*)::int FROM contacts WHERE enrichment_status = 'complete') AS enriched,
        (SELECT COUNT(*)::int FROM contacts WHERE scored IS TRUE) AS scored,
        COALESCE(jsonb_object_agg(tier_name, count), '{}'::jsonb) AS by_tier
      FROM (SELECT COALESCE(tier, 'unassigned') AS tier_name, COUNT(*)::int AS count FROM contacts GROUP BY COALESCE(tier, 'unassigned')) s
    `);
    return res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/customers/health-summary', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total_customers,
        COALESCE(AVG(score), 0)::float AS average_health_score,
        COUNT(*) FILTER (WHERE score < 40)::int AS at_risk_customers,
        COUNT(*) FILTER (WHERE score >= 70)::int AS healthy_customers
      FROM contacts
      WHERE segment IN ('Client', 'Customer')
    `);
    return res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/customers/:id/health', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, fname, lname, company, email, score, last_contact, notes
       FROM contacts WHERE id = $1 AND segment IN ('Client', 'Customer')`,
      [req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Customer not found.' });
    const row = result.rows[0];
    return res.json({
      customer_id: row.id,
      name: `${row.fname || ''} ${row.lname || ''}`.trim(),
      company: row.company,
      email: row.email,
      health_score: row.score || 0,
      status: (row.score || 0) < 40 ? 'at_risk' : (row.score || 0) >= 70 ? 'healthy' : 'watch',
      last_contact: row.last_contact,
      notes: row.notes,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/alerts', async (req, res, next) => {
  try {
    if (!req.body.message) return res.status(400).json({ error: 'Alert message is required.' });
    await auditAgentWrite(req);
    const result = await pool.query(
      `INSERT INTO crm_alerts (lead_id, deal_id, agent_id, alert_type, severity, message, payload, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        req.body.lead_id || null,
        req.body.deal_id || null,
        req.agent.id,
        req.body.type || req.body.alert_type || 'human_review',
        req.body.severity || 'medium',
        req.body.message,
        req.body.payload || req.body,
        req.body.status || 'open',
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/leads/blacklist', async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT email, domain, reason, created_at FROM crm_lead_blacklist ORDER BY created_at DESC`
    );
    return res.json({
      emails: result.rows.filter(r => r.email).map(r => ({ email: r.email, reason: r.reason })),
      domains: result.rows.filter(r => r.domain).map(r => ({ domain: r.domain, reason: r.reason })),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/leads/:id', async (req, res, next) => {
  try {
    await auditAgentWrite(req);
    const result = await pool.query(`DELETE FROM contacts WHERE id = $1 RETURNING id, email`, [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Lead not found.' });
    return res.json({ deleted: true, id: result.rows[0].id, email: result.rows[0].email || null });
  } catch (err) {
    next(err);
  }
});

// ── SCREEN SCRAPER ROUTES ───────────────────────────────────────────────────
const scraperService = require('../services/scraperService');

router.post('/scraper/start', async (req, res, next) => {
  try {
    const sessionId = req.body.sessionId || 'session_' + Date.now();
    const session = await scraperService.startScrape(sessionId, req.body);
    return res.status(200).json(session);
  } catch (err) {
    next(err);
  }
});

router.post('/scraper/stop', async (req, res, next) => {
  try {
    const sessionId = req.body.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });
    const session = scraperService.stopScrape(sessionId);
    if (!session) return res.status(404).json({ error: 'Scraper session not found.' });
    return res.json(session);
  } catch (err) {
    next(err);
  }
});

router.get('/scraper/status', async (req, res, next) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });
    const session = scraperService.getScrapeStatus(sessionId);
    if (!session) return res.status(404).json({ error: 'Scraper session not found.' });
    return res.json(session);
  } catch (err) {
    next(err);
  }
});

router.post('/scraper/upload-html', async (req, res, next) => {
  try {
    const { html, fields, options } = req.body;
    if (!html) return res.status(400).json({ error: 'html content is required.' });
    const fieldsArr = Array.isArray(fields) ? fields : (fields || 'name,email').split(',').map(f => f.trim()).filter(Boolean);
    const parsed = scraperService.parseLocalHTML(html, fieldsArr, options || {});
    return res.json(parsed);
  } catch (err) {
    next(err);
  }
});

router.post('/scraper/analyze', async (req, res, next) => {
  try {
    const { url, cookies } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required.' });
    const analysis = await scraperService.analyzeURL(url, cookies);
    return res.json(analysis);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

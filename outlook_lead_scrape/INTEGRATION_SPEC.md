# Integration Specification — Base44 Outlook Lead Model ↔ UniComm CRM

## Overview

The Base44 module plugs into the **Node.js backend only**. No frontend changes.

```
outlook_lead_scrape/module/
├── leadBrain.js              ← classification + extraction logic
├── outlookLeadScrapeService.js ← scheduler + orchestration
├── leadDedup.js              ← dedup helpers
├── ensureTables.js           ← idempotency table migration
├── package.json
├── README_MODULE.md
└── test/
```

---

## Injection Point 1: Server Startup

**File**: `backend/server.js`  
**Where**: After `automatedAI.start(io)` block (or alongside other background services)  
**Code**:

```javascript
const outlookLeadScrape = require('../outlook_lead_scrape/module/outlookLeadScrapeService');

// Start after DB is ready (inside existing startup block)
if (process.env.OUTLOOK_LEAD_SCRAPE_ENABLED !== 'false') {
  outlookLeadScrape.start(io, parseInt(process.env.OUTLOOK_LEAD_SCRAPE_INTERVAL_MIN || '5', 10));
}
```

---

## Injection Point 2: Mail Sync Event

**File**: `backend/server.js`  
**Where**: Inside `else if (event === 'outlook:mail_synced')` handler  
**Code**:

```javascript
const outlookLeadScrape = require('../outlook_lead_scrape/module/outlookLeadScrapeService');
outlookLeadScrape.runOnce({ trigger: 'mail_synced', count: data?.count }).catch(() => {});
```

---

## Injection Point 3: Optional Manual API Route

**File**: `backend/routes/outlook.js` (minimal addition)  
**Endpoint**: `POST /api/outlook/scrape-leads`  
**Purpose**: Manual trigger from existing admin tooling (not a new UI page)

```javascript
const outlookLeadScrape = require('../../outlook_lead_scrape/module/outlookLeadScrapeService');

router.post('/scrape-leads', async (req, res) => {
  try {
    const result = await outlookLeadScrape.runOnce({ trigger: 'manual', ...req.body });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
```

---

## Required Module Exports

### `leadBrain.js`

```javascript
/** Returns { isLead, confidence, reason, category } */
function classifyLeadEmail(emailSnapshot) { }

/** Returns { lead_name, subject, notes, contact_phone, contact_tags, lead_date, lead_time, confidence, extraction_meta } */
async function extractLeadFields(emailSnapshot, fullBodyText) { }

/** Rule-only fast path — no AI */
function classifyAndExtractRulesOnly(emailSnapshot, fullBodyText) { }
```

### `outlookLeadScrapeService.js`

```javascript
function start(io, intervalMinutes) { }
function stop() { }
async function runOnce(options) { }  // { trigger, maxEmails, sinceHours }
```

### `ensureTables.js`

```javascript
async function ensureOutlookLeadProcessedTable() { }
```

Creates:

```sql
CREATE TABLE IF NOT EXISTS outlook_lead_processed (
  message_id    TEXT PRIMARY KEY,
  lead_id       INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  confidence    NUMERIC(4,3),
  status        VARCHAR(20) NOT NULL,  -- 'inserted' | 'skipped' | 'duplicate' | 'rejected' | 'error'
  reason        TEXT,
  processed_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outlook_lead_processed_at ON outlook_lead_processed (processed_at DESC);
```

---

## Internal Dependencies (require paths from module)

| Module | Path | Use |
|---|---|---|
| PostgreSQL pool | `require('../../backend/db/pool')` | Read cache + write leads |
| MS Graph | `require('../../backend/services/msGraph')` | Full message body fetch |
| Ollama/Groq | `require('../../backend/services/ollamaService')` | Optional AI extraction fallback |
| Activity log | `require('../../backend/services/activityLog')` | Log scrape runs |

**Do NOT** call `/api/calls/leads` over HTTP — write via `pool.query` INSERT.

---

## Environment Variables

```env
OUTLOOK_LEAD_SCRAPE_ENABLED=true
OUTLOOK_LEAD_SCRAPE_INTERVAL_MIN=5
OUTLOOK_LEAD_SCRAPE_MAX_EMAILS=50
OUTLOOK_LEAD_SCRAPE_SINCE_HOURS=72
OUTLOOK_LEAD_SCRAPE_MIN_CONFIDENCE=0.75
OUTLOOK_LEAD_SCRAPE_USE_AI=true
MS_USER_EMAIL=sales@unicircuites.com
```

---

## Socket.IO Events (emit from service)

```javascript
io.emit('leads:updated', { source: 'outlook_scrape', inserted: n, skipped: m });
```

Existing dashboard already calls `loadLeads()` on nav — optional future hook; **no frontend work required now**.

---

## `runOnce()` Return Schema

```json
{
  "success": true,
  "trigger": "mail_synced",
  "scanned": 42,
  "candidates": 8,
  "inserted": 3,
  "skipped": 4,
  "duplicates": 1,
  "errors": 0,
  "duration_ms": 1240,
  "leads": [{ "id": 101, "lead_name": "Rahul Sharma", "message_id": "AAMk..." }]
}
```

---

## Performance Budget

| Metric | Limit |
|---|---|
| Single `runOnce` duration | < 30 sec |
| AI calls per run | ≤ 10 (only when rules insufficient) |
| DB queries per email | ≤ 3 |
| Memory | < 100 MB |

---

## Error Handling

- Graph auth failure → log + return `{ success: false, error: 'NOT_AUTHENTICATED' }`, do not crash server
- Single email parse failure → log + continue batch
- DB insert failure → record in `outlook_lead_processed` with `status='error'`

---

## Files That Should NOT Change

- `dashboard.html` — **no changes**
- `scraperService.js` — **not used**
- `emailAnalyzer.js` — **leave as-is** (different feature)

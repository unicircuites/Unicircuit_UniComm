# BASE44 MASTER PROMPT
## Outlook Lead Scrape Model (Brain + Service) — UniComm Pro CRM

> **Send this entire prompt to Base44 to generate the model.**
> After generation, place the output in the `outlook_lead_scrape/module/` subfolder
> and send the complete `outlook_lead_scrape/` folder back to the AI agent.
>
> **DO NOT build any frontend, HTML, dashboard, or UI components.**

---

## ═══════════════════════════════════════════════════
## SYSTEM CONTEXT — WHO ARE YOU BUILDING FOR
## ═══════════════════════════════════════════════════

You are building an **Outlook email lead extraction system** (brain + background service) for **UniComm Pro** —
a proprietary CRM used by **Unicircuit Engineering Services LLP**,
an Indian electronics/engineering company in Mumbai.

The CRM already:
- Syncs Outlook inbox mail into PostgreSQL (`outlook_emails_cache` table — **mail snapshots**)
- Has a `leads` table and CRUD API at `/api/calls/leads`
- Categorizes some emails as `LEAD` via keyword rules in `/api/outlook/categorize`
- Displays leads in the existing dashboard (already built — **you must not touch it**)

**The business goal**: Automatically detect buyer/sales inquiry emails from mail snapshots,
extract accurate structured lead data (name, phone, product, notes), and insert into the `leads` table —
with zero duplicate entries and high precision (no spam/OTP/newsletter false positives).

---

## ═══════════════════════════════════════════════════
## PROBLEM STATEMENT — WHAT NEEDS TO BE SOLVED
## ═══════════════════════════════════════════════════

### GAP 1 — Mail Snapshots Exist But Leads Are Manual
`outlook_emails_cache` stores every synced inbox message (subject, from, body_preview, timestamps).
Sales staff must **manually** open the Lead Tracker and copy details from emails.
This is slow and leads are lost.

### GAP 2 — Coarse LEAD Category Is Not Enough
Existing keyword categorization (`indiamart`, `enquiry`, `quotation`, etc.) only **labels** emails.
It does not extract phone numbers, buyer names, or product requirements, and produces false positives.

### GAP 3 — No Idempotent Auto-Insert Pipeline
There is no service that:
1. Reads unprocessed mail snapshots
2. Decides if email is a real sales lead
3. Extracts fields precisely
4. Deduplicates against existing leads
5. Inserts into `leads` with `platform = 'outlook'`
6. Marks message as processed so it is never inserted twice

**Your deliverable closes all three gaps.**

---

## ═══════════════════════════════════════════════════
## ARCHITECTURE — BRAIN + SERVICE (TWO PARTS)
## ═══════════════════════════════════════════════════

You must generate **two cooperating Node.js modules**:

### Part A — `leadBrain.js` (The Brain)
Pure logic. No timers. Stateless functions:
- **Classify**: Is this mail snapshot a sales lead?
- **Extract**: Pull structured fields from snapshot + optional full body
- **Score**: Confidence 0.0–1.0
- **Reject**: Explain why non-leads were skipped

**Strategy: Rules first, AI second.**
1. Run deterministic rules (fast, free, reproducible) — see `LEAD_DETECTION_RULES.md`
2. Only if rules are ambiguous (`confidence 0.50–0.74`), call Groq via existing `ollamaService` (max 1 short prompt per email)
3. Never call AI for obvious non-leads (OTP, noreply newsletters)

### Part B — `outlookLeadScrapeService.js` (The Service)
Background worker:
- `start(io, intervalMinutes)` — periodic scheduler
- `stop()` — clean shutdown
- `runOnce(options)` — single pass: query DB → brain → insert → log

Triggered by:
- Timer (default every 5 min)
- `outlook:mail_synced` event (wired by integrator)
- Manual `POST /api/outlook/scrape-leads` (optional route)

---

## ═══════════════════════════════════════════════════
## INPUT DATA — MAIL SNAPSHOTS
## ═══════════════════════════════════════════════════

### Primary Source: `outlook_emails_cache`

Query pattern the service must use:

```sql
SELECT
  id, conversation_id, subject, from_address, from_name,
  to_recipients, received_datetime, body_preview, has_attachments,
  importance, folder, category, is_read
FROM outlook_emails_cache
WHERE folder = 'inbox'
  AND received_datetime >= NOW() - INTERVAL '<since_hours> hours'
  AND id NOT IN (SELECT message_id FROM outlook_lead_processed)
ORDER BY received_datetime DESC
LIMIT <max_emails>;
```

### Mail Snapshot Object Shape (normalize to this internally)

```javascript
{
  id: 'AAMkAGI2...',           // Graph message ID
  conversation_id: 'AAQkAGI2...',
  subject: 'New Enquiry for Biometric Machine',
  from_address: 'buyer@example.com',
  from_name: 'Rahul Sharma',
  body_preview: 'Dear Sir, I need biometric...',
  received_datetime: '2026-06-29T10:30:00.000Z',
  has_attachments: false,
  importance: 'normal',
  is_read: false,
  folder: 'inbox'
}
```

### Full Body Fetch (When Preview Insufficient)

If `body_preview` lacks phone/product after rule extraction, fetch full body:

```javascript
const graph = require('../../backend/services/msGraph');
const MS_EMAIL = process.env.MS_USER_EMAIL;
// GET /me/messages/{id}?$select=body,subject,from,receivedDateTime
const data = await graph.graphGet(
  `/me/messages/${encodeURIComponent(messageId)}?$select=body,subject,from,receivedDateTime`,
  MS_EMAIL
);
const fullBodyText = stripHtml(data.body?.content || '');
```

Implement `stripHtml()` locally (regex or lightweight, no cheerio unless already in project).

---

## ═══════════════════════════════════════════════════
## OUTPUT DATA — LEADS TABLE (IMMUTABLE SCHEMA)
## ═══════════════════════════════════════════════════

### Required INSERT (via PostgreSQL pool — NOT HTTP)

```sql
INSERT INTO leads (
  lead_name, subject, notes, platform, lead_date, lead_time,
  contact_phone, contact_tags, created_by
) VALUES ($1, $2, $3, 'outlook', $4, $5, $6, $7, NULL)
RETURNING *;
```

| Field | Rule |
|---|---|
| `lead_name` | **Required**. VARCHAR(200). Buyer name or `Name — Product` format |
| `subject` | Email subject, max 300 chars |
| `notes` | Structured summary + source message ID + body excerpt (see LEAD_DETECTION_RULES.md) |
| `platform` | Always `'outlook'` |
| `lead_date` | DATE from `received_datetime` |
| `lead_time` | TIME from `received_datetime` |
| `contact_phone` | 10-digit Indian mobile or NULL |
| `contact_tags` | TEXT[] e.g. `['outlook','auto-scrape','indiamart','msg:AAMk...']` |

### Idempotency Table (You Must Create)

```sql
CREATE TABLE IF NOT EXISTS outlook_lead_processed (
  message_id    TEXT PRIMARY KEY,
  lead_id       INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  confidence    NUMERIC(4,3),
  status        VARCHAR(20) NOT NULL,
  reason        TEXT,
  processed_at  TIMESTAMPTZ DEFAULT NOW()
);
```

Always record outcome — even for rejected/skipped emails — so they are never reprocessed.

---

## ═══════════════════════════════════════════════════
## BRAIN LOGIC — CLASSIFICATION & EXTRACTION
## ═══════════════════════════════════════════════════

### Step 1: Hard Reject (Before Any AI)

Immediately reject with `confidence = 0` if:
- Subject/body matches OTP, verification, password reset, login alert
- Sender is `noreply@` / `no-reply@` AND no buyer contact block in body
- Sender domain is internal: `@unicircuites.com`, `@unicircuites.live`
- Subject contains: `newsletter`, `unsubscribe`, `your order has been shipped` (without new inquiry)
- Folder is not `inbox` (skip sent/drafts/junk unless explicitly configured)

### Step 2: Rule-Based Lead Signals (High Precision)

**Tier 1 — Definite Lead** (confidence 0.90+):
- Sender domain: `indiamart.com`, `tradeindia.com`, `exportersindia.com`
- Body contains labeled buyer block: `Name:`, `Mobile:`, `Phone:`, `Product:`, `Requirement:`
- Subject: `New Enquiry`, `Buyer Details`, `Lead from IndiaMART`

**Tier 2 — Probable Lead** (confidence 0.70–0.89):
- Keywords: `quotation`, `enquiry`, `inquiry`, `interested in`, `want to purchase`, `rate`, `price`
- PLUS product domain term: `biometric`, `CCTV`, `attendance`, `access control`, etc.

**Tier 3 — Weak Signal** (confidence 0.50–0.69):
- Single generic keyword only (`order`, `purchase`) without product context
- → Try AI extraction OR reject if AI also uncertain

### Step 3: Field Extraction

#### Phone Extraction (India)
```javascript
// Match 10-digit mobiles starting 6-9
// Handle: +91-98765-43210, 91 9876543210, M:9876543210
function extractIndianMobile(text) {
  // Return normalized 10-digit string or null
}
```

#### Name Extraction
Priority:
1. Labeled fields in body (`Name:`, `Contact Person:`, `Buyer:`)
2. `from_name` if it looks like a person (not "IndiaMART" or "Sales Team")
3. Company + product pattern: `Gupta ji — Biometric Machine`

#### Product / Requirement
Extract sentence or phrase containing domain product keywords.
IndiaMART emails often have `Product:` line — parse that first.

### Step 4: AI Fallback (Optional, Budget-Limited)

Use only when `0.50 <= confidence < 0.75` after rules:

```javascript
const prompt = `Extract sales lead fields from this email. Return ONLY valid JSON:
{"is_lead":true,"lead_name":"...","contact_phone":"10digits or null","product":"...","confidence":0.0-1.0,"reason":"..."}
If not a sales lead, return {"is_lead":false,"confidence":0.0,"reason":"..."}

Email:
From: ${from_name} <${from_address}>
Subject: ${subject}
Body: ${bodyText.slice(0, 2000)}`;
```

Call via `ollamaService.callOllamaService(prompt, [])` — uses Groq when `AI_API_KEY` is set.
If AI fails, fall back to rule-only result (do not crash).

**Max 10 AI calls per `runOnce` batch** — remaining emails defer to next run.

### Step 5: Deduplication

Before INSERT, check:
1. `outlook_lead_processed.message_id` — skip if exists
2. Existing lead: same `phone_norm(contact_phone)` + similar subject within 14 days
3. Same `from_address` + exact `subject` within 7 days

Use PostgreSQL `phone_norm()` function (already exists in DB).

If duplicate but new phone found → UPDATE existing lead's `contact_phone` and append to `notes`.
Record `status = 'duplicate'` in processed table.

### Step 6: Insert Threshold

| Condition | Action |
|---|---|
| `confidence >= 0.75` | INSERT |
| `confidence >= 0.60` AND sender is Tier-1 portal domain | INSERT |
| `confidence < 0.60` | SKIP — record `status = 'rejected'` |
| Duplicate detected | SKIP — record `status = 'duplicate'` |

---

## ═══════════════════════════════════════════════════
## TECHNICAL SPECIFICATIONS
## ═══════════════════════════════════════════════════

### Runtime Environment
| Property | Value |
|---|---|
| Platform | Windows Server, Node.js 18+ |
| Language | **JavaScript only** (no TypeScript, no Python) |
| Database | PostgreSQL via `pg` pool |
| Mail API | Microsoft Graph (existing `msGraph.js` service) |
| AI API | Groq via `ollamaService.js` (optional, env-gated) |
| Auth | Service uses DB pool directly — no JWT needed |

### Existing Project Tools You MUST Use
| Tool | Path | Purpose |
|---|---|---|
| PostgreSQL pool | `backend/db/pool.js` | Read mail cache, write leads |
| MS Graph client | `backend/services/msGraph.js` | Full message body |
| Ollama/Groq service | `backend/services/ollamaService.js` | AI extraction fallback |
| Activity log | `backend/services/activityLog.js` | Log scrape summary |
| Lead keyword list | `backend/routes/outlook.js` categorize route | Seed for Tier-2 rules |
| Email preprocessor | `backend/services/emailPreprocessor.js` | Reuse `calculatePriorityScore` for candidate ranking |

### Lightweight Addition You MAY Add (Not Overburdening)
| Addition | Purpose |
|---|---|
| `outlook_lead_processed` table | Idempotency — **required** |
| `POST /api/outlook/scrape-leads` route | Manual trigger — **optional, 15 lines** |
| Env vars (6 keys) | Configuration — see INTEGRATION_SPEC.md |
| Socket emit `leads:updated` | Notify connected clients — **optional** |

### Tools You Must NOT Add
- ❌ Playwright / Puppeteer / web scraper
- ❌ New frontend pages or dashboard changes
- ❌ Separate microservice or Docker container
- ❌ Redis / message queue
- ❌ Heavy NLP libraries (spaCy, etc.)
- ❌ Python subprocesses

---

## ═══════════════════════════════════════════════════
## REQUIRED MODULE EXPORTS
## ═══════════════════════════════════════════════════

### `leadBrain.js`
```javascript
module.exports = {
  classifyLeadEmail,        // (snapshot) → { isLead, confidence, reason, tier }
  extractLeadFields,        // async (snapshot, fullBody?) → lead payload
  classifyAndExtractRulesOnly, // sync fast path
  extractIndianMobile,      // (text) → string|null
  stripHtml,                // (html) → plain text
};
```

### `outlookLeadScrapeService.js`
```javascript
module.exports = {
  start,    // (io, intervalMinutes) → void
  stop,     // () → void
  runOnce,  // async (options) → result summary object
};
```

### `leadDedup.js`
```javascript
module.exports = {
  isAlreadyProcessed,       // (messageId) → boolean
  findDuplicateLead,        // async (phone, subject, fromAddress) → lead row|null
  recordProcessed,          // async (messageId, status, leadId, confidence, reason)
};
```

### `ensureTables.js`
```javascript
module.exports = { ensureOutlookLeadProcessedTable };
```

---

## ═══════════════════════════════════════════════════
## SERVICE BEHAVIOR — `runOnce()` FLOW
## ═══════════════════════════════════════════════════

```
1. ensureOutlookLeadProcessedTable()
2. Load config from env (maxEmails, sinceHours, minConfidence, useAi)
3. Query unprocessed mail snapshots from outlook_emails_cache
4. Pre-rank by priority (unread + importance + lead keywords in preview)
5. For each snapshot:
   a. classifyLeadEmail(snapshot)
   b. If hard reject → recordProcessed('rejected') → continue
   c. If needs full body → fetch from Graph → stripHtml
   d. extractLeadFields(snapshot, body)
   e. If confidence < threshold → recordProcessed('rejected') → continue
   f. findDuplicateLead() → if dup → recordProcessed('duplicate') → continue
   g. INSERT into leads → recordProcessed('inserted', leadId)
6. activityLog.append({ type: 'info', service: 'outlook_lead_scrape', message: summary })
7. io?.emit('leads:updated', { inserted, skipped })
8. Return summary JSON
```

### Concurrency Lock
Use `let isRunning = false` — skip if previous `runOnce` still active (same pattern as `automatedAI.js`).

### Logging Prefix
All logs: `[OutlookLeadScrape]`

---

## ═══════════════════════════════════════════════════
## EXAMPLE TRANSFORMATIONS
## ═══════════════════════════════════════════════════

### Example 1 — IndiaMART Enquiry

**Input snapshot:**
```
subject: "New Enquiry for Biometric Attendance Machine"
from_name: "IndiaMART"
from_address: "leads@indiamart.com"
body_preview: "Buyer: Rahul Sharma | Mobile: +91-98765-43210 | City: Pune | Product: Biometric Machine..."
```

**Output lead:**
```json
{
  "lead_name": "Rahul Sharma",
  "subject": "New Enquiry for Biometric Attendance Machine",
  "contact_phone": "9876543210",
  "platform": "outlook",
  "contact_tags": ["outlook", "auto-scrape", "indiamart", "msg:AAMkAGI2..."],
  "notes": "Source: outlook | Product: Biometric Attendance Machine | Location: Pune | Confidence: high — IndiaMART buyer block\n---\nBuyer: Rahul Sharma | Mobile: +91-98765-43210..."
}
```

### Example 2 — Direct Buyer Email (Reject OTP)

**Input:**
```
subject: "Your OTP for login is 847291"
from_address: "noreply@indiamart.com"
```

**Output:** `status: 'rejected'`, `reason: 'OTP/system message'`, no lead inserted.

### Example 3 — Quotation Request

**Input:**
```
subject: "Requirement for CCTV installation"
from_name: "Gupta ji"
from_address: "gupta.construction@gmail.com"
body_preview: "Sir, hume 16 channel DVR aur 12 camera chahiye. Please quotation bhejiye. Call 98200 12345"
```

**Output lead:**
```json
{
  "lead_name": "Gupta ji",
  "subject": "Requirement for CCTV installation",
  "contact_phone": "9820012345",
  "notes": "Source: outlook | Product: 16 channel DVR, 12 cameras | Confidence: high — quotation request with phone"
}
```

---

## ═══════════════════════════════════════════════════
## DELIVERABLES REQUIRED FROM BASE44
## ═══════════════════════════════════════════════════

Generate the following inside `outlook_lead_scrape/module/`:

### 1. `leadBrain.js`
Classification + extraction brain. Rules-first, AI-fallback.

### 2. `outlookLeadScrapeService.js`
Background service with `start`, `stop`, `runOnce`.

### 3. `leadDedup.js`
Idempotency + duplicate detection helpers.

### 4. `ensureTables.js`
Creates `outlook_lead_processed` table on first run.

### 5. `package.json`
Only if new npm deps needed (prefer zero new deps). Pin exact versions.

### 6. `README_MODULE.md`
- Install / env vars
- How integrator wires into `server.js`
- How to test manually: `node -e "require('./outlookLeadScrapeService').runOnce({trigger:'test'})"`

### 7. `test/` directory
Node.js built-in `assert` tests:
- `test_classify.js` — OTP rejected, IndiaMART accepted
- `test_extract_phone.js` — all Indian phone formats
- `test_dedup.js` — duplicate detection
- `test_insert_payload.js` — field mapping validation

---

## ═══════════════════════════════════════════════════
## CONSTRAINTS & NON-GOALS
## ═══════════════════════════════════════════════════

### Must NOT do:
- ❌ Build any frontend, HTML, CSS, or dashboard UI
- ❌ Modify `dashboard.html`
- ❌ Change the `leads` table schema (use existing columns only)
- ❌ Use HTTP to call `/api/calls/leads` (use pool directly)
- ❌ Process sent/drafts/junk folders by default
- ❌ Insert leads with confidence < 0.60 (except Tier-1 portals at ≥ 0.60)
- ❌ Use Python or compiled native addons
- ❌ Spawn external processes

### Must DO:
- ✅ Work on Windows Server (Node.js 18+)
- ✅ Be callable from `server.js` startup and event hooks
- ✅ Handle `NOT_AUTHENTICATED` Graph errors gracefully
- ✅ Record every processed message in `outlook_lead_processed`
- ✅ Set `platform = 'outlook'` on every inserted lead
- ✅ Log with `[OutlookLeadScrape]` prefix
- ✅ Be stateless between runs (except DB + lock flag)
- ✅ Complete `runOnce` within 30 seconds for 50 emails

---

## ═══════════════════════════════════════════════════
## HOW THIS INTEGRATES INTO THE EXISTING SYSTEM
## ═══════════════════════════════════════════════════

Read these companion files in the `outlook_lead_scrape/` folder:

| File | Content |
|---|---|
| `CURRENT_PIPELINE.md` | Existing Outlook cache + leads flow |
| `LEAD_DETECTION_RULES.md` | Domain rules for Unicircuit |
| `INTEGRATION_SPEC.md` | Exact `server.js` injection points |

The integrator agent will:
1. Drop your `module/` output into `outlook_lead_scrape/module/`
2. Add ~10 lines to `backend/server.js` to start the service
3. Optionally add `POST /api/outlook/scrape-leads` route
4. **No frontend changes**

---

## ═══════════════════════════════════════════════════
## SUCCESS CRITERIA
## ═══════════════════════════════════════════════════

Your model is successful when:

1. IndiaMART / TradeIndia enquiry emails auto-create leads with correct name + phone
2. OTP / newsletter / internal emails are **never** inserted
3. The same email is **never** processed twice (idempotency table)
4. Duplicate leads (same phone + subject) are not created within 14 days
5. `runOnce()` returns accurate counts: `{ scanned, inserted, skipped, duplicates, rejected }`
6. Service runs unattended on a 5-minute interval without memory leaks
7. Zero frontend code is generated

---

*End of BASE44 Master Prompt — UniComm Pro Outlook Lead Scrape Model*

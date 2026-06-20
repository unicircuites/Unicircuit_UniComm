# Phase 1 Point 1: CRM Integration Layer

## What Was Added

The CRM Integration Layer is now implemented in the `UNI_CRM` backend as an Express REST API wrapper.

It exposes a standardized agent-facing CRM API at:

```text
/api/crm
```

All agents should use this API instead of writing directly to the CRM database.

## Files Added Or Updated

```text
backend/routes/crmIntegration.js
backend/config/crm_schema.json
backend/server.js
backend/.env.example
```

## Tools And Stack Used

```text
Runtime: Node.js
Framework: Express
Database: PostgreSQL
DB access: pg Pool
Auth: Bearer token per agent
Rate limiting: express-rate-limit
Webhook delivery: axios
Field mapping: backend/config/crm_schema.json
Audit logging: PostgreSQL crm_agent_audit table
Webhook router target: n8n webhook URL
```

## Main Purpose

The CRM Integration Layer decouples all agents from the internal CRM database schema.

Instead of agents knowing that leads are stored in the `contacts` table with fields like `fname`, `lname`, `wa`, and `segment`, agents use canonical names like:

```json
{
  "first_name": "Amit",
  "last_name": "Sharma",
  "email": "amit@example.com",
  "company": "Example Industries",
  "tier": "A",
  "enrichment_status": "complete"
}
```

The middleware translates this into the internal CRM schema using:

```text
backend/config/crm_schema.json
```

## Authentication

Agents authenticate using a bearer token.

Add tokens in `backend/.env`:

```env
CRM_AGENT_TOKENS=lead_miner:replace_with_long_random_token,enrichment_agent:replace_with_long_random_token
```

Format:

```text
agent_id:token
```

Example:

```env
CRM_AGENT_TOKENS=lead_miner:lm_123456,enrichment_agent:enrich_789012
```

Then requests must include:

```http
Authorization: Bearer lm_123456
```

For local testing, you can also use:

```env
CRM_AGENT_TOKEN=test_token_123
CRM_AGENT_ID=local_test_agent
```

## n8n Webhook Configuration

The CRM Integration Layer can emit webhook events to n8n.

Add this to `backend/.env`:

```env
CRM_N8N_WEBHOOK_URL=http://localhost:5678/webhook/crm-events
CRM_WEBHOOK_TOKEN=
CRM_WEBHOOK_TIMEOUT_MS=5000
```

If your n8n webhook requires a token:

```env
CRM_WEBHOOK_TOKEN=your_n8n_webhook_token
```

The CRM layer emits these events:

```text
lead_created
lead_tier_changed
deal_stage_changed
customer_created
```

Webhook payload format:

```json
{
  "event": "lead_created",
  "entity": "lead",
  "data": {
    "id": 101,
    "first_name": "Amit",
    "last_name": "Sharma",
    "email": "amit@example.com"
  },
  "emitted_at": "2026-06-19T10:30:00.000Z",
  "source": "uni_crm_integration_layer"
}
```

Webhook delivery is best-effort. If n8n is down, the CRM write still succeeds and the backend logs a warning.

## Canonical Endpoints Added

Base path:

```text
http://localhost:8088/api/crm
```

### 1. Bulk Create Leads

```http
POST /api/crm/leads/batch
```

Creates or updates leads in bulk. It is idempotent by email.

### 2. Query Leads

```http
GET /api/crm/leads
```

Supports filters:

```text
enrichment_status
tier
scored
outreach_status
limit
offset
```

### 3. Update Lead

```http
PATCH /api/crm/leads/{id}
```

Partial update for lead fields.

### 4. Create Activity

```http
POST /api/crm/activities
```

Logs agent activity such as:

```text
email_sent
call_completed
linkedin_message_sent
qualification_completed
```

### 5. Fetch Lead Activity

```http
GET /api/crm/activities?lead_id={id}
```

Returns interaction history for one lead.

### 6. Create Deal

```http
POST /api/crm/deals
```

Creates a pipeline deal.

### 7. Update Deal

```http
PATCH /api/crm/deals/{id}
```

Updates deal fields such as:

```text
stage
probability
value
owner
due_date
```

### 8. Deal Stats

```http
GET /api/crm/deals/stats
```

Returns aggregate pipeline metrics.

### 9. Lead Stats

```http
GET /api/crm/leads/stats
```

Returns aggregate lead funnel metrics.

### 10. Customer Health Summary

```http
GET /api/crm/customers/health-summary
```

Returns fleet-wide customer health metrics.

### 11. Individual Customer Health

```http
GET /api/crm/customers/{id}/health
```

Returns one customer health score.

### 12. Create Alert

```http
POST /api/crm/alerts
```

Creates an internal human-review alert.

### 13. Lead Blacklist

```http
GET /api/crm/leads/blacklist
```

Returns blacklisted domains and emails for Lead Miner.

### 14. GDPR Lead Delete

```http
DELETE /api/crm/leads/{id}
```

Deletes the lead and cascades related CRM agent activities and alerts.

## How It Works Internally

### Request Flow

```text
Agent
  -> /api/crm endpoint
  -> Bearer token authentication
  -> Per-agent rate limit check
  -> Canonical field mapping
  -> PostgreSQL write/read
  -> Audit log entry for writes
  -> Optional n8n webhook event
  -> JSON response back to agent
```

### Field Mapping

The field mapping lives here:

```text
backend/config/crm_schema.json
```

Example mapping:

```json
{
  "first_name": "fname",
  "last_name": "lname",
  "title": "designation",
  "whatsapp": "wa",
  "source": "lead_source",
  "raw": "raw_lead_json"
}
```

### Self-Healing Database Setup

When the CRM route loads, it ensures these columns/tables exist:

```text
contacts.enrichment_status
contacts.tier
contacts.scored
contacts.outreach_status
contacts.lead_source
contacts.raw_lead_json
pipeline_deals.probability
crm_agent_audit
crm_agent_activities
crm_alerts
crm_lead_blacklist
```

This means you do not need to manually create these support tables before first run.

## How It Works In Terminal

### 1. Open Backend Folder

```powershell
cd "C:\Users\unius\Documents\code workout\UNI_CRM\backend"
```

### 2. Configure Environment

Open:

```text
backend/.env
```

Add:

```env
CRM_AGENT_TOKENS=lead_miner:lm_123456,enrichment_agent:enrich_789012
CRM_N8N_WEBHOOK_URL=http://localhost:5678/webhook/crm-events
CRM_WEBHOOK_TIMEOUT_MS=5000
```

### 3. Start Backend

```powershell
npm start
```

Or in development:

```powershell
npm run dev
```

### 4. Check Backend Health

```powershell
Invoke-RestMethod -Method GET -Uri "http://localhost:8088/api/health"
```

Expected response:

```json
{
  "status": "ok",
  "service": "UniComm Pro API"
}
```

### 5. Test Lead Creation

```powershell
$headers = @{
  Authorization = "Bearer lm_123456"
  "Content-Type" = "application/json"
}

$body = @{
  leads = @(
    @{
      first_name = "Amit"
      last_name = "Sharma"
      company = "Example Industries"
      email = "amit.sharma@example.com"
      phone = "+91 9876543210"
      title = "Purchase Manager"
      city = "Mumbai"
      tier = "A"
      enrichment_status = "complete"
      source = "Clay"
      raw = @{
        linkedin = "https://linkedin.com/in/example"
        provider = "Clay"
      }
    }
  )
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Method POST `
  -Uri "http://localhost:8088/api/crm/leads/batch" `
  -Headers $headers `
  -Body $body
```

Expected result:

```json
{
  "count": 1,
  "results": [
    {
      "action": "created",
      "lead": {
        "first_name": "Amit",
        "last_name": "Sharma",
        "email": "amit.sharma@example.com"
      }
    }
  ]
}
```

### 6. Test Lead Query

```powershell
Invoke-RestMethod `
  -Method GET `
  -Uri "http://localhost:8088/api/crm/leads?tier=A&enrichment_status=complete" `
  -Headers $headers
```

### 7. Test Lead Update

Replace `1` with the lead ID returned from creation:

```powershell
$body = @{
  tier = "B"
  outreach_status = "ready_for_review"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method PATCH `
  -Uri "http://localhost:8088/api/crm/leads/1" `
  -Headers $headers `
  -Body $body
```

This emits:

```text
lead_tier_changed
```

### 8. Test Activity Logging

```powershell
$body = @{
  lead_id = 1
  type = "email_sent"
  summary = "Intro email generated by Email Outreach Agent"
  payload = @{
    campaign = "week_1_test"
    subject = "Electrical panels requirement"
  }
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Method POST `
  -Uri "http://localhost:8088/api/crm/activities" `
  -Headers $headers `
  -Body $body
```

### 9. Test Deal Creation

```powershell
$body = @{
  name = "Example Industries - MCC Panel"
  company = "Example Industries"
  value = "250000"
  stage = "Qualified"
  probability = 40
  score = 75
  owner = "Sales Team"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method POST `
  -Uri "http://localhost:8088/api/crm/deals" `
  -Headers $headers `
  -Body $body
```

### 10. Test Stats

```powershell
Invoke-RestMethod -Method GET -Uri "http://localhost:8088/api/crm/leads/stats" -Headers $headers
Invoke-RestMethod -Method GET -Uri "http://localhost:8088/api/crm/deals/stats" -Headers $headers
```

## How It Works In The Web Application

The existing web application continues to use its normal CRM screens and routes.

The new CRM Integration Layer does not replace the existing UI. It sits beside it as an agent-facing API.

### Existing App UI

The current app still works through:

```text
http://localhost:8088
```

Main CRM records are still stored in the same internal tables:

```text
contacts
pipeline_deals
```

So when an agent creates a lead through:

```text
POST /api/crm/leads/batch
```

that lead is inserted into the existing `contacts` table.

Result:

```text
Agent-created leads become visible in the CRM contact/lead area of the app.
```

When an agent creates or updates a deal through:

```text
POST /api/crm/deals
PATCH /api/crm/deals/{id}
```

that deal is stored in:

```text
pipeline_deals
```

Result:

```text
Agent-created deals become visible in the pipeline/deals area of the app.
```

### Human Review Workflow

Agents can create human-review alerts with:

```text
POST /api/crm/alerts
```

These are stored in:

```text
crm_alerts
```

This gives the backend a queue for cases such as:

```text
Low confidence enrichment
Email needs manual approval
High-value lead needs human review
Bad data detected
```

At this stage, the alert table is backend-ready. A dedicated UI screen for `crm_alerts` can be added later if needed.

## How n8n Fits In

n8n acts as the webhook router and workflow orchestrator.

Recommended n8n flow:

```text
CRM Integration Layer
  -> n8n Webhook Trigger
  -> Switch by event name
  -> Route to agent workflow
  -> Agent calls back into /api/crm
```

Example event routing:

```text
lead_created
  -> Enrichment Agent
  -> Qualification Agent
  -> Update lead via PATCH /api/crm/leads/{id}

lead_tier_changed
  -> Email Outreach Agent
  -> Create alert if manual review required

deal_stage_changed
  -> Analytics Agent
  -> Sales follow-up workflow

customer_created
  -> Nurture Agent
  -> Onboarding workflow
```

## How To Test With n8n

### 1. Start n8n

Example:

```powershell
npx n8n
```

Or if using Docker:

```powershell
docker run -it --rm `
  --name n8n `
  -p 5678:5678 `
  n8nio/n8n
```

### 2. Create A Webhook Workflow

In n8n:

```text
1. Add Webhook Trigger node
2. Method: POST
3. Path: crm-events
4. Save workflow
5. Copy production/test webhook URL
```

Example URL:

```text
http://localhost:5678/webhook-test/crm-events
```

Put it in `backend/.env`:

```env
CRM_N8N_WEBHOOK_URL=http://localhost:5678/webhook-test/crm-events
```

Restart the backend after changing `.env`.

### 3. Trigger Event

Create a lead:

```powershell
Invoke-RestMethod `
  -Method POST `
  -Uri "http://localhost:8088/api/crm/leads/batch" `
  -Headers $headers `
  -Body $body
```

Expected:

```text
n8n receives a lead_created event.
```

## Database Tables Used

Existing tables:

```text
contacts
pipeline_deals
```

New support tables:

```text
crm_agent_audit
crm_agent_activities
crm_alerts
crm_lead_blacklist
```

New columns added automatically:

```text
contacts.enrichment_status
contacts.tier
contacts.scored
contacts.outreach_status
contacts.lead_source
contacts.raw_lead_json
pipeline_deals.probability
```

## Audit Logging

Every agent write creates an audit record.

Tracked fields:

```text
agent_id
endpoint
method
payload_hash
created_at
```

The payload hash is stored instead of the full request body to reduce sensitive-data exposure while still allowing traceability.

## Rate Limiting

Each authenticated agent token is limited to:

```text
100 requests per minute
```

This prevents runaway agent loops from flooding the CRM.

## Expected End-To-End Flow

Example Week 1 flow:

```text
Lead Miner Agent
  -> gets leads from Clay / PhantomBuster / Scrapin.io
  -> enriches with PDL / Hunter / ZeroBounce
  -> POST /api/crm/leads/batch

CRM Integration Layer
  -> maps canonical fields to CRM fields
  -> writes to contacts
  -> logs audit entry
  -> emits lead_created to n8n

n8n
  -> receives lead_created
  -> routes to Enrichment / Qualification workflow

Qualification Agent
  -> PATCH /api/crm/leads/{id}
  -> updates tier, score, enrichment_status

CRM Integration Layer
  -> emits lead_tier_changed if tier changed

Email Outreach Agent
  -> reads ready leads
  -> creates alert for manual review gate
  -> logs email_sent activity after approval
```

## Quick Test Checklist

Use this checklist to verify it is working:

```text
[ ] Backend starts without errors
[ ] /api/health returns status ok
[ ] Request without bearer token returns 401
[ ] Request with valid bearer token succeeds
[ ] POST /api/crm/leads/batch creates a lead
[ ] Reposting same email updates instead of duplicating
[ ] GET /api/crm/leads returns the lead
[ ] PATCH /api/crm/leads/{id} updates tier/outreach status
[ ] POST /api/crm/activities creates activity
[ ] GET /api/crm/activities?lead_id={id} returns activity
[ ] POST /api/crm/deals creates deal
[ ] PATCH /api/crm/deals/{id} updates deal stage
[ ] GET /api/crm/leads/stats returns metrics
[ ] GET /api/crm/deals/stats returns metrics
[ ] n8n receives lead_created webhook if CRM_N8N_WEBHOOK_URL is set
[ ] crm_agent_audit receives write audit rows
```

## Common Errors

### 401 Missing Or Invalid Token

Cause:

```text
Authorization header missing or token not present in CRM_AGENT_TOKENS.
```

Fix:

```text
Check backend/.env and restart backend.
```

### 429 Rate Limit Exceeded

Cause:

```text
Agent sent more than 100 requests in 1 minute.
```

Fix:

```text
Slow the agent loop or batch requests.
```

### n8n Does Not Receive Events

Check:

```text
CRM_N8N_WEBHOOK_URL is set
n8n workflow is active or listening in test mode
backend was restarted after .env change
firewall or port 5678 is not blocked
```

### Lead Not Visible In App

Check:

```text
Lead was inserted into contacts
Company field exists or defaulted to Unknown Company
The app contact list filters are not hiding Prospect segment
```

## Security Notes

Production recommendations:

```text
Use long random bearer tokens
Rotate tokens every 90 days
Store tokens in a secrets manager where possible
Use HTTPS behind Nginx
Restrict CRM API access by network/IP if possible
Do not expose /api/crm publicly without authentication
Review crm_agent_audit regularly
```

## Current Status

```text
Status: Implemented
Backend route: /api/crm
Syntax check: Passed
Ready for local testing: Yes
Ready for n8n connection: Yes, after CRM_N8N_WEBHOOK_URL is configured
```

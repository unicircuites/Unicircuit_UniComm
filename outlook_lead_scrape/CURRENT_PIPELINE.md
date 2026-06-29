# Current Pipeline — Outlook Mail → Leads

## Overview

```
Microsoft Graph API
       │
       ▼
GET /api/outlook/inbox  ──► storeMessagesInDB()
       │                         │
       │                         ▼
       │              outlook_emails_cache (PostgreSQL)
       │                         │
GET /api/outlook/categorize ──────┤  (keyword-based LEAD category)
       │                         │
       ▼                         ▼
  Dashboard UI              [GAP: no auto-insert into leads table]
                                   │
                                   ▼
                         leads table (manual via dashboard only)
```

## Mail Snapshot Source (`outlook_emails_cache`)

Every inbox sync stores a **mail snapshot** (header + preview) in PostgreSQL:

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Microsoft Graph message ID |
| `conversation_id` | TEXT | Thread ID |
| `subject` | TEXT | Email subject |
| `from_address` | TEXT | Sender email |
| `from_name` | TEXT | Sender display name |
| `to_recipients` | JSONB | Recipients array |
| `cc_recipients` | JSONB | CC array |
| `received_datetime` | TIMESTAMPTZ | When received |
| `sent_datetime` | TIMESTAMPTZ | When sent |
| `is_read` | BOOLEAN | Read flag |
| `body_preview` | TEXT | First ~255 chars of body (snapshot text) |
| `has_attachments` | BOOLEAN | Attachment flag |
| `importance` | TEXT | `low` / `normal` / `high` |
| `folder` | TEXT | Default `inbox` |
| `category` | TEXT | Default `GENERAL` |
| `synced_at` | TIMESTAMPTZ | Last cache update |

**Optional AI columns** (if migration ran):

- `ai_analyzed_at`, `ai_cleanup_recommended`, `ai_priority_score`, `ai_detected_intent`, `ai_detected_sentiment`

## Existing LEAD Categorization (Rule-Based)

`GET /api/outlook/categorize` in `backend/routes/outlook.js` flags emails as `LEAD` when subject/body/from contain:

`indiamart`, `buyer`, `enquiry`, `inquiry`, `quotation`, `quote request`, `product inquiry`, `business opportunity`, `interested in`, `purchase`, `order`

This is a **coarse filter** — many false positives and missed structured fields. The Base44 model must go further: extract name, phone, product, and write to `leads`.

## Leads Table Schema

Created/managed in `backend/routes/calls.js`:

```sql
CREATE TABLE leads (
  id            SERIAL PRIMARY KEY,
  lead_name     VARCHAR(200) NOT NULL,
  subject       VARCHAR(300),
  notes         TEXT,
  platform      VARCHAR(50) DEFAULT 'pbx',   -- use 'outlook' for email leads
  lead_date     DATE,
  lead_time     TIME,
  contact_phone VARCHAR(50),
  contact_tags  TEXT[],
  created_by    INTEGER,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
```

## Existing Leads API (JWT-protected)

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/calls/leads` | List all leads |
| GET | `/api/calls/leads/:id` | Single lead |
| POST | `/api/calls/leads` | Create lead |
| PUT | `/api/calls/leads/:id` | Update lead |
| DELETE | `/api/calls/leads/:id` | Delete lead |

**Important**: The scrape service must write to PostgreSQL **directly via `pool`**, not via HTTP (avoids JWT).

## Full Message Body (When Preview Is Insufficient)

`GET /api/outlook/message/:id` fetches full HTML/text body from Graph (or cache fallback).

The service module should call `msGraph` directly (same as the route) when `body_preview` lacks phone/product details.

## Trigger Events

- `outlook:mail_synced` — emitted in `backend/server.js` when new mail is synced
- Periodic interval (recommended: every 5 minutes, configurable via env)

## Related Services (Do Not Duplicate)

| Service | Role |
|---|---|
| `emailAnalyzer.js` | AI email intelligence (priority, sentiment) — **not** lead extraction |
| `automatedAI.js` | Background AI analysis scheduler — **separate concern** |
| `emailPreprocessor.js` | Priority scoring — **reuse scoring logic**, don't fork |
| `scraperService.js` | Website scraping — **out of scope** |

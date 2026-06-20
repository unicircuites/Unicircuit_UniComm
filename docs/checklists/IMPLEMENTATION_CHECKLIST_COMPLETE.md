# UniComm Pro — Complete Implementation Checklist
**Unicircuit Engineering Services LLP**
Generated: 2026-06-08

---

## SYSTEM OVERVIEW

```
Browser (login.html / dashboard.html)
        │  JWT Auth + REST + Socket.IO
        ▼
Express Server (port 8088, HTTP/HTTPS)
        │
        ├── PostgreSQL (pg pool)
        ├── WhatsApp (Baileys @whiskeysockets)
        ├── Outlook/Exchange (MS Graph OAuth2)
        ├── PBX Matrix SMDR (TCP socket)
        ├── AI (Ollama local + Groq API)
        ├── Email Broadcast (nodemailer SMTP)
        └── EngageBay CRM (REST proxy)
```

---

## ✅ MODULE 1 — AUTHENTICATION

### Flow
```
User → POST /api/auth/login
     → bcrypt.compare(password, hash)
     → JWT signed (24h)
     → stored in localStorage
     → all subsequent requests: Authorization: Bearer <token>
     → middleware/auth.js verifies JWT
```

### Checklist
- [x] Login page (`login.html`) with email/password form
- [x] Offline mode (demo credentials work without backend)
- [x] JWT generation on login (`jsonwebtoken`)
- [x] Password hashing (`bcryptjs`)
- [x] Role-based user model (admin/user)
- [x] `last_login` timestamp updated on each login
- [x] Audit log entry on login/logout
- [x] `is_active` flag check — disabled accounts blocked
- [x] `GET /api/auth/me` — current user info
- [x] `POST /api/auth/logout` — audit trail entry
- [x] JWT middleware on all protected routes
- [x] Rate limiting (`express-rate-limit`)

---

## ✅ MODULE 2 — DASHBOARD

### Flow
```
Dashboard load → GET /api/dashboard/stats
              → parallel DB queries:
                 ├── contacts count + new this week
                 ├── calls count + today + last 7 days
                 ├── WA chat count + unread
                 ├── campaigns count
                 ├── pipeline deals count + total value
                 └── outlook synced emails count
              → KPI cards rendered
              → Socket.IO: real-time updates push
```

### Checklist
- [x] KPI cards: Contacts, Calls, WhatsApp Chats, Campaigns, Pipeline, Emails
- [x] New-this-week badge on contacts
- [x] Today's calls counter
- [x] Unread WhatsApp count
- [x] Pipeline total value (₹)
- [x] Real-time activity feed via Socket.IO
- [x] System health status display

---

## ✅ MODULE 3 — PBX CALL LOGS

### Flow
```
Matrix SMDR PBX ──TCP──► matrixSmdr.js service
                           │  parse SMDR packet (CSV/fixed-width)
                           │  INSERT INTO call_logs
                           │  io.emit('pbx:new_call', data)
                           ▼
                    Browser receives live call event
                         │
                    GET /api/calls  (paginated + filtered)
                    GET /api/calls/pbx-status
                    GET /api/calls/recordings
```

### Checklist
- [x] TCP SMDR listener (`matrixSmdr.js`) connects to PBX host:port
- [x] Auto-reconnect on disconnect (3-state: disconnected/connecting/connected)
- [x] SMDR packet parser (Matrix Sarvam UCS format)
- [x] Call logs stored in PostgreSQL `call_logs` table
- [x] Real-time push via Socket.IO `pbx:new_call`
- [x] Paginated call log API with filters (date, extension, direction)
- [x] PBX status endpoint (`/api/calls/pbx-status`)
- [x] PBX contacts phonebook (save/lookup extension names)
- [x] Per-contact call history view
- [x] AI call summary (`PATCH /api/calls/:id/summary`)
- [x] Recording file linker (`recordingLinker.js`) — links WAV files to call records
- [x] Recording file serve (no auth required for playback)
- [x] Backup/restore call logs (JSON snapshots)
- [x] Manual PBX sync trigger
- [x] CSV export of call logs
- [x] `matrixSmdrControl.js` — start/stop/status control
- [x] `matrixBackup.js` route — Matrix VMS backup management

---

## ✅ MODULE 4 — EMAIL / OUTLOOK

### Flow
```
User → GET /api/outlook/auth → OAuth2 URL (MS Graph)
     → Azure AD → callback /auth/callback
     → tokens stored in DB/memory
     → GET /api/outlook/inbox  → Graph API → emails
     → emails cached in outlook_emails_cache table
     → GET /api/outlook/message/:id → full body + attachments
     → POST /api/outlook/send → Graph API send
     → POST /api/outlook/reply/:id → thread reply
```

### Checklist
- [x] MS Graph OAuth2 flow (MSAL node)
- [x] OAuth callback handler (`/auth/callback`)
- [x] Inbox fetch with pagination
- [x] Full message body (HTML + text + uniqueBody)
- [x] Attachment list + inline attachment download
- [x] Thread/conversation view (`/api/outlook/thread`)
- [x] Send new email
- [x] Reply to message (thread reply)
- [x] Mark read / move / categorize (`PATCH`)
- [x] Sent items folder
- [x] Folder list
- [x] Outlook contacts directory (People folder)
- [x] Contact mail stats (sent/received per contact)
- [x] Import Outlook contacts → CRM contacts
- [x] Directory activity stats (broadcasts, mail history)
- [x] Email cache table (`outlook_emails_cache`)
- [x] Mail store service (`outlookMailStore.js`)
- [x] Stats cache (`outlookStatsCache.js`)
- [x] Outlook backups (JSON snapshots of mail data)
- [x] Mail reply tasks (`mailTasks.js` route) — assign emails as tasks
- [x] Task notification via WhatsApp (`taskNotifier.js`)

---

## ✅ MODULE 5 — WHATSAPP BUSINESS

### Flow
```
Server start → Baileys connectToWhatsApp()
             → QR code generated → io.emit('wa:qr', qrData)
             → User scans QR → connected
             → io.emit('wa:ready', phone)
             │
Incoming msg → wa_chats table updated
             → wa_messages table updated
             → io.emit('wa:message', msg)
             │
Send msg → POST /api/whatsapp/send
         → wa.sendMessage(jid, content)
```

### Checklist
- [x] Baileys WA connection with QR scan
- [x] Auth persistence (`wa_auth/` folder with creds.json)
- [x] Connection status events: `wa:qr`, `wa:ready`, `wa:disconnect`
- [x] Incoming message handler → DB store
- [x] Chat list with unread counts (`wa_chats` table)
- [x] Message history per chat (`wa_messages` table)
- [x] Send text message
- [x] Send media (image/video/document)
- [x] LID ↔ phone number mapping (`lid-mapping-*.json`)
- [x] Group support (group chats stored)
- [x] Media download + serve (`wa_media/` folder)
- [x] WA backup system (`wa_backups/`)
- [x] WA inventory service (contact/group lists)
- [x] Message search
- [x] Bulk WA broadcast via campaigns
- [x] WA purge script (`wa_purge_all.js`)
- [x] Message banners data (`messageBanners.js`)
- [x] Phone number validation (LID filter, international format)
- [x] Format display phone (+91 XXXXXXXXXX)

---

## ✅ MODULE 6 — CONTACTS

### Flow
```
GET /api/contacts  → SELECT from contacts table
POST /api/contacts → INSERT contact
PUT /api/contacts/:id → UPDATE
DELETE /api/contacts/:id → DELETE (soft/hard)
                    │
                    ├── Sync to Outlook contacts (Graph API)
                    ├── Import from Outlook
                    └── Export CSV
```

### Checklist
- [x] CRUD contacts (create, read, update, delete)
- [x] Contact fields: name, email, phone, company, designation, lead score, WA number
- [x] Outlook sync (push CRM contact → Outlook People)
- [x] Import from Outlook contacts
- [x] Contact search + filter
- [x] Lead scoring field
- [x] Email broadcast count per contact
- [x] Activity log per contact
- [x] Pagination
- [x] EngageBay CRM sync (`/api/eb/contacts`)

---

## ✅ MODULE 7 — SALES PIPELINE

### Flow
```
GET /api/pipeline → deals ordered by score DESC
POST /api/pipeline → new deal (name, company, value, stage, score, owner, due_date)
PUT /api/pipeline/:id → update stage/value
DELETE /api/pipeline/:id → remove deal
```

### Stages: Prospect → Qualified → Proposal → Negotiation → Won/Lost

### Checklist
- [x] Pipeline deals CRUD
- [x] Stage management (Prospect, Qualified, Proposal, Negotiation, Won, Lost)
- [x] Deal value (₹) tracking
- [x] Lead score (0-100)
- [x] Owner assignment
- [x] Due date
- [x] Sort by score + created_at
- [x] Total pipeline value calculation

---

## ✅ MODULE 8 — MARKETING SUITE

### Sub-modules:

#### 8A — Email Broadcast
```
Create broadcast → select template + recipients (group/manual)
                → POST /api/broadcast
                → emailBroadcast.js → nodemailer SMTP
                → rate-limited sending (send_interval_ms)
                → delivery tracking (deliveries JSONB)
                → status: draft → sending → sent/failed
```
- [x] Create/send email broadcast
- [x] Template variable substitution (`emailTemplateVars.js`)
- [x] Recipient groups (`recipient_groups` + `recipient_group_members`)
- [x] SMTP test endpoint
- [x] Delivery tracking per recipient
- [x] Bounce/fail tracking
- [x] From email override
- [x] File attachments support
- [x] A/B subject test fields
- [x] Send interval throttle (avoid spam)
- [x] Broadcast list with status

#### 8B — Email Templates
```
GET /api/templates → list all templates
POST /api/templates → create template (HTML body)
PUT /api/templates/:id → update
DELETE /api/templates/:id → delete
```
- [x] HTML email templates CRUD
- [x] Template categories
- [x] Variable fields definition (per-template merge fields)
- [x] Banner config (image headers)
- [x] Slug-based lookup
- [x] Seed templates on first run
- [x] Marquee GIF generation (`/api/marquee/gif`) via `gif-encoder-2`

#### 8C — Campaigns
```
POST /api/campaigns → schedule campaign (name, segment, channel, scheduled_at)
                   → marketingCron.js picks up scheduled campaigns
                   → executes at scheduled time
```
- [x] Campaign CRUD (name, product, segment, channel, status, goal)
- [x] Schedule campaigns with timezone support
- [x] Marketing cron service (`marketingCron.js`)
- [x] Open rate / CTR / bounce / unsubscribe tracking fields
- [x] A/B testing fields
- [x] Recipient group assignment
- [x] Email + WhatsApp channel support

#### 8D — Marketing Analytics Snapshots
- [x] Manual snapshot entry (email stats, landing page stats, OTO stats)
- [x] Broadcast performance tracking
- [x] GET/POST marketing snapshots

#### 8E — Recipient Groups
- [x] Create/delete/update groups
- [x] Add/remove contacts from groups
- [x] List group members

---

## ✅ MODULE 9 — AI ASSISTANT

### Flow
```
User asks question → POST /api/ai/ask (or via system route)
                  → ollamaService.js (local Ollama)
                    OR Groq API (cloud fallback)
                  → response streamed back
                  │
Auto AI → automatedAI.js runs on schedule
        → analyzes call logs / emails
        → generates summaries
        → aiTaskQueue.js manages queue
        → aiWorker.js processes tasks
```

### Checklist
- [x] Ollama integration (local LLM, `ollamaService.js`)
- [x] Groq API fallback (cloud LLM)
- [x] AI call summary generation (per call record)
- [x] Automated AI service (`automatedAI.js`) — background analysis
- [x] AI task queue (`aiTaskQueue.js`)
- [x] AI worker (`aiWorker.js`) — async processing
- [x] Email analyzer (`emailAnalyzer.js`) — analyze incoming emails
- [x] Email preprocessor (`emailPreprocessor.js`)
- [x] Model selection (env-configurable: Groq compound-mini / llama-3.1-8b)

---

## ✅ MODULE 10 — ANALYTICS

### Checklist
- [x] Dashboard KPI stats aggregation
- [x] Call analytics (total, today, 7-day, by direction)
- [x] Email performance metrics (open rate, CTR, bounce)
- [x] Marketing snapshot charts
- [x] Pipeline value analytics
- [x] WhatsApp chat metrics

---

## ✅ MODULE 11 — SYSTEM / INFRASTRUCTURE

### Checklist
- [x] System status endpoint (`GET /api/system/status`)
  - DB connection health
  - WA connection status
  - SMDR/PBX connection status
  - AI model status
  - Outlook OAuth status
- [x] Activity log (`activityLog.js`) — DB-persisted event stream
- [x] Activity monitor (`activityMonitor.js`)
- [x] Socket.IO real-time bridge (WA, PBX events → browser)
- [x] Rate limiting (express-rate-limit)
- [x] Security check on startup (`securityCheck.js`)
- [x] Input validation middleware (`inputValidation.js`)
- [x] CORS configuration
- [x] HTTP + HTTPS (SSL/TLS via self-signed cert)
- [x] Self-healing DB schema (ALTER TABLE IF NOT EXISTS)
- [x] UTF-8 JSON responses
- [x] Maintenance service (`maintenance.js`) — cleanup cron jobs
- [x] node-cron scheduled tasks
- [x] PM2-ready (ecosystem config implied)
- [x] Tower deployment (192.168.0.205) support
- [x] EngageBay CRM integration (`engagebay.js` service + route)

---

## DATABASE TABLES

| Table | Purpose |
|---|---|
| `users` | Login accounts |
| `contacts` | CRM contacts |
| `pipeline_deals` | Sales pipeline |
| `call_logs` | PBX call records |
| `campaigns` | Marketing campaigns |
| `audit_log` | Login/logout/CRUD trail |
| `outlook_emails_cache` | Cached Outlook inbox messages |
| `email_broadcasts` | Broadcast jobs + delivery tracking |
| `email_templates` | Reusable HTML templates |
| `recipient_groups` | Named contact groups |
| `recipient_group_members` | Group ↔ contact mapping |
| `mail_reply_tasks` | Email reply task assignments |
| `marketing_snapshots` | Marketing KPI snapshots |
| `marketing_broadcasts` | Broadcast performance data |
| `wa_chats` | WhatsApp chat list per account |
| `wa_messages` | Individual WA messages |

---

## API ROUTE SUMMARY

| Route prefix | File | Description |
|---|---|---|
| `/api/auth` | routes/auth.js | Login, logout, me |
| `/api/dashboard` | routes/dashboard.js | KPI stats |
| `/api/calls` | routes/calls.js | PBX call logs + recordings |
| `/api/contacts` | routes/contacts.js | CRM contacts CRUD |
| `/api/pipeline` | routes/pipeline.js | Sales pipeline deals |
| `/api/whatsapp` | routes/whatsapp.js | WA chats, messages, send |
| `/api/outlook` | routes/outlook.js | Outlook email + contacts |
| `/api/broadcast` | routes/broadcast.js | Email broadcasts |
| `/api/templates` | routes/emailTemplates.js | Email templates |
| `/api/groups` | routes/recipientGroups.js | Recipient groups |
| `/api/campaigns` | routes/campaigns.js | Marketing campaigns |
| `/api/marketing` | routes/marketing.js | Marketing snapshots |
| `/api/marquee` | routes/marquee.js | Animated GIF marquee |
| `/api/system` | routes/system.js | Health + activity log |
| `/api/pbx` | routes/pbx.js | PBX recording sync |
| `/api/eb` | routes/engagebay.js | EngageBay proxy |
| `/api/mail-tasks` | routes/mailTasks.js | Email reply tasks |
| `/api/outlook-backups` | routes/outlookBackups.js | Outlook data backups |
| `/api/matrix-backup` | routes/matrixBackup.js | Matrix VMS backups |
| `/auth/callback` | routes/outlook.js | OAuth2 callback |

---

## REAL-TIME SOCKET.IO EVENTS

| Event | Direction | Description |
|---|---|---|
| `wa:qr` | server→client | WhatsApp QR code for scan |
| `wa:ready` | server→client | WA connected (with phone) |
| `wa:disconnect` | server→client | WA disconnected |
| `wa:message` | server→client | New incoming WA message |
| `wa:chat_update` | server→client | Chat list updated |
| `pbx:new_call` | server→client | New SMDR call event |
| `pbx:status` | server→client | PBX connection status change |
| `pbx:reconnect` | client→server | Manual reconnect trigger |
| `system:log_snapshot` | server→client | Activity log on connect |

---

## SERVICE BACKGROUND JOBS (node-cron)

| Job | Schedule | Purpose |
|---|---|---|
| marketingCron | configurable | Execute scheduled campaigns |
| automatedAI | periodic | AI analysis of calls/emails |
| maintenance | daily | Cleanup old data, temp files |
| SMDR reconnect | on-disconnect | Auto-reconnect to PBX |

---

## TECHNOLOGY STACK

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS, Font Awesome, Socket.IO client |
| Backend | Node.js, Express 4.x |
| Database | PostgreSQL (pg 8.x) |
| Auth | JWT (jsonwebtoken), bcryptjs |
| Real-time | Socket.IO |
| WhatsApp | @whiskeysockets/baileys 7.x |
| Outlook | MS Graph API, @azure/msal-node |
| PBX | Matrix SMDR TCP (custom parser) |
| AI | Ollama (local), Groq API |
| Email | nodemailer (SMTP Office365) |
| Scheduling | node-cron |
| SSL | selfsigned, node-forge |
| CRM Sync | EngageBay REST API |
| Screenshots | Playwright 1.60.x |

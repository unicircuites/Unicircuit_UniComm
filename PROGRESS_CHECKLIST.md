# UNI_CRM Progress Checklist

> Auto-generated from git diff against `origin/main` — commit `6c7d9df`

---

## ✅ Email Broadcast — Attachment Support

- [x] `emailBroadcast.js` — `normalizeAttachments()` helper: validates base64, sanitizes filenames, handles inline CID attachments
- [x] `emailBroadcast.js` — `sendOne()` now accepts `attachments` param and passes to nodemailer
- [x] `emailBroadcast.js` — `sendBroadcast()` now accepts `attachments` param and forwards to each `sendOne()` call
- [x] `broadcast.js` route — `POST /api/broadcast/test` accepts and forwards `attachments`
- [x] `broadcast.js` route — `POST /api/broadcast/send` accepts `attachments`, stores in DB (`JSONB` column)
- [x] `broadcast.js` — DB migration: `ALTER TABLE email_broadcasts ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'`

---

## ✅ Outlook / Graph API — Large Attachment Support

- [x] `outlook.js` — `graphFetchRaw()` helper: raw Graph API fetch with token injection and error handling
- [x] `outlook.js` — `uploadLargeAttachmentToMessage()`: chunked upload via Graph upload sessions (3.125 MB chunks, multiple of 320 KiB)
- [x] `outlook.js` — `addAttachmentsToMessage()`: routes attachments ≤3 MB via normal API, >3 MB via upload session
- [x] `outlook.js` — `sendDraftMessage()`: create draft → attach → send flow (required for attachments in send)
- [x] `outlook.js` — `POST /drafts`: switched to `addAttachmentsToMessage()` instead of inline attachment in message body
- [x] `outlook.js` — `POST /send`: uses `sendDraftMessage()` when attachments present, falls back to `sendMail` when none

---

## ✅ WhatsApp — Chat List Deduplication

- [x] `whatsapp.js` route — `GET /chats`: rewrote query with `LATERAL JOIN` to pull live `last_message` + `last_time` from `wa_messages`
- [x] `whatsapp.js` route — LID dedup: `NOT EXISTS` subquery suppresses LID entries when a matching `@s.whatsapp.net` chat exists (same name or phone)
- [x] `whatsapp.js` route — Group filter simplified: `id LIKE '%@g.us'` (removed stale name regex)
- [x] `whatsapp.js` route — `POST /send-media`: added `sticker` to allowed media types

---

## ✅ WhatsApp — Service Improvements (`whatsapp.js` service)

- [x] Lazy-loaded `sharp` via `getSharp()` to avoid startup crash if not installed
- [x] Reconnect detection: emit `wa:chats_updated` once after Baileys replays `chats.upsert` on reconnect

---

## ✅ SMDR / Matrix PBX — Reliability & Correctness

- [x] `matrixSmdr.js` — `looksLikeMatrixCallRecord()`: guard function to skip non-call lines before parsing
- [x] `matrixSmdr.js` — `isMatrixDate()` / `parseMatrixDate()`: broadened regex to accept `-`, `/`, `.` as date separators
- [x] `matrixSmdr.js` — `calls.js` route: same date regex fix applied
- [x] `matrixSmdr.js` — `safelyAckMatrixPacket()`: safe ACK sender with socket state checks
- [x] `matrixSmdr.js` — ACK sent on ENQ handshake via `safelyAckMatrixPacket()`
- [x] `matrixSmdr.js` — ACK sent after receiving STX/ETX framed SMDR data packets
- [x] `matrixSmdr.js` — Named constants: `MATRIX_ENQ`, `MATRIX_ACK`, `MATRIX_STX`, `MATRIX_ETX`
- [x] `matrixSmdr.js` — Suppressed false-positive warning when `PBX_HOST === '192.168.0.205'` (tower server is valid in production)
- [x] `matrixSmdr.js` — Tracking vars: `lastSavedCallTime`, `lastRawDataTime`, `savedCallCount`, `parseFailureCount`
- [x] `matrixSmdr.js` — `getStatus()`: exposes `lastActivityAgeSeconds`, `dataStreamHealthy`, `staleAfterSeconds`, `savedCallCount`, `parseFailureCount`

---

## ✅ Dashboard UI (`dashboard.html`)

- [x] Marketing quick-actions dropdown in top nav (`#mkt-quick-wrap`): Send Broadcast, Launch Campaign, Create Template
- [x] Marketing quick-actions dropdown in contact/opportunity panel (`#oa-mkt-wrap`): same three actions
- [x] WhatsApp composer: `<input>` replaced with auto-resize `<textarea>` (`waHandleComposerKey`, `waComposerInput`)
- [x] WhatsApp composer: emoji picker button + popup (`#wa-emoji-picker`, `waToggleEmojiPicker`)
- [x] WhatsApp composer: AI suggestions bar (`#wa-compose-suggestions`)
- [x] Calls table: `colspan` updated from 7 → 8 to accommodate new Recording column
- [x] Broadcast modal: refactored (template picker, attachment support wired up)

---

## ✅ Documentation & Config

- [x] `MATRIX_SARVAM_UCS_CALL_LOG_SETTINGS.txt` — documented "Send to Destination Port" UI state and how to fix stale call logs
- [x] `MATRIX_SARVAM_UCS_CALL_LOG_SETTINGS.txt` — documented OG/IC/Internal Call Report pages and correct destination `192.168.0.205:5001`

---

## ✅ New Files Added

- [x] `backend/scripts/pbx_scraper.js` — PBX web scraper utility
- [x] `backend/scripts/pbx_deep_scraper.js` — Deep PBX diagnostic scraper
- [x] `backend/matrix_vms_diagnostic.js` — Matrix VMS diagnostic tool
- [x] `backend/middleware/inputValidation_test.js` — Input validation test harness
- [x] `backend/pbx_deep_report.txt` — PBX deep diagnostic report
- [x] `clean_chat_names.js` — Utility: clean/normalize WA chat names in DB
- [x] `clean_wa_duplicates.js` — Utility: remove duplicate WA chat entries from DB
- [x] `get_test_group.py` — Python utility to fetch a test WhatsApp group

---

## 🔲 Remaining / Not Yet Committed

- [ ] PBX screenshots (`backend/pbx_*.png`) — diagnostic reference images, not staged
- [ ] `backend/pbx_vms_report.txt` — VMS report, not staged
- [ ] `backend/test_insert.js`, `backend/test_matrix_vms.js`, `backend/tmp_pbx_diag.js` — temp test files, not staged

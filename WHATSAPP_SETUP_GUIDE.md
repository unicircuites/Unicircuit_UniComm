# WhatsApp Integration Setup & Architecture Guide

This document outlines the architecture, data flows, guidelines, and critical "Do's and Don'ts" for the WhatsApp integration used in this application (powered by the `@whiskeysockets/baileys` library).

---

## 1. System Architecture & Structure

The WhatsApp integration is designed to maintain a synchronized replica of a user's WhatsApp account inside a local relational database (`PostgreSQL` / `wa_chats`, `wa_contacts`, `wa_messages`).

### Core Components
1. **Connection Manager (`services/whatsapp.js`)**: Manages the persistent WebSocket connection to WhatsApp servers using Baileys. Handles authentication, auto-reconnection, and raw event parsing.
2. **Database Layer**:
   - `wa_chats`: Stores the conversational instances (Groups, 1-on-1s) and tracks the last message and timestamp.
   - `wa_contacts`: Stores user metadata (pushName, real phone numbers, and raw `@lid` identifiers).
   - `wa_messages`: Stores the raw message content, timestamps, and media pointers.
3. **API Routes (`routes/whatsapp.js`)**: Exposes the synchronized database state to the frontend (e.g., `/api/wa/chats`, `/api/wa/resolution-stats`).
4. **Frontend UI (`dashboard.html`)**: Polls and renders the API data, explicitly filtering out unresolved or incomplete data states to provide a clean user experience.

---

## 2. Core Flows

### A. Authentication Flow
1. User requests a QR code or an 8-digit Phone Pairing Code.
2. Baileys generates the payload; the backend serves it to the UI.
3. User scans/enters the code on their mobile device.
4. WhatsApp servers authenticate the connection and upgrade the socket to `'open'`.

### B. History Sync Flow (Critical)
When a new device links, WhatsApp securely dumps the user's entire chat history in massive chunks.
1. Baileys fires the `messaging-history.set` event.
2. The backend catches this payload and pushes it to a global `historySyncQueue`.
3. `processHistoryQueue()` loops through the chunks **sequentially**:
   - Saves contacts first (to resolve names).
   - Upserts chats.
   - Saves messages and updates the chat's `last_time`.
4. Only when `isLatest = true` is received does the system mark the initial sync as complete and trigger UI updates.

### C. Live Sync Flow
Once History Sync is complete, the application enters "Live" mode.
- `messages.upsert`: Real-time incoming/outgoing messages are intercepted and saved to the DB immediately.
- `contacts.upsert`: Real-time contact name changes or additions are synced.

### D. Background LID Resolution Flow
WhatsApp provides group participants in a privacy-preserving `@lid` format (e.g., `1234567890@lid`) hiding their real phone number.
1. The backend runs a continuous loop (`tickLidResolutionWorker`) every few seconds.
2. It queries the database for unresolved `@lid` contacts.
3. It asks WhatsApp (`sock.groupMetadata`) for the group details.
4. It maps the `@lid` to the real phone number (`@s.whatsapp.net`).
5. As contacts are resolved, they gracefully appear in the frontend Chat List.

---

## 3. Strict Guidelines: Do's and Don'ts

### 🔴 DON'TS

1. **DON'T Run Network Queries Concurrently with History Sync**
   - **Why:** WhatsApp's WebSockets are extremely sensitive to congestion. If you send outbound requests (like `sock.groupMetadata`) while the massive History Sync is streaming in, the socket will choke. WhatsApp will stop responding to pings, resulting in a `timed out waiting for message` error, and forcefully sever your connection.
   - **Rule:** The `isProcessingHistoryQueue` flag must globally lock out all background tasks until the history sync is 100% complete.

2. **DON'T Spam `groupMetadata` or Profile Queries**
   - **Why:** WhatsApp heavily rate-limits metadata requests. Bulk querying hundreds of groups instantly will guarantee a temporary ban/socket drop.
   - **Rule:** Use a batched, throttled approach (e.g., 30 groups per batch, with a 500ms delay between queries, and an 8-second delay between batches).

3. **DON'T Display `@lid` Contacts in the UI**
   - **Why:** They are useless to the end-user as they cannot be directly replied to or identified easily without a phone number.
   - **Rule:** Filter them out at the SQL level (`AND regexp_replace(phone, '[^0-9]', '', 'g') <> ''`) until the LID worker resolves them.

4. **DON'T Panic on "Timed Out" or "Connection Closed" Errors**
   - **Why:** Connections drop. It's the nature of WhatsApp Web.
   - **Rule:** Rely on Baileys' automatic `shouldReconnect` logic. Just ensure your database operations are idempotent (using `ON CONFLICT DO UPDATE`) so re-syncing doesn't cause duplicates.

### 🟢 DO'S

1. **DO Wrap Every Background Task in Global Try/Catch Handlers**
   - Unhandled Promise Rejections inside Baileys or background `setTimeout` loops will instantly crash the Node server. Always use `try/catch` and attach `.catch(err => ...)` to async fire-and-forget calls.

2. **DO Yield the Event Loop During Heavy Syncs**
   - History Syncs can contain tens of thousands of rows. 
   - Use `await new Promise(r => setTimeout(r, 10))` every 50-100 iterations to prevent blocking the Node.js main thread so the frontend API doesn't hang.

3. **DO Maintain a Memory Cache for Media**
   - Decrypting media requires the original message payload. Maintain an LRU (Least Recently Used) Map (e.g., `msgCache` with a `MAX_CACHE` of 5000) so users can quickly download media without querying the DB for decryption keys.

4. **DO Implement Cooldowns for Rate Limits**
   - If a `timed out` error occurs during background tasks, immediately set a cooldown (e.g., 10 minutes) using `lidResolutionCooldownUntil` to give the WhatsApp account time to recover from the rate limit.

---

## 4. Summary of App Structure

```text
UNI_CRM/
├── backend/
│   ├── server.js               # Global error handlers (uncaughtException, unhandledRejection)
│   ├── routes/
│   │   └── whatsapp.js         # API layer (filters LID contacts, serves stats and messages)
│   └── services/
│       └── whatsapp.js         # The Engine (Baileys socket, queues, LID worker, DB upserts)
└── dashboard.html              # Frontend UI (polls resolution-stats to show true progress)
```

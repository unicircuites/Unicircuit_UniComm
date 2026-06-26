# UNI_CRM Codebase Map

This document provides a comprehensive guide to the project's structure, files, database tables, and key workflows. Read this file first to understand the project layout without having to parse huge source files.

---

## 1. Project Architecture

The application is structured as a **Single-Page Application (SPA) frontend** communicating with a **Node.js + Express + PostgreSQL backend**.

- **Frontend**: A single, very large HTML file (`dashboard.html` ~2MB) containing all CSS styles, UI components, client-side routing, and WebSocket/API communication logic.
- **Backend**: An Express application (`backend/server.js`) using a PostgreSQL database pool, serving REST APIs, and running background services (e.g., Matrix PBX SMDR parser, WhatsApp Baileys integration, Microsoft Graph sync).
- **Real-Time Communication**: Built on Socket.IO. The client establishes a single socket connection (`waSocket` in `dashboard.html`) to receive real-time updates for call events, WhatsApp messages, and suggestions.

---

## 2. Key Directories & Files

- `dashboard.html`: The monolithic frontend containing the CRM workspace, email, call logs, WhatsApp, marketing campaigns, and settings interfaces.
- `backend/server.js`: The application entry point. Initializes DB tables/indexes, wraps Socket.IO server, runs background workers, and serves API routers.
- `backend/routes/`: Express API routers.
  - `calls.js`: Call logs management, PBX contacts, and cross-sync AI suggestions.
  - `whatsapp.js`: WhatsApp chat list, message retrieval, sending, backups, and contact updates.
  - `outlook.js`: Outlook mail and contact sync.
  - `contacts.js`: CRM Contacts.
- `backend/services/`: Background processing and third-party integrations.
  - `matrixSmdr.js`: Parser and TCP listener for SMDR (Station Message Detail Recording) from the Matrix PBX Eternity gateway.
  - `whatsapp.js`: Manages Baileys connection to WhatsApp, syncs chats, messages, and emits socket events.
  - `msGraph.js` / `oneDriveSync.js`: Integration with Microsoft Office 365 Graph API.
- `backend/db/`: PostgreSQL pool setup and initial migration schemas (`pool.js`, `init.js`).

---

## 3. Database Schema Reference

The database contains the following key tables:

1. **`users`**: CRM application users/agents.
2. **`contacts`**: Core CRM Contacts (fname, lname, company, email, phone, wa, segment, score, etc.).
3. **`pbx_contacts`**: Contacts saved specifically for the PBX/Calls system (phone, name, company, email, mobile_phone, notes).
4. **`call_logs`**: PBX call history records.
5. **`pbx_recordings`**: Matched audio files for PBX call recordings.
6. **`mail_reply_tasks`**: Tasks derived from email triaging/replies.
7. **`wa_contacts`**: Synced WhatsApp contacts (jid, account_phone, name, notify, phone).
8. **`wa_chats`**: WhatsApp chat listing (id, account_phone, name, phone, unread, last_message).
9. **`wa_messages`**: WhatsApp message history (id, chat_id, account_phone, from_me, body, timestamp).
10. **`rejected_suggestions`**: Persisted IDs of cross-sync suggestions that the user has rejected/dismissed.

---

## 4. Cross-Sync AI Suggestions

AI suggestions reconcile contacts across three platforms: **PBX**, **WhatsApp**, and **Outlook**.

### Logic Flow
Suggestions are computed dynamically via `GET /api/calls/cross-sync-suggestions`:
1. Contacts are matched across platforms by their **core phone number** (normalized using `getCoreNumber()`, which handles spaces, country codes like `+91`, leading zeros, and short extension numbers).
2. **WA → PBX**: If a named WhatsApp contact is not in PBX contacts, but their number has called or been called by the PBX (recorded in `call_logs`).
3. **PBX → WA**: If a named PBX contact is in WhatsApp as a direct chat but doesn't have a contact name.
4. **Outlook → PBX**: If an Outlook contact is not in PBX but has appeared in call logs.
5. **Outlook → WA**: If an Outlook contact is in WhatsApp but WA has no name.
6. **Filtering**: Rejections saved in `rejected_suggestions` are filtered out at the DB level, and frontend `localStorage` is used for instant UI dismissal.

### Auto-Update Triggers
The suggestions UI reloads dynamically when:
- A new call log is received (`pbx:call` or `smdr:record` Socket.IO events).
- A new WhatsApp message is received (`wa:message` Socket.IO event).
- A suggestion is rejected, a PBX contact is saved, or an Outlook sync is completed (triggers `suggestions:update` Socket.IO event).

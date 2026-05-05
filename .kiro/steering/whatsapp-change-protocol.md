---
inclusion: always
---

# WhatsApp Change Protocol — MANDATORY

## Rule: Test Before Commit

Before making ANY change to WhatsApp-related files, you MUST:

1. Run syntax check: `node --check backend/services/whatsapp.js`
2. Start server and verify: `node server.js` — check for startup errors
3. Verify chat list loads with names (not raw numbers)
4. Verify messages load in a chat when clicked
5. Only then commit and push

If ANY step fails → revert immediately, do NOT push broken code.

---

## Files That Affect WhatsApp (Handle With Extreme Care)

- `backend/services/whatsapp.js` — Core WA logic
- `backend/routes/whatsapp.js` — API routes
- `dashboard.html` — WA UI (waMediaHTML, waAppendMessage, waLoadChats, waGetQR, waOpenChat)

---

## Current Working State (as of commit `e6d3455`)

### ✅ Connection
- Session stored in `backend/wa_auth/`
- On server stop: session cleared via `process.on('exit/SIGINT/SIGTERM')`
- QR timeout: 20s (`connectTimeoutMs: 20000`)
- Code 408 (QR timeout): NO auto-reconnect, wait for manual scan
- Code 500/515 (stream error/replaced): auto-reconnect after 5s
- Logged out: clear session + restart in 500ms
- `syncFullHistory: false` — fast connect
- Baileys verbose logs suppressed: `logger: require('pino')({ level: 'silent' })`

### ✅ Chat List (working)
- Chats loaded from DB via `/api/wa/chats`
- Filter includes: `@g.us` groups + `@s.whatsapp.net` Indian numbers + `@lid` WITH real names only + `import_*`
- `@lid` chats WITHOUT real names are HIDDEN (own device IDs like `+49894668673181`)
- Names resolved via `contactsStore` + DB `wa_contacts`
- `updateChatNames()` called on startup
- Direct SQL on startup: `UPDATE wa_chats SET name = wc.name FROM wa_contacts wc WHERE wa_chats.id = wc.jid`
- Phone format in chat list: `+91 XXXXX XXXXX` for Indian, `+` prefix for others

### ✅ Message Loading (working)
- Click on chat → `waOpenChat(rawJid, name, phone)` called
- JID normalization — CRITICAL, DO NOT CHANGE:
  ```js
  var jid = rawJid;
  if (rawJid.includes(':') && rawJid.includes('@')) {
    jid = rawJid.split(':')[0] + '@' + rawJid.split('@').slice(1).join('@');
  }
  ```
- Old broken code was `rawJid.split('@')[1]` — caused `@g.us@g.us`. NEVER revert.
- Messages fetched from `/api/wa/messages/:jid?limit=100`
- Group info from `/api/wa/group/:jid` (route sanitizes double suffix)

### ✅ Media (partially working)
- **New messages** (after server start): auto-saved to `backend/wa_media/` on receive
- **Old messages**: 404 expected — WhatsApp encryption key expires, cannot recover
- Served via `/api/wa/media/:msgId` (no auth required)
- Disk-first lookup: `wa_media/MSGID_filename.ext`
- In-memory cache fallback for very recent messages
- `<img>`, `<video>`, `<audio>` tags in `waMediaHTML()`
- Media folder gitignored: `backend/wa_media/`

### ✅ Real-time
- `messages.upsert` → saves to DB → emits `wa:message` via Socket.IO
- `rawJid` declared before use (fixed bug)
- `notify()` used for new message toast (NOT `showToast` — that doesn't exist)
- `wa:connected` / `wa:disconnected` → update status bar

### ✅ Import Chat
- Supports `.txt` (text only) and `.zip` (with media)
- Can import into existing chat OR create new (`__new__` option generates `import_*` JID)
- Media saved to `backend/wa_media/`

---

## JID Normalization Rules — CRITICAL

| JID Type | Example | Rule |
|---|---|---|
| Phone | `919545073545:54@s.whatsapp.net` | Strip `:device` → `919545073545@s.whatsapp.net` |
| Group | `120363402503162424@g.us` | Keep as-is, use `.slice(1).join('@')` NOT `[1]` |
| LID | `49868915663011@lid` | Keep as-is, hide if no real name |
| Own LID | `49868915663011@lid` | Hidden from chat list (own device) |

---

## What Caused Problems (DO NOT REPEAT)

| Change | Problem |
|---|---|
| `rawJid.split('@')[1]` in JID normalization | `@g.us@g.us` double suffix, groups broken |
| Added JID normalization in `saveChat` | Broke chat names |
| PowerShell line replacement of JS files | Encoding corruption |
| `rawJid` used before declaration | Runtime crash |
| Auto QR retry loop | Billboard QR every 2s |
| `showToast()` call | ReferenceError — use `notify()` |
| Showing all `@lid` chats | Own device IDs like `+49894668673181` shown |

---

## Safe Way to Edit whatsapp.js

```python
with open('backend/services/whatsapp.js', 'r', encoding='utf-8') as f:
    c = f.read()
c = c.replace('OLD_STRING', 'NEW_STRING', 1)
with open('backend/services/whatsapp.js', 'w', encoding='utf-8') as f:
    f.write(c)
```

Always verify: `node --check backend/services/whatsapp.js`

---

## Recovery Steps

```cmd
git log --oneline -10
git revert HEAD --no-edit
git push origin main

# Restore specific file
git checkout COMMIT_HASH -- backend/services/whatsapp.js
```

## Last Known Good Commit
`e6d3455` — hide @lid chats without real names

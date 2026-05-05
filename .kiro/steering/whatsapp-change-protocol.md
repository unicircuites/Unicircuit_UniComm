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

## Known Working State (as of commit `7cd08ca`)

### ✅ WORKING — DO NOT BREAK THESE

#### Connection
- Session stored in `backend/wa_auth/`
- On server stop: session cleared via `process.on('exit/SIGINT/SIGTERM')`
- QR timeout: 20s (`connectTimeoutMs: 20000`)
- Code 408 (QR timeout): NO auto-reconnect, wait for manual scan
- Code 500 (stream error): auto-reconnect after 5s
- Logged out: clear session + restart in 500ms
- `syncFullHistory: false` — fast connect, only recent history

#### Chat Loading ✅
- Chats loaded from DB via `/api/wa/chats`
- Filter: `@g.us` groups + `@s.whatsapp.net` Indian numbers + `@lid` + `import_*`
- Names resolved via `contactsStore` (in-memory) + DB `wa_contacts`
- `updateChatNames()` called on startup to update DB names from contacts
- Direct SQL update on startup: `UPDATE wa_chats SET name = wc.name FROM wa_contacts wc WHERE wa_chats.id = wc.jid`

#### Message Loading ✅ (FIXED in 7cd08ca)
- Click on chat → `waOpenChat(rawJid, name, phone)` called
- JID normalization in `waOpenChat`: strips `:device` suffix ONLY when colon AND @ both present
  ```js
  if (rawJid.includes(':') && rawJid.includes('@')) {
    jid = rawJid.split(':')[0] + '@' + rawJid.split('@').slice(1).join('@');
  }
  ```
- **CRITICAL**: Old broken code was `rawJid.split(':')[0] + '@' + rawJid.split('@')[1]`
  which caused `@g.us@g.us` double suffix for groups. DO NOT revert to this.
- Messages fetched from `/api/wa/messages/:jid?limit=100`
- Group info fetched from `/api/wa/group/:jid` (route sanitizes double suffix)

#### JID Normalization Rules — CRITICAL
- Strip device suffix: `919545073545:54@s.whatsapp.net` → `919545073545@s.whatsapp.net`
- Groups: `@g.us` suffix — DO NOT add or modify — use `.slice(1).join('@')` not `[1]`
- LID: `49868915663011@lid` — keep as-is, shown in chat list
- NEVER double-append domain suffix

#### Media
- Auto-saved to `backend/wa_media/` on receive (new messages only)
- Served via `/api/wa/media/:msgId` (no auth required)
- Disk-first lookup, then in-memory cache fallback
- Old messages: media not available (WhatsApp server expiry) — shows 404
- `<img>`, `<video>`, `<audio>` tags in `waMediaHTML()`

#### Real-time
- `messages.upsert` → saves to DB → emits `wa:message` via Socket.IO
- Dashboard listens on `wa:message` → `waAppendMessage()`
- `wa:connected` / `wa:disconnected` → update status bar
- `showToast` replaced with `notify()` — do not use `showToast`

#### Import Chat
- Supports `.txt` (text only) and `.zip` (with media)
- Can import into existing chat OR create new (`__new__` option)
- Media saved to `backend/wa_media/`

---

## Known Remaining Issues (as of 7cd08ca)

1. **Contact names** — `@lid` contacts (2365 chats) still show raw numbers
   - 210 chats have real names (from direct SQL update)
   - Root cause: `@lid` JIDs in `wa_chats` don't match `wa_contacts` JIDs directly
   - Fix needed: map `@lid` → phone number via Baileys `p.phoneNumber` field

2. **Media for old messages** — 404 errors expected, only new messages auto-saved

---

## What Caused Problems (DO NOT REPEAT)

| Change | Problem |
|---|---|
| `rawJid.split('@')[1]` in JID normalization | `@g.us@g.us` double suffix, groups broken |
| Added JID normalization in `saveChat` | Broke chat names — raw numbers shown |
| PowerShell line replacement of JS files | Encoding corruption, syntax errors |
| `rawJid` used before declaration | Runtime crash in `messages.upsert` |
| Auto QR retry loop | Billboard QR every 2s |
| `isAuthenticated` returning true without real check | Outlook showed "Connected" but no mails |
| `showToast()` call | ReferenceError — use `notify()` instead |

---

## Safe Way to Edit whatsapp.js

Use Python for string replacement (avoids encoding issues):

```python
with open('backend/services/whatsapp.js', 'r', encoding='utf-8') as f:
    c = f.read()
c = c.replace('OLD_STRING', 'NEW_STRING', 1)
with open('backend/services/whatsapp.js', 'w', encoding='utf-8') as f:
    f.write(c)
```

Then always verify: `node --check backend/services/whatsapp.js`

---

## Recovery Steps If Something Breaks

```cmd
# See recent commits
git log --oneline -10

# Revert last commit
git revert HEAD --no-edit
git push origin main

# Or restore specific file from specific commit
git checkout COMMIT_HASH -- backend/services/whatsapp.js
```

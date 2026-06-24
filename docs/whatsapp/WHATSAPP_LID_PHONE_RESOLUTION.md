# WhatsApp LID → Phone Number Resolution
*Last updated: June 24, 2026*
*Status: Production Ready ✅ | Bugs fixed this session: 3*

---

## Table of Contents
1. [What is a LID?](#1-what-is-a-lid)
2. [Why Its Hard](#2-why-its-hard)
3. [Resolution Architecture — 3 Layers](#3-resolution-architecture--3-layers)
4. [Key Functions Reference](#4-key-functions-reference)
5. [Database Tables](#5-database-tables)
6. [Data Flow Diagram](#6-data-flow-diagram)
7. [Frontend — Settings Panel LID Progress](#7-frontend--settings-panel-lid-progress)
8. [Frontend — Group Member Display](#8-frontend--group-member-display)
9. [Bugs Fixed this session](#9-bugs-fixed-this-session)
10. [Coverage Numbers](#10-coverage-numbers)
11. [Rules — DO NOT BREAK](#11-rules--do-not-break)
12. [Expected Console Output](#12-expected-console-output)
13. [Files Modified Map](#13-files-modified-map)

---

## 1. What is a LID?

Modern WhatsApp uses **Linked Identity Device (LID)** JIDs instead of phone-based JIDs for many contacts.

| Format | Example | Phone visible? |
|--------|---------|----------------|
| Old (phone JID) | `919545073545@s.whatsapp.net` | YES |
| New (LID JID) | `272893648851001@lid` | NO |

Group chat messages arrive with `msg.sender = "272893648851001@lid"`.
Without a mapping table, raw LID numbers appear in chat bubbles.

---

## 2. Why Its Hard

1. **LIDs are opaque** — `272893648851001` has no relation to `917743989206`
2. **Baileys p.phoneNumber** is only available in groupMetadata response
3. **Group-only members** have NO entry in `wa_chats` by default
4. **Large groups** (1000+ members) have hundreds of LIDs to map
5. **Left members** never appear in Baileys `groupMetadata().participants` — they are completely absent
6. **seenJids scope bug** (now fixed) — was crashing syncAllGroupParticipants silently

---

## 3. Resolution Architecture — 3 Layers

### Layer 1: syncAllGroupParticipants() — Boot-time population
File: `backend/services/whatsapp.js` line ~3467
When: 8 seconds after WhatsApp connects (every server start)
What: Scans ALL groups via sock.groupMetadata(), saves LID → phone to wa_contacts.

```javascript
// Triggered from: connection === 'open' handler
setTimeout(() => syncAllGroupParticipants(), 8000);
```

KEY FIX (June 24): Added `const seenJids = new Set()` inside the function.
Previously seenJids was undefined, causing a silent crash and 0 contacts saved.

---

### Layer 2: processLidResolutionBatch() — Continuous background worker
File: `backend/services/whatsapp.js` line ~3224
When: Runs on timer, processes groups in cursor-based batches
What: For each unresolved LID, scans groups, extracts phone, writes to DB.

Worker lifecycle:
```
startLidResolutionWorker()
  -> tickLidResolutionWorker() every 2.5s or cooldown wait
       -> countPendingLids() — if 0, stop
       -> lidResolutionExhausted? — wait 60s, reset, retry
       -> processLidResolutionBatch() -> upsertGroupMemberContacts()
```

Rate limit handling:
- WA 429/timeout -> 10-minute cooldown
- Group 403/forbidden -> 24-hour skip
- History sync active -> pause worker

---

### Layer 3: /wa/lid-map — Frontend real-time map
File: `backend/routes/whatsapp.js` line ~311
Endpoint: GET /api/wa/lid-map
What: Returns `{ lidNum -> { name, phone } }` map for chat bubble + group display.

```sql
SELECT lid_num, name, phone FROM (
  SELECT split_part(id, '@', 1) AS lid_num, name, phone
  FROM wa_chats WHERE id LIKE '%@lid' AND phone IS NOT NULL AND phone != ''
  UNION
  SELECT split_part(jid, '@', 1) AS lid_num, name, phone
  FROM wa_contacts WHERE jid LIKE '%@lid' AND phone IS NOT NULL AND phone != ''
    AND phone ~ '^[0-9]'
) combined
```

---

## 4. Key Functions Reference

| Function | File | Line | Purpose |
|----------|------|------|---------|
| syncAllGroupParticipants() | services/whatsapp.js | ~3467 | Boot-time full scan of all groups |
| processLidResolutionBatch() | services/whatsapp.js | ~3224 | Cursor-based batch resolver |
| tickLidResolutionWorker() | services/whatsapp.js | ~3401 | Timer tick for the worker |
| startLidResolutionWorker() | services/whatsapp.js | ~3456 | Start the background worker |
| countPendingLids(accPhone) | services/whatsapp.js | ~3180 | Count LIDs with no valid phone |
| upsertGroupMemberContacts() | services/whatsapp.js | ~764 | Bulk-insert/update wa_contacts |
| getGroupMetadata(jid) | services/whatsapp.js | ~3960 | Returns processed participants for frontend |
| getRawGroupMetadata(jid) | services/whatsapp.js | ~3287 | Raw Baileys data with cache |
| consolidateLidChats() | services/whatsapp.js | (search) | Merges duplicate LID entries in wa_chats |
| loadLidPhoneMapFromDB() | services/whatsapp.js | (search) | Refreshes in-memory LID->phone map |
| refreshLidResolutionGroupIds() | services/whatsapp.js | ~3209 | Rebuilds group list for cursor walk |

---

## 5. Database Tables

### wa_contacts — All contacts including group-only LID members

| Column | Type | Notes |
|--------|------|-------|
| jid | text | e.g. 272893648851001@lid or 919545073545@s.whatsapp.net |
| account_phone | text | WhatsApp number this belongs to |
| name | text | Display name from contacts.upsert |
| notify | text | Push name from server |
| phone | text | Resolved phone digits e.g. 917743989206 |
| is_group_member | bool | true = synced from group metadata |
| updated_at | timestamp | Last updated |

Unique constraint: (jid, account_phone)
Conflict rule: phone = COALESCE(EXCLUDED.phone, wa_contacts.phone) — never overwrite good phone with null.

### wa_chats — Chat-level data (direct chats AND groups)

| Column | Type | Notes |
|--------|------|-------|
| id | text | JID of the chat |
| account_phone | text | |
| is_group | bool | |
| phone | text | For direct LID chats — resolved phone |
| name | text | |

---

## 6. Data Flow Diagram

```
Server Start
    |
    v
WhatsApp Connects (connection === 'open')
    |
    |-> emit('wa:connected') -------> Frontend: waLoadLidMap() [immediate]
    |                                            setTimeout(waLoadLidMap, 12s)
    |
    -> setTimeout(syncAllGroupParticipants, 8s)
              |
              v
         For each group in wa_chats (is_group=true):
              |
              v
         sock.groupMetadata(groupJid)
              |
              v
         For each participant p:
              |
              |-> p.id = @lid AND p.phoneNumber exists?
              |       YES -> save LID -> rawPhone to wa_contacts
              |       NO  -> skip (handled by processLidResolutionBatch)
              v
         upsertGroupMemberContacts(pendingContacts)
         consolidateLidChats()
         loadLidPhoneMapFromDB()
         emit('wa:participants_synced')
         startLidResolutionWorker()


Background Resolution Worker
    |
    v
tickLidResolutionWorker() every ~2.5s
    |
    |-> pending = 0? -> emit('wa:lid_resolution_complete') -> DONE
    |-> history sync active? -> pause
    |-> cooldown? -> wait
    -> processLidResolutionBatch()
              |
              v
         Cursor walks through ALL group IDs
         getRawGroupMetadata(gid) for each
         Extract phone from participants
         upsertGroupMemberContacts()
         emit('wa:lid_batch', result)
         emit('wa:participants_synced')
```

---

## 7. Frontend — Settings Panel LID Progress

File: `dashboard.html` lines ~19330-19353
Endpoint: GET /api/wa/resolution-stats

### API Response Fields
```json
{
  "total": 5200,
  "loaded": 4800,
  "pending": 350,
  "named_pending": 120,
  "hidden_pending": 230,
  "total_lids": 3800,
  "resolved_lids": 3450,
  "exhausted": false,
  "cooldown_mins": 0
}
```

### Frontend Display Logic (CORRECT fields)
```javascript
const totalLids    = stats.total_lids    || 0;  // CORRECT field
const resolvedLids = stats.resolved_lids || 0;  // CORRECT field
const pending      = stats.pending       || 0;  // CORRECT field
const percentage   = totalLids > 0
  ? Math.min(100, Math.round((resolvedLids / totalLids) * 100))
  : (pending === 0 ? 100 : 0);
// Display: "3450 resolved, 350 pending / 3800 total"
```

### SQL Behind resolved_lids
```sql
COUNT(*) FILTER (
  WHERE id LIKE '%@lid'
    AND phone_digits ~ '^[0-9]{7,14}$'
    AND phone_digits != split_part(id, '@', 1)
)::int AS resolved_lids
```
Both wa_chats and wa_contacts are UNION ALL'd in raw_items CTE then deduplicated in keyed.

---

## 8. Frontend — Group Member Display

File: `dashboard.html` — waPopulateGroupInfo() and waRenderGroupMembers()

### How participants are processed (lines ~28219-28258)
```javascript
// RULE: NEVER show "Unknown" for current group members.
// "Unknown" = left the group.
// Baileys NEVER returns left members in participants list.
// So any participant here is CURRENT and just pending resolution.

if (p.jid ends with '@lid' AND no resolved phone) {
    var mapped = waLidMap[lidNum];
    if (mapped) return { ...p, phone: mapped.phone, name: mapped.name };  // Resolved

    // Still unresolved — mark as pending, NOT as Unknown
    return { ...p, phone: '', name: p.name || null, _lidPending: true, _lidNum: lidNum };
}
```

### Pending LID render (lines ~28290-28315)
- Avatar: grey circle with clock emoji (no green circle)
- Name: shown if known from Baileys push-name, otherwise blank
- Badge: italic "Resolving..." tag in muted color
- Sub-label: last 8 digits of LID + @lid in monospace, dimmed

### When does a member show as "Unknown"?
Per user requirement: ONLY group members who LEFT the group should be "Unknown".
Since Baileys never returns left members, this scenario cannot occur from Baileys data.
If you need to show historical left-members: store them separately with a left_at
timestamp in wa_contacts and explicitly set name="Unknown" there.

---

## 9. Bugs Fixed this session

### Bug 1: seenJids not declared in syncAllGroupParticipants — CRITICAL
File: `backend/services/whatsapp.js` line ~3488

Impact: syncAllGroupParticipants crashed every time with TypeError.
Zero LIDs were saved on boot. total_lids = 0 while pending showed 3422.
Settings page showed "0 resolved, 3422 pending / 0 total" at 0%.

Fix:
```javascript
// BEFORE (broken):
const pendingContacts = [];
let total = 0;

// AFTER (fixed):
const pendingContacts = [];
const seenJids = new Set();  // <- ADDED: Deduplicate across groups
let total = 0;
```

---

### Bug 2: Wrong field stats.resolved in settings diagnostic log
File: `dashboard.html` line ~19559

Impact: Log showed "0 resolved" because stats.resolved is undefined.
API returns stats.resolved_lids, not stats.resolved.

Fix:
```javascript
// BEFORE:
`Resolution stats active: ${stats.resolved || 0} resolved, ${stats.pending || 0} pending`

// AFTER:
`Resolution stats active: ${stats.resolved_lids || 0} resolved, ${stats.pending || 0} pending / ${stats.total_lids || 0} total LIDs`
```

---

### Bug 3: Current group members labeled "Unknown"
File: `dashboard.html` line ~28237

Impact: All 3422 pending LID members showed as "Unknown" in group panel.

Fix:
- Removed 'Unknown' fallback entirely for current group members
- Added _lidPending: true and _lidNum flags
- Render: grey avatar + "Resolving..." badge + dimmed LID hint

---

## 10. Coverage Numbers

| Source | LID Entries | Covers |
|--------|-------------|--------|
| wa_chats only | ~2,388 | Contacts with direct chats |
| wa_contacts only | ~2,430 | Group-only members synced by participant scan |
| UNION (both) | ~4,818+ | ALL participants in ALL groups |

After syncAllGroupParticipants runs successfully (with bug fix):
- total_lids: 3,800 - 5,000
- resolved_lids = total_lids - pending
- pending -> 0 over time as background worker completes

---

## 11. Rules — DO NOT BREAK

1. Never remove syncAllGroupParticipants() — it is the primary boot-time LID populator
2. Always declare `const seenJids = new Set()` INSIDE syncAllGroupParticipants — never rely on outer scope
3. Never revert /wa/lid-map to wa_chats only — wa_contacts UNION is required
4. Keep the 8s delay on syncAllGroupParticipants — WA needs time to settle
5. Keep wa:participants_synced event — frontend listens to reload LID map
6. Settings panel must use stats.total_lids and stats.resolved_lids (NOT stats.totalChats or stats.resolved)
7. Never label current group members "Unknown" — Baileys participants = current members only
8. upsertGroupMemberContacts conflict rule: phone = COALESCE(EXCLUDED.phone, wa_contacts.phone) — never overwrite good phone with null
9. Keep cooldown logic in tickLidResolutionWorker — prevents WA rate-limiting
10. Keep history-sync pause check in tickLidResolutionWorker — prevents socket overload

---

## 12. Expected Console Output

### Backend (server start)
```
[WA] Connected as 919545073545 | raw id: 919545073545:48@s.whatsapp.net
[WA] Syncing participants for 47 groups (batch)...
[WA] Group participant sync done — 4818 LID->phone entries saved
[WA] Starting LID resolution worker (batch size 30)
[WA] LID resolution batch: { batchSize: 30, groupsScanned: 5, upserted: 30, resolved: 12, pending: 3410 }
... (continues until pending = 0) ...
[WA] LID resolution worker complete
```

### Frontend (settings panel diagnostic log)
```
Resolution stats active: 3450 resolved, 350 pending / 3800 total LIDs
```

### Settings LID stats bar display
```
3450 resolved, 350 pending / 3800 total     <- during resolution
All LIDs resolved                            <- when complete
```

---

## 13. Files Modified Map

| File | Function/Section | Line | Change |
|------|-----------------|------|--------|
| backend/services/whatsapp.js | syncAllGroupParticipants() | ~3488 | Added const seenJids = new Set() |
| backend/routes/whatsapp.js | /wa/resolution-stats | ~603 | Returns total_lids, resolved_lids (already correct) |
| backend/routes/whatsapp.js | /wa/lid-map | ~311 | UNION wa_chats + wa_contacts (already correct) |
| dashboard.html | Settings LID stats | ~19330 | Uses stats.total_lids, stats.resolved_lids (already correct) |
| dashboard.html | Settings diagnostic log | ~19559 | Fixed stats.resolved -> stats.resolved_lids |
| dashboard.html | waPopulateGroupInfo | ~28225 | Removed "Unknown" fallback, added _lidPending flag |
| dashboard.html | waRenderGroupMembers | ~28290 | Pending LIDs: grey avatar + Resolving badge + LID hint |

---

## Appendix: Single LID Resolution Trace

```
Step 1: Boot — syncAllGroupParticipants()
  sock.groupMetadata(gid) returns:
    p.id = "272893648851001@lid"
    p.phoneNumber = "917743989206@s.whatsapp.net"
  -> rawPhone = "917743989206"
  -> wa_contacts row: jid=272893648851001@lid, phone=917743989206

Step 2: After sync
  loadLidPhoneMapFromDB()
  -> lidPhoneMap["272893648851001@lid"] = "917743989206@s.whatsapp.net"

Step 3: Browser waLoadLidMap()
  GET /api/wa/lid-map
  -> waLidMap["272893648851001"] = { phone: "+91 77439 89206", name: "Nidhisha" }

Step 4: Chat bubble
  msg.sender = "272893648851001@lid"
  -> waLidMap["272893648851001"].phone = "+91 77439 89206"  [RESOLVED]

Step 5: Group member panel
  p.jid = "272893648851001@lid"
  -> mapped = waLidMap["272893648851001"]
  -> shows: "+91 77439 89206" with name "Nidhisha"  [RESOLVED]
```

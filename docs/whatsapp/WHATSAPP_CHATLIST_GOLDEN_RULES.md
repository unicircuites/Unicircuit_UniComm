# WhatsApp Chatlist Golden Rules & Loading Logic

This document serves as a strict guideline for how WhatsApp chat lists must be parsed, filtered, and rendered within the UniComm CRM to perfectly mimic native WhatsApp Web behavior and ensure absolute data cleanliness.

## The Golden Rules

1. **No Duplicate Names:** The chat list must *never* contain duplicate generic names (like multiple groups named simply "Group").
2. **Valid Identity Compulsory:** A chat must *only* be loaded and rendered if it has either:
   - A properly formatted **`+91 XXXXXXXXXX`** phone number.
   - A proper, valid **Contact Name** (saved name, push name, verified name).
3. **No Raw LIDs:** 15-digit raw `@lid` strings are strictly internal identifiers. If an `@lid` chat has NO valid proper name and NO resolved phone number, it must be **completely hidden** from both API responses and frontend socket updates until the background worker successfully converts it.
4. **No Unnamed Groups:** Groups that have not yet had their metadata (subject) synced must be **completely hidden**. The system should never display a raw group JID or a fallback "Group" label.
5. **Strict Number Formatting:** All 10-digit Indian numbers must be formatted identically as `+91 XXXXXXXXXX` (a single space after the country code, followed by all 10 digits as a single continuous block).
6. **No "WhatsApp" Fallbacks:** The name "WhatsApp" (which is the app's default push name for system messages) must be actively rejected by the label validator `isInvalidContactLabel` so it never overwrites a user's contact name.

## Implementation Guardrails

### Backend (`backend/routes/whatsapp.js`)
The `canonicalizeChats` function enforces these rules before chats are sent to the frontend or saved into `wa_chats`.
- **LID Exclusion:** `if (!isGroup && id.endsWith('@lid') && !phoneDigits && !hasNamedLidFallback) continue;`
- **Group Exclusion:** `if (isGroup && (!displayLabel || isGroupishLabel(displayLabel, idLocal))) continue;`

### Frontend (`dashboard.html`)
The `waRenderChats` function enforces identical rules to protect the UI against raw incoming socket payloads before they hit the database.
- **Phone Deduplication:** A `Set` (`seenPhones`) prevents the same individual from appearing twice (e.g. once via `@s.whatsapp.net` and once via `@lid`).
- **Name Deduplication:** A `Set` (`seenNames`) ensures that identically named individual chats are merged, honoring the golden rule of no duplicate names.
- **Hidden Pending Chats:** Groups without proper subjects or LIDs missing both a name and a phone number are actively returned as `''` (empty string) in the render map.

## Testing New Logins
When a completely new number (with zero existing database records) scans the QR code:
1. The backend connects and begins downloading the History Sync payload.
2. The UI will initially remain clean, only displaying chats that natively arrive with valid pushNames or numbers.
3. The background `lidResolutionWorker` will begin systematically pinging the WhatsApp API to resolve LIDs to 10-digit phone numbers and fetch missing Group metadata.
4. As resolution succeeds, chats will seamlessly and beautifully appear in the frontend UI, perfectly formatted and correctly sorted by their `last_time`.

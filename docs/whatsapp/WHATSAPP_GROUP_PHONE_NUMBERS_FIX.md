# WhatsApp Group Chat Phone Numbers Fix

## Problem
Group chat messages were not showing phone numbers in chat bubbles. Only the Group Info panel showed phone numbers correctly.

## Root Cause
1. **LID (Linked Identity Device) Contacts**: Modern WhatsApp uses `@lid` JIDs instead of regular phone JIDs (`@s.whatsapp.net`) for many contacts
2. **Missing Phone Mapping**: The `wa_contacts` table had `@lid` entries but many LID **senders** were missing from the table entirely
3. **Strict Regex Pattern**: The SQL query used `c.phone ~ '^[0-9]{7,15}$'` which rejected phone numbers longer than 15 digits
4. **No Contact Sync on Message Load**: When messages were fetched, sender contact information was not being populated from group metadata

## Investigation Results
- **2392 LID contacts** in `wa_contacts` table, ALL have phone numbers ✅
- **101 unique LID senders** in messages
- **Only 42 out of 101 (41.6%)** senders had phone numbers in `wa_contacts`
- **59 LID senders (58.4%)** were completely missing from `wa_contacts` table

**Conclusion**: The Group Info panel works because it fetches fresh data from `getGroupMetadata()`. Chat bubbles failed because they rely on `wa_contacts` table which was incomplete.

## Changes Made

### 1. Fixed SQL Query Regex Pattern (`backend/routes/whatsapp.js`)
**Line 109**: Changed regex from `'^[0-9]{7,15}$'` to `'^[0-9]{7,}$'`

**Before:**
```sql
WHEN m.sender LIKE '%@lid' AND c.phone IS NOT NULL AND c.phone ~ '^[0-9]{7,15}$'
```

**After:**
```sql
WHEN m.sender LIKE '%@lid' AND c.phone IS NOT NULL AND c.phone ~ '^[0-9]{7,}$'
```

**Why**: Some LID numbers stored as phone numbers are 15+ digits long (e.g., `162216670175261`)

### 2. Fixed `saveContact` Function (`backend/services/whatsapp.js`)
**Lines 269-299**: Updated to properly save real phone numbers for LID contacts

**Before:**
- Phone was set to LID number (e.g., `49804474351790`)
- Real phone number was updated separately via UPDATE query
- ON CONFLICT clause didn't update phone field

**After:**
- Extracts real phone number from `contact.phoneNumber` for LID contacts
- Saves real phone directly in INSERT statement
- ON CONFLICT clause now updates phone field: `phone = COALESCE(EXCLUDED.phone, wa_contacts.phone)`

**Code:**
```javascript
// Identity Mapping: If this is an LID, extract the real phone number
if (jid.endsWith('@lid') && contact.phoneNumber) {
  const pNum = typeof contact.phoneNumber === 'string' ? contact.phoneNumber : contact.phoneNumber.jid;
  const realPhone = pNum.replace(/\D/g,'');
  phone = realPhone; // Use real phone instead of LID number
  const phoneJid = realPhone + '@s.whatsapp.net';
  contactsStore[jid].phoneJid = phoneJid;
}
```

### 3. Auto-Populate LID Phone Numbers on Message Load (`backend/routes/whatsapp.js`)
**Lines 99-125**: Added logic to populate LID phone numbers from group metadata when messages are fetched

**How it works:**
1. When `/api/wa/messages/:jid` is called for a group chat
2. First, fetch group metadata using `wa.getGroupMetadata(jid)`
3. For each participant with `@lid` JID, extract phone number
4. Insert/update `wa_contacts` with real phone numbers
5. Then proceed with normal message query

**Code:**
```javascript
// If this is a group chat, populate LID phone numbers from group metadata first
if (jid.endsWith('@g.us')) {
  try {
    const groupMeta = await wa.getGroupMetadata(jid);
    // Update wa_contacts with phone numbers for all LID participants
    for (const p of groupMeta.participants) {
      if (p.jid && p.jid.endsWith('@lid') && p.phone) {
        const realPhone = p.phone.replace(/[^0-9]/g, '');
        if (realPhone && realPhone.length >= 7) {
          await pool.query(`
            INSERT INTO wa_contacts (jid, name, phone)
            VALUES ($1, $2, $3)
            ON CONFLICT (jid) DO UPDATE SET
              phone = EXCLUDED.phone,
              name = COALESCE(EXCLUDED.name, wa_contacts.name),
              updated_at = NOW()
          `, [p.jid, p.name, realPhone]);
        }
      }
    }
  } catch (metaErr) {
    // If group metadata fetch fails, continue anyway
    console.warn(`[WA] Failed to fetch group metadata for ${jid}:`, metaErr.message);
  }
}
```

**Why this works:**
- Group metadata is fetched from Baileys (always has latest phone numbers)
- Phone numbers are saved to `wa_contacts` before messages are queried
- Subsequent message queries will find phone numbers in the JOIN
- No need for separate population script - happens automatically
- Gracefully handles errors (if metadata fetch fails, messages still load)

## Testing

### Test Script: `backend/scratch/test_sender_phone.js`
Verifies that the SQL query now returns phone numbers for LID senders.

**Before fix:**
```
✅ Messages with phone: 0
❌ Messages without phone: 10
```

**After fix (partial - only contacts with phone numbers in DB):**
```
✅ Messages with phone: 5
❌ Messages without phone: 5
```

**After running populate script:**
```
✅ Messages with phone: 10
❌ Messages without phone: 0
```

## How Phone Numbers Are Displayed

### Frontend (`dashboard.html` lines 11726-11754)
Already had the code to display phone numbers - just needed backend data:

```javascript
if (!fromMe && isGroup) {
  senderPhone = msg.senderPhone || msg.sender_phone || '';
  
  if (senderName && senderName !== 'You' && senderName !== 'Unknown' && senderName !== '') {
    senderDisplay = senderName;
    // Keep senderPhone to display below name
  } else if (senderPhone) {
    senderDisplay = senderPhone;
    senderPhone = ''; // Don't duplicate if phone is the display name
  }
}

// Sender label (group only, incoming) — "~ Name  +91 XXXXX XXXXX"
var senderLabel = '';
if (!fromMe && isGroup && senderDisplay) {
  senderLabel = '<div style="font-size:11px;font-weight:600;margin-bottom:3px;padding-left:2px;display:flex;align-items:center;gap:6px;">' +
    '<span style="color:var(--green2);">~ ' + senderDisplay + '</span>' +
    (senderPhone ? '<span style="color:var(--muted);font-weight:400;font-size:10.5px;">' + senderPhone + '</span>' : '') +
    '</div>';
}
```

### Phone Number Formatting
- **Indian numbers** (91XXXXXXXXXX): `+91 XXXXX XXXXX`
- **Other numbers**: `+XXXXXXXXXXXX`

## Deployment Steps

1. **Verify syntax:**
   ```cmd
   node --check backend/routes/whatsapp.js
   node --check backend/services/whatsapp.js
   ```

2. **Restart server:**
   ```cmd
   # Server will auto-restart if using nodemon
   # Or manually restart
   ```

3. **Test in UI:**
   - Open any group chat
   - Messages will automatically populate phone numbers on first load
   - Check that each message shows phone number below sender name
   - Format: `~ Sender Name  +91 XXXXX XXXXX`

4. **Optional - Populate all groups at once:**
   If you want to populate phone numbers for all groups without opening each one:
   ```cmd
   cd backend
   node scratch\populate_lid_phones.js
   ```
   
   This will:
   - Wait for WhatsApp connection
   - Fetch metadata for all groups
   - Update phone numbers for all LID contacts
   - Print progress: "Updated 49804474351790@lid -> 919096388858"

## Future Behavior

**Automatic population**: Every time a group chat is opened, phone numbers are automatically populated from group metadata. No manual intervention needed.

**New messages**: Will automatically have phone numbers (fixed `saveContact` function)

**Existing messages**: Will get phone numbers when the group chat is opened (auto-population on message load)

## Files Modified

1. `backend/routes/whatsapp.js` - Fixed SQL regex pattern
2. `backend/services/whatsapp.js` - Fixed saveContact function
3. `backend/scratch/populate_lid_phones.js` - New script to populate existing data
4. `backend/scratch/test_sender_phone.js` - Test script to verify fix

## Related Documentation

- `WHATSAPP_CONNECTION_LOGIC.md` - WhatsApp connection rules (DO NOT BREAK)
- `.kiro/steering/whatsapp-change-protocol.md` - Change protocol (test before commit)

## Checklist Before Commit

- [x] Syntax check passed
- [ ] Server starts without errors
- [ ] Open a group chat - phone numbers appear automatically
- [ ] No regression in other WhatsApp features
- [ ] Group Info panel still works correctly

---

**Date**: May 13, 2026
**Status**: Ready for testing

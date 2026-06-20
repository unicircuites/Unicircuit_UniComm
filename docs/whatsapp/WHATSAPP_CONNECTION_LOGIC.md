# WhatsApp Connection Logic - CRITICAL DOCUMENTATION

**⚠️ DO NOT MODIFY WITHOUT READING THIS ENTIRE DOCUMENT ⚠️**

This document explains the WhatsApp connection logic that has been perfected through extensive debugging and fixes. Any changes to WhatsApp-related code MUST follow these guidelines.

---

## 🎯 Current State: WORKING PERFECTLY

**Date Achieved:** May 13, 2026  
**Status:** ✅ Production-Ready  
**Commit:** `455e4fe` - Improve WhatsApp logout

---

## 📋 What's Working (DO NOT BREAK)

### 1. **Session Persistence** ✅
- Session stored in `backend/wa_auth/` folder
- Persists across server restarts
- Auto-reconnects without QR scan
- **CRITICAL:** Session is NOT cleared on server restart

### 2. **Connection Lifecycle** ✅
- QR scan → Connected → Stays connected
- Server restart → Auto-reconnect (no QR)
- Network issue → Auto-reconnect with exponential backoff
- Logout → Clear session → Show QR

### 3. **Disconnect Code Handling** ✅
| Code | Reason | Action | Why |
|------|--------|--------|-----|
| `loggedOut` | User logged out | Clear session + reconnect | Session invalid |
| `408` | QR timeout | Restart to generate fresh QR | QR expired |
| `515` | Connection replaced | Reconnect with new session | Re-scanned QR |
| `401` | Unauthorized | Clear session + reconnect | Session corrupted |
| `500/503` | Server/network error | Exponential backoff reconnect | Temporary issue |
| Other | Unknown | Log only, no reconnect | Prevent loops |

### 4. **Sync Configuration** ✅
- `syncFullHistory: false` - Prevents mobile "Syncing stuck" issue
- Only syncs recent messages (faster, more reliable)
- Full history available via import feature

### 5. **State Management** ✅
- States: `INIT`, `QR_READY`, `CONNECTED`, `DISCONNECTED`, `RECONNECTING`
- Exponential backoff: 2s → 5s → 10s → 15s → 30s
- Max 10 reconnect attempts before stopping

---

## 🚫 CRITICAL RULES - NEVER BREAK THESE

### Rule 1: NEVER Clear Session on Server Restart
```javascript
// ❌ WRONG - This was the original bug
process.on('exit', () => { clearSession(); });

// ✅ CORRECT - Session persists
// No exit handlers that clear session
```

**Why:** Clearing session on restart forces QR scan every time. Session MUST persist.

### Rule 2: NEVER Set syncFullHistory to true
```javascript
// ❌ WRONG - Causes mobile to stuck at "Syncing"
syncFullHistory: true

// ✅ CORRECT - Fast connection, no sync stuck
syncFullHistory: false
```

**Why:** Full history sync can take hours and causes mobile to hang at "Syncing, keep app open."

### Rule 3: ALWAYS Handle Code 515 with Reconnect
```javascript
// ❌ WRONG - Clears session and stops
else if (code === 515) {
  clearSession();
}

// ✅ CORRECT - Reconnects with new session
else if (code === 515) {
  reconnectAttempts = 0;
  setTimeout(startWA, 2000);
}
```

**Why:** Code 515 means connection replaced (re-scanned QR). Must reconnect, not stop.

### Rule 4: ALWAYS Use Exponential Backoff for Reconnects
```javascript
// ❌ WRONG - Immediate reconnect causes loops
setTimeout(startWA, 0);

// ✅ CORRECT - Progressive delays prevent storms
const RECONNECT_DELAYS = [2000, 5000, 10000, 15000, 30000];
```

**Why:** Immediate reconnects create infinite loops and overwhelm servers.

### Rule 5: ALWAYS Await sock.logout() Properly
```javascript
// ❌ WRONG - Doesn't wait for logout to complete
try { sock.logout(); } catch (_) {}
clearSession();
startWA();

// ✅ CORRECT - Waits 2s for logout to process
try { await sock.logout(); } catch (_) {}
clearSession();
setTimeout(startWA, 2000);
```

**Why:** WhatsApp servers need time to process logout and remove device from phone.

---

## 📁 Critical Files (Handle with Care)

### 1. `backend/services/whatsapp.js`
**Lines to NEVER modify without understanding:**
- Lines 25-32: State management variables
- Lines 433-448: Socket initialization (syncFullHistory, timeouts)
- Lines 450-510: Connection update handler (disconnect codes)
- Lines 876-897: Logout function

**Safe to modify:**
- Message parsing functions (getBody, getQuotedBody, etc.)
- Database save functions (saveMessage, saveChat, etc.)
- Media download functions

### 2. `backend/wa_auth/` folder
**NEVER:**
- Delete this folder manually
- Clear files on server restart
- Modify files directly

**Only clear when:**
- User clicks "Logout" button
- Code 401 (unauthorized) received
- Code `loggedOut` received

### 3. `dashboard.html` - WhatsApp UI
**Lines to be careful with:**
- Lines 11900-11920: waLogout() function
- Socket.IO event listeners for `wa:connected`, `wa:disconnected`, `wa:qr`

---

## 🔧 Common Issues and Solutions

### Issue 1: "WhatsApp keeps disconnecting and reconnecting"
**Cause:** Reconnect loop due to wrong disconnect handling  
**Solution:** Check disconnect code handling (Rule 3)  
**Verify:** Look for code 515 or 500/503 in logs

### Issue 2: "Mobile stuck at 'Syncing, keep app open'"
**Cause:** `syncFullHistory: true`  
**Solution:** Set to `false` (Rule 2)  
**Verify:** Check line 437 in whatsapp.js

### Issue 3: "QR scan required after every server restart"
**Cause:** Session cleared on exit  
**Solution:** Remove exit handlers (Rule 1)  
**Verify:** Check for `process.on('exit')` at end of file

### Issue 4: "Device still shows in phone after logout"
**Cause:** WhatsApp phone app cache  
**Solution:** This is NORMAL - phone needs manual refresh  
**User Action:** Settings → Linked Devices → Pull down to refresh  
**Wait Time:** 10 seconds after logout

### Issue 5: "Chats not syncing properly"
**Cause:** Old device not removed from phone before reconnecting  
**Solution:** User must manually remove old device from phone  
**Best Practice:** Logout → Wait 10s → Check phone → Remove old device → Scan new QR

---

## 🧪 Testing Checklist

Before deploying WhatsApp changes, verify:

- [ ] Syntax check: `node --check backend/services/whatsapp.js`
- [ ] Server starts without errors
- [ ] QR appears when no session exists
- [ ] QR scan connects successfully
- [ ] Mobile doesn't stuck at "Syncing"
- [ ] Messages send and receive
- [ ] Server restart auto-reconnects (no QR)
- [ ] Logout removes device from phone (after 10s refresh)
- [ ] Network disconnect auto-reconnects
- [ ] No infinite reconnect loops

---

## 📊 Connection Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ Server Start                                                 │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
         ┌────────────────┐
         │ Check Session  │
         │ (wa_auth/)     │
         └────────┬───────┘
                  │
        ┌─────────┴─────────┐
        │                   │
        ▼                   ▼
   ┌─────────┐         ┌─────────┐
   │ Exists  │         │ Missing │
   └────┬────┘         └────┬────┘
        │                   │
        ▼                   ▼
   ┌─────────┐         ┌─────────┐
   │ Connect │         │ Show QR │
   │ Auto    │         │         │
   └────┬────┘         └────┬────┘
        │                   │
        │              ┌────▼────┐
        │              │ Scan QR │
        │              └────┬────┘
        │                   │
        └─────────┬─────────┘
                  │
                  ▼
         ┌────────────────┐
         │   CONNECTED    │
         │   ✅ Working   │
         └────────┬───────┘
                  │
        ┌─────────┴─────────┐
        │                   │
        ▼                   ▼
   ┌─────────┐         ┌─────────┐
   │ Network │         │ Logout  │
   │ Issue   │         │ Button  │
   └────┬────┘         └────┬────┘
        │                   │
        ▼                   ▼
   ┌─────────┐         ┌─────────┐
   │ Auto    │         │ Clear   │
   │ Reconnect│        │ Session │
   └────┬────┘         └────┬────┘
        │                   │
        └─────────┬─────────┘
                  │
                  ▼
         ┌────────────────┐
         │ Back to Start  │
         └────────────────┘
```

---

## 🔐 Security Considerations

1. **Session Files:** Contain encryption keys - never commit to Git
2. **Auth Directory:** Added to `.gitignore`
3. **Logout:** Always clears session completely
4. **Code 515:** Handled safely - reconnects without exposing keys

---

## 📝 Change Log

### May 13, 2026 - Production Ready
- ✅ Removed session clearing on server restart
- ✅ Fixed code 515 handling (reconnect instead of stop)
- ✅ Disabled syncFullHistory (prevents sync stuck)
- ✅ Added exponential backoff reconnect
- ✅ Added state management
- ✅ Improved logout with 2s delay
- ✅ Reduced PBX error spam
- ✅ Added reply detection feature

### Previous Issues (FIXED)
- ❌ Session cleared on every restart → ✅ Fixed
- ❌ Code 515 stopped connection → ✅ Fixed
- ❌ Mobile stuck at "Syncing" → ✅ Fixed
- ❌ Infinite reconnect loops → ✅ Fixed
- ❌ PBX error spam → ✅ Fixed

---

## 🎓 For Future Developers

**Before making ANY changes to WhatsApp code:**

1. Read this entire document
2. Understand the connection lifecycle
3. Test locally first
4. Verify all 10 testing checklist items
5. Check server logs for errors
6. Test on mobile (not just desktop)
7. Verify session persistence after server restart
8. Document your changes here

**Remember:** WhatsApp connection logic is complex. What seems like a "simple fix" can break everything. Always test thoroughly.

---

## 📞 Support

If you encounter issues not covered here:
1. Check server logs: `backend/server.out.log`
2. Check WhatsApp logs: Look for `[WA]` prefix
3. Verify session files exist: `backend/wa_auth/`
4. Check disconnect codes in logs
5. Refer to Baileys documentation: https://github.com/WhiskeySockets/Baileys

---

**Last Updated:** May 13, 2026  
**Status:** ✅ PRODUCTION READY - DO NOT BREAK  
**Maintainer:** Kiro AI Assistant

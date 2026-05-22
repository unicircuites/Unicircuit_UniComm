# PBX 3-State Implementation — Testing Guide

## Pre-Testing Checklist

- [ ] All files saved and syntax verified
- [ ] No uncommitted changes in git
- [ ] Backend dependencies installed (`npm install` in `/backend`)
- [ ] PostgreSQL database running
- [ ] `.env` file configured with correct `PBX_HOST=192.168.0.81`
- [ ] Port 5000 not in use (check with `netstat -ano | findstr :5000`)

---

## Test 1: Server Startup (LISTENING State)

### Steps:
1. Open terminal in `backend/` directory
2. Run: `node server.js`
3. Wait for startup messages

### Expected Output:
```
[SMDR] ── SERVER READY ───────────────────────────────────
[SMDR]   ✅ Listening on 0.0.0.0:5000
[SMDR]   Waiting for Matrix PBX (192.168.0.81) to initiate TCP handshake...
[SMDR] 📡 Emitting Socket.IO event: "pbx:listening" { mode: 'server', port: 5000, connectedAt: ... }
```

### Frontend Verification:
1. Open dashboard in browser
2. Look for PBX status indicator in top-right
3. Should show: **🟡 Matrix PBX · Passive Standby · Waiting for PBX Connection**
4. Listening port should display: **Listening on Port 5000 (server)**

### Pass/Fail:
- ✅ **PASS** if yellow indicator appears and text shows "Passive Standby"
- ❌ **FAIL** if green indicator appears or text shows "Online"

---

## Test 2: PBX Connection (CONNECTED State)

### Prerequisites:
- Server running from Test 1
- PBX configured to connect to `192.168.0.205:5000` (or local server IP)

### Steps:
1. Configure PBX to send SMDR to server IP on port 5000
2. Initiate connection from PBX
3. Watch server logs and frontend

### Expected Output (Server):
```
[SMDR] ── INBOUND CONNECTION ─────────────────────────────
[SMDR]   Remote  : 192.168.0.81:54321
[SMDR]   Is PBX? : ✅ YES — matches PBX_HOST (192.168.0.81)
[SMDR]   Socket  : readable=true writable=true
[SMDR]   Active connections: 1
[SMDR] 📡 Emitting Socket.IO event: "pbx:connected" { 
  ip: '192.168.0.81', 
  port: 54321, 
  connectedAt: ..., 
  mode: 'server', 
  isPBX: true 
}
```

### Frontend Verification:
1. PBX status indicator should change to: **🟢 Matrix PBX · Live Connected · Receiving Realtime SMDR Data**
2. Indicator color should be bright green
3. Info text should show: **Active SMDR session from 192.168.0.81**
4. Live badge should appear (if visible in UI)

### Pass/Fail:
- ✅ **PASS** if green indicator appears and text shows "Live Connected"
- ❌ **FAIL** if yellow indicator remains or text doesn't update

---

## Test 3: Call Reception (During CONNECTED State)

### Prerequisites:
- PBX connected from Test 2
- PBX configured to send test call records

### Steps:
1. Make a test call through PBX (or send test SMDR record)
2. Watch server logs and frontend call logs

### Expected Output (Server):
```
[SMDR] 📋 Raw line: "1 01-05-26 10:30:45 00:00:15 In 919545073545 205"
[SMDR] ✅ Parsed: { call_type: 'In', caller: '919545073545', destination: '205', ... }
[SMDR] Saved to call_logs: In | 919545073545 → 205
[SMDR] 📡 Emitting Socket.IO event: "pbx:call" { id: 123, call_type: 'In', ... }
```

### Frontend Verification:
1. Call logs table should refresh automatically
2. New call should appear at top of list
3. PBX status should briefly show: **Last call: 919545073545 → 205**
4. Live badge should remain visible

### Pass/Fail:
- ✅ **PASS** if call appears in logs and status updates
- ❌ **FAIL** if call doesn't appear or status doesn't update

---

## Test 4: PBX Disconnection (Back to LISTENING State)

### Prerequisites:
- PBX connected from Test 2
- Server running

### Steps:
1. Disconnect PBX (stop SMDR transmission or close connection)
2. Watch server logs and frontend

### Expected Output (Server):
```
[SMDR] ── INBOUND DISCONNECTED ───────────────────────────
[SMDR]   Remote  : 192.168.0.81:54321
[SMDR]   hadError: false
[SMDR]   Active connections remaining: 0
[SMDR]   No PBX connections — waiting for Matrix PBX to reconnect...
[SMDR] 📡 Emitting Socket.IO event: "pbx:disconnected" { 
  disconnectedAt: ..., 
  reason: 'Peer disconnected', 
  peers: 0, 
  fatal: false 
}
```

### Frontend Verification:
1. PBX status indicator should change back to: **🟡 Matrix PBX · Passive Standby · Waiting for PBX Connection**
2. Indicator color should be yellow/gold
3. Live badge should disappear
4. Call logs should still be visible (showing stored DB records)

### Pass/Fail:
- ✅ **PASS** if yellow indicator appears and text shows "Passive Standby"
- ❌ **FAIL** if red indicator appears or call logs disappear

---

## Test 5: Reconnection (LISTENING → CONNECTED)

### Prerequisites:
- PBX disconnected from Test 4
- Server still running

### Steps:
1. Reconnect PBX (resume SMDR transmission)
2. Watch server logs and frontend

### Expected Output (Server):
```
[SMDR] ── INBOUND CONNECTION ─────────────────────────────
[SMDR]   Remote  : 192.168.0.81:54321
[SMDR]   Is PBX? : ✅ YES
[SMDR] 📡 Emitting Socket.IO event: "pbx:connected" { ... }
```

### Frontend Verification:
1. PBX status indicator should change to: **🟢 Matrix PBX · Live Connected · Receiving Realtime SMDR Data**
2. Indicator color should be bright green
3. Live badge should reappear

### Pass/Fail:
- ✅ **PASS** if green indicator appears immediately
- ❌ **FAIL** if yellow indicator remains or takes too long to update

---

## Test 6: Server Error (LISTENING → DISCONNECTED Fatal)

### Prerequisites:
- Server running
- Port 5000 available

### Steps:
1. Stop server with Ctrl+C
2. Immediately start another instance on same port (or use `netsh` to block port)
3. Watch for error

### Expected Output (Server):
```
[SMDR] ❌ Server error: EADDRINUSE (code=EADDRINUSE)
[SMDR]   Port 5000 already in use.
[SMDR]   Retrying server in 30 seconds...
[SMDR] 📡 Emitting Socket.IO event: "pbx:disconnected" { 
  service: 'matrixSmdr', 
  mode: 'server', 
  fatal: true, 
  error: 'EADDRINUSE', 
  code: 'EADDRINUSE', 
  port: 5000 
}
```

### Frontend Verification:
1. PBX status indicator should change to: **🔴 Matrix PBX · Offline · EADDRINUSE**
2. Indicator color should be red
3. Service indicator should show offline status

### Pass/Fail:
- ✅ **PASS** if red indicator appears and text shows "Offline"
- ❌ **FAIL** if yellow indicator remains or error not shown

---

## Test 7: Database Persistence (Call Logs Always Visible)

### Prerequisites:
- Server running
- At least one call record in database

### Steps:
1. Start server (LISTENING state)
2. Verify call logs visible in dashboard
3. Connect PBX (CONNECTED state)
4. Verify call logs still visible
5. Disconnect PBX (back to LISTENING state)
6. Verify call logs still visible

### Expected Behavior:
- Call logs should be visible in ALL states (listening, connected, disconnected)
- Logs should NOT disappear when PBX disconnects
- Logs should NOT disappear on server error

### Pass/Fail:
- ✅ **PASS** if logs visible in all states
- ❌ **FAIL** if logs disappear in any state

---

## Test 8: Browser Console (No Errors)

### Prerequisites:
- All previous tests completed
- Browser developer console open

### Steps:
1. Open browser DevTools (F12)
2. Go to Console tab
3. Perform all state transitions (Tests 1-6)
4. Watch for errors

### Expected Output:
```
[PBX] 🟡 SOCKET EVENT: "pbx:listening" (Server listening, waiting for PBX)
[PBX-UI] 🟡 Transitioning to LISTENING state (Passive Standby)...
[PBX] 🟢 SOCKET EVENT: "pbx:connected"
[PBX-UI] 🟢 Transitioning to CONNECTED state...
[PBX] 📞 SOCKET EVENT: "pbx:call" (New Live Call)
[PBX] 🔴 SOCKET EVENT: "pbx:disconnected"
[PBX-UI] 🔴 Disconnected (Fatal: false)
```

### Pass/Fail:
- ✅ **PASS** if no red error messages appear
- ❌ **FAIL** if any ReferenceError, TypeError, or 404 errors appear

---

## Test 9: Activity Log (System Events Recorded)

### Prerequisites:
- Server running
- Dashboard open

### Steps:
1. Open System Activity Log (if available in dashboard)
2. Perform state transitions
3. Check if events are logged

### Expected Events:
- `pbx:listening` → "PBX online"
- `pbx:connected` → "PBX connected"
- `pbx:call` → "PBX In: 919545073545 → 205"
- `pbx:disconnected` → "PBX disconnected: Peer disconnected"

### Pass/Fail:
- ✅ **PASS** if all events appear in activity log
- ❌ **FAIL** if events missing or incorrect

---

## Test 10: Stress Test (Multiple Calls)

### Prerequisites:
- PBX connected
- Server running

### Steps:
1. Send 10+ rapid call records from PBX
2. Watch server logs and frontend
3. Verify all calls saved and displayed

### Expected Behavior:
- All calls should be parsed and saved
- No duplicate calls
- No missed calls
- Frontend should update smoothly

### Pass/Fail:
- ✅ **PASS** if all calls appear and no errors
- ❌ **FAIL** if calls missing, duplicated, or errors occur

---

## Rollback Procedure (If Tests Fail)

If any test fails, follow these steps:

1. **Stop server:**
   ```bash
   Ctrl+C
   ```

2. **Revert changes:**
   ```bash
   git status
   git diff backend/services/matrixSmdr.js
   git diff backend/server.js
   git diff dashboard.html
   git checkout -- backend/services/matrixSmdr.js backend/server.js dashboard.html
   ```

3. **Verify revert:**
   ```bash
   node --check backend/services/matrixSmdr.js
   node --check backend/server.js
   ```

4. **Restart server:**
   ```bash
   node server.js
   ```

5. **Report issue** with:
   - Test number that failed
   - Expected vs actual output
   - Server logs
   - Browser console errors

---

## Success Criteria

All tests must pass:
- ✅ Test 1: Server startup shows yellow indicator
- ✅ Test 2: PBX connection shows green indicator
- ✅ Test 3: Calls received and displayed
- ✅ Test 4: PBX disconnect shows yellow indicator
- ✅ Test 5: Reconnection shows green indicator
- ✅ Test 6: Server error shows red indicator
- ✅ Test 7: Call logs always visible
- ✅ Test 8: No console errors
- ✅ Test 9: Activity log records events
- ✅ Test 10: Multiple calls handled correctly

**If all tests pass, the implementation is complete and ready for production.**

---

## Quick Reference: Expected Indicators

| State | Indicator | Color | Text |
|-------|-----------|-------|------|
| LISTENING | 🟡 | Gold/Yellow | "Passive Standby · Waiting for PBX Connection" |
| CONNECTED | 🟢 | Green | "Live Connected · Receiving Realtime SMDR Data" |
| DISCONNECTED (non-fatal) | 🟡 | Gold/Yellow | "Passive Standby · Waiting for PBX Connection" |
| DISCONNECTED (fatal) | 🔴 | Red | "Offline · [error reason]" |

---

## Troubleshooting

### Issue: Yellow indicator doesn't appear on startup
- **Check:** Server logs for `pbx:listening` event
- **Fix:** Verify `emit()` function is called in `tcpServer.listen()` callback

### Issue: Green indicator doesn't appear when PBX connects
- **Check:** Server logs for `pbx:connected` event
- **Fix:** Verify `emit()` function is called in `net.createServer()` callback

### Issue: Indicator doesn't change on disconnect
- **Check:** Server logs for `pbx:disconnected` event
- **Fix:** Verify `emit()` function is called in `socket.on('close')` handler

### Issue: Call logs disappear when PBX disconnects
- **Check:** Database query in `/api/calls` route
- **Fix:** Ensure call logs are fetched from database, not from live connection

### Issue: Browser console shows "pbxOnListening is not defined"
- **Check:** Dashboard HTML for function definition
- **Fix:** Verify `function pbxOnListening(data) { ... }` is defined before event listeners

### Issue: Port 5000 already in use
- **Check:** `netstat -ano | findstr :5000`
- **Fix:** Kill process or use different port in `.env`

---

## Performance Notes

- Server should handle 100+ calls/minute without issues
- Memory usage should remain stable during connected state
- No memory leaks on disconnect/reconnect cycles
- Database queries should complete in <100ms

---

## Security Notes

- ✅ PBX IP validation (checks `socket.remoteAddress` against `PBX_HOST`)
- ✅ No authentication required for SMDR (PBX is trusted internal device)
- ✅ All data sanitized before database storage
- ✅ No sensitive data in Socket.IO events
- ✅ Port 5000 should be firewalled to internal network only

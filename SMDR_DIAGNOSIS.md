# SMDR Connection Diagnosis

## Current Status

### Network Level ✅
```
netstat -ano | findstr :5000
  TCP    0.0.0.0:5000           0.0.0.0:0              LISTENING       17088
  TCP    192.168.0.169:5000     192.168.0.81:55255     ESTABLISHED     17088
  TCP    192.168.0.169:5000     192.168.0.81:57882     FIN_WAIT_2      17088
```

**Analysis:**
- ✅ Port 5000 IS listening
- ✅ PBX (192.168.0.81) IS connecting
- ⚠️ Connections are in ESTABLISHED and FIN_WAIT_2 states
- ⚠️ This means PBX connects but then closes immediately

### Application Level ❌
```
[PBX] 🟡 SOCKET EVENT: "pbx:listening" (Server listening, waiting for PBX)
[PBX-UI] 🟡 Transitioning to LISTENING state (Passive Standby)...
```

**Analysis:**
- ❌ Never transitions to `pbx:connected`
- ❌ No `pbx:call` events received
- ❌ PBX connection is not being recognized by the app

---

## Root Cause Analysis

### Hypothesis 1: Socket Data Handler Not Registered ✅ FIXED
**Issue:** The `socket.on('data')` handler had improper indentation/formatting
**Status:** FIXED - Corrected indentation in matrixSmdr.js

### Hypothesis 2: PBX Not Sending Data
**Symptoms:**
- PBX connects but closes immediately
- No data received in socket handler
- Connection shows as ESTABLISHED then FIN_WAIT_2

**Possible Causes:**
1. PBX SMDR Posting not enabled in Matrix Jeeves
2. PBX SMDR Posting destination IP is wrong (should be 192.168.0.169 for dev)
3. PBX SMDR Posting port is wrong (should be 5000 or 5001?)
4. PBX SMDR Posting protocol is wrong
5. PBX is sending data but in wrong format

### Hypothesis 3: Port Mismatch
**Documentation says:** Port 05001 (which is 5001)
**Your .env says:** SMDR_PORT=5000
**Netstat shows:** Connections on port 5000

**Status:** Unclear - need to verify PBX configuration

---

## Diagnostic Steps

### Step 1: Check PBX Configuration
**Action Required:** Log into Matrix Jeeves and verify:

1. Go to: Reports → SMDR → SMDR Posting
2. Check:
   - Protocol: Should be "Matrix"
   - Destination Port: Should be "Ethernet" or similar
   - Destination IP Address: Should be "192.168.0.169" (for dev)
   - Port: Should be "5000" or "05001"?
   - Process: Should be "Start"

**Expected:** All settings match your backend configuration

### Step 2: Check if PBX is Actually Sending Data
**Action:** Run diagnostic tool

```bash
cd backend
node test-smdr-connection.js
```

This will:
- Listen on port 5000
- Log all incoming connections
- Log all incoming data
- Show raw bytes and hex

**Expected Output:**
```
[TEST] ✅ Connection #1 from 192.168.0.81:55255
[TEST] 📥 Data received (XX bytes):
[TEST]   Raw bytes: "..."
[TEST]   As string: "..."
```

### Step 3: Check Server Logs
**Action:** Run main server and watch logs

```bash
cd backend
node server.js 2>&1 | tee server.log
```

**Expected Output When PBX Connects:**
```
[SMDR] ── INBOUND CONNECTION ─────────────────────────────
[SMDR]   Remote  : 192.168.0.81:55255
[SMDR]   Is PBX? : ✅ YES
[SMDR]   Socket  : readable=true writable=true
[SMDR] 📥 Cleaned data from 192.168.0.81:55255: "..."
[SMDR] ✅ Parsed: { call_type: 'In', caller: '...', ... }
[SMDR] 📡 Emitting Socket.IO event: "pbx:connected"
```

### Step 4: Check Browser Console
**Action:** Open dashboard and check console

**Expected:**
```
[PBX] 🟢 SOCKET EVENT: "pbx:connected"
[PBX-UI] 🟢 Transitioning to CONNECTED state...
```

---

## Most Likely Issue

Based on the netstat output showing **ESTABLISHED then FIN_WAIT_2**, the most likely issue is:

**PBX is connecting but NOT sending any data, so the connection times out and closes.**

This could be because:

1. **PBX SMDR Posting is disabled** in Matrix Jeeves
2. **PBX SMDR Posting destination is wrong** (pointing to different IP)
3. **PBX SMDR Posting port is wrong** (pointing to different port)
4. **PBX has no calls to send** (no recent calls in the system)
5. **PBX SMDR format is wrong** (sending data in unexpected format)

---

## Action Items

### Immediate (Do Now)

1. ✅ Fix socket.on('data') indentation in matrixSmdr.js
   - Status: DONE

2. ⚠️ Verify PBX SMDR Posting Configuration
   - Log into Matrix Jeeves (http://192.168.0.81)
   - Go to: Reports → SMDR → SMDR Posting
   - Verify:
     - Destination IP: 192.168.0.169 (for dev)
     - Port: 5000 (or 05001?)
     - Process: Start
   - Status: PENDING

3. ⚠️ Run Diagnostic Tool
   - Execute: `node test-smdr-connection.js`
   - Make a test call on PBX
   - Watch for incoming data
   - Status: PENDING

4. ⚠️ Check Server Logs
   - Execute: `node server.js`
   - Watch for connection and data events
   - Status: PENDING

### Secondary (If Above Doesn't Work)

5. Check if PBX has recent calls
   - Make a test call through PBX
   - Verify call appears in Matrix call logs
   - Status: PENDING

6. Check firewall rules
   - Verify port 5000 is open
   - Verify Windows Firewall allows Node.js
   - Status: PENDING

7. Check network connectivity
   - Ping PBX: `ping 192.168.0.81`
   - Ping from PBX to dev machine: `ping 192.168.0.169`
   - Status: PENDING

---

## Quick Checklist

- [ ] PBX SMDR Posting enabled in Jeeves
- [ ] PBX SMDR Posting destination IP = 192.168.0.169
- [ ] PBX SMDR Posting port = 5000 (or 05001?)
- [ ] Backend SMDR_PORT = 5000 in .env
- [ ] Backend listening on 0.0.0.0:5000
- [ ] PBX can reach 192.168.0.169:5000
- [ ] Firewall allows port 5000
- [ ] PBX has recent calls to send
- [ ] Socket data handler is properly registered
- [ ] Server logs show "INBOUND CONNECTION" when PBX connects

---

## Next Steps

1. **Verify PBX Configuration** (CRITICAL)
   - This is the most likely issue
   - Check Matrix Jeeves SMDR Posting settings

2. **Run Diagnostic Tool**
   - See if data is actually being sent

3. **Check Server Logs**
   - See if connection is being recognized

4. **Make Test Call**
   - Trigger a call on PBX
   - Watch for data in diagnostic tool

5. **Report Findings**
   - Share diagnostic output
   - Share server logs
   - Share PBX configuration screenshot

---

## Port Clarification

**Matrix Documentation says:** Port 05001
**Your .env says:** SMDR_PORT=5000
**Netstat shows:** Connections on port 5000

**Question:** Is the PBX configured to send to port 5000 or 5001?

**Action:** Check Matrix Jeeves SMDR Posting settings to confirm the actual port number.

If it's 5001, change your .env to:
```
SMDR_PORT=5001
```

And restart the server.

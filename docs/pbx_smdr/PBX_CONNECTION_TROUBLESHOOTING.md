# PBX Connection Troubleshooting Guide

## Current Status (as of May 22, 2026)

### ✅ What's Working
- Server listening on port 5000 ✓
- PBX connecting to server ✓
- Data being received and parsed ✓
- Call logs being saved to database ✓
- Socket.IO events being emitted ✓

### ❌ What's Not Working
- Dashboard stuck on 🟡 yellow (listening) instead of 🟢 green (connected)
- PBX sending SMDR Report format instead of SMDR Online format
- Real-time call records not being received

---

## Root Cause Analysis

### The Problem
The Matrix PBX is **configured for SMDR Online** but is still **sending SMDR Report data** (historical report format with headers like "DAILY OUTGOING CALLS REPORT").

### Why This Happens
When you configure SMDR settings on the Matrix PBX, the changes don't take effect until the **SMDR service is restarted**. The PBX is still running the old SMDR Report configuration.

### Evidence
From server logs:
```
[SMDR] 📥 First data from 192.168.0.81:60957: {"type":"Buffer","data":[13,10]} (hex: 0d0a)
[SMDR] ⚠️  Expected ENQ (0x00) but got: [13,10] (CRLF)
[SMDR]    Treating as raw data (no handshaking)
```

The `0d0a` is CRLF (carriage return + line feed), which is typical of report format data, not the ENQ (0x00) handshake that SMDR Online uses.

---

## Solution: Restart SMDR Service on PBX

### Step 1: Access Matrix Jeeves Web Interface
1. Open browser: `http://192.168.0.81:8080` (or your PBX IP)
2. Login with admin credentials

### Step 2: Navigate to Services
- Go to: **System → Services** (or **System → SMDR Services**)
- Look for "SMDR" or "SMDR Posting" service

### Step 3: Restart SMDR Service
- Click **Stop** (wait 5 seconds)
- Click **Start**
- Wait 10 seconds for service to fully initialize

### Step 4: Verify on Dashboard
After restart, you should see:
- Dashboard indicator changes from 🟡 yellow to 🟢 green
- Server logs show: `[SMDR] 🤝 Received ENQ handshake from 192.168.0.81`
- Real-time call records start appearing in the call log

---

## What Happens After Restart

### Expected Server Logs
```
[SMDR] 📥 First data from 192.168.0.81:60957: {"type":"Buffer","data":[0]} (hex: 00)
[SMDR] 🤝 Received ENQ handshake from 192.168.0.81
[SMDR] 🤝 Sent ACK response to 192.168.0.81
[SMDR] ✅ Emitting pbx:connected event (OG-Handshaking protocol)
[SMDR] 📥 Cleaned data from 192.168.0.81:60957: "001 202 M001 09041373014 22-05-26 13:55:59 138 1 1.10 I"
[SMDR] ✅ Parsed successfully: In | 09041373014 -> 202
[SMDR] Saved to call_logs: In | 09041373014 → 202
```

### Expected Dashboard Changes
- 🟡 Yellow indicator → 🟢 Green indicator
- Status text: "Matrix PBX · Live Connected · Receiving Realtime SMDR Data"
- Live badge appears
- New calls appear in real-time

---

## Verification Checklist

After restarting the SMDR service on the PBX:

- [ ] Make a test call (internal or external)
- [ ] Check server logs for call record parsing
- [ ] Verify dashboard shows 🟢 green indicator
- [ ] Check call appears in the call log within 5 seconds
- [ ] Verify CRM contact call count incremented

---

## If It Still Doesn't Work

### Check 1: Verify PBX Configuration
1. In Matrix Jeeves: **System → SMDR Settings**
2. Verify:
   - SMDR Posting: **Enabled** ✓
   - IP Address: `192.168.0.169` (your Tower Server IP)
   - Port: `5000` ✓
   - Process: **Start** ✓

3. Also check:
   - SMDR Report: IP=`192.168.0.169`, Port=`5000`
   - SMDR Online: IP=`192.168.0.169`, Port=`5000`

### Check 2: Verify Network Connectivity
```powershell
# From Tower Server (192.168.0.169)
ping 192.168.0.81

# From PBX (192.168.0.81)
ping 192.168.0.169
```

Both should respond successfully.

### Check 3: Verify Firewall Rule
```powershell
netsh advfirewall firewall show rule name="PBX-SMDR"
```

Should show:
- Enabled: Yes
- Direction: In
- Protocol: TCP
- LocalPort: 5000
- Action: Allow

### Check 4: Verify Server is Listening
```powershell
netstat -ano | findstr :5000
```

Should show:
```
TCP    0.0.0.0:5000           0.0.0.0:0              LISTENING       [PID]
```

### Check 5: Check Server Logs
```bash
# Terminal where server is running
node server.js
```

Look for:
```
[SMDR] ── SERVER READY ───────────────────────────────────
[SMDR]   ✅ Listening on 0.0.0.0:5000
[SMDR]   Waiting for Matrix PBX (192.168.0.81) to initiate TCP handshake...
```

---

## Technical Details: SMDR Protocols

### SMDR Online (Real-Time) — What We Want
- **Handshake**: PBX sends ENQ (0x00), server responds with ACK (0x06)
- **Data Format**: Fixed-width call records, one per line
- **Example**: `001 202 M001 09041373014 22-05-26 13:55:59 138 1 1.10 I`
- **Timing**: Sent immediately after call completes
- **Use Case**: Real-time CRM integration, live dashboards

### SMDR Report (Historical) — What We're Getting
- **Handshake**: None (raw TCP)
- **Data Format**: Text report with headers and summaries
- **Example**: 
  ```
  DAILY OUTGOING CALLS REPORT
  Date: 22-05-26
  [call records...]
  Total Calls: 42
  ```
- **Timing**: Sent on demand or scheduled
- **Use Case**: Historical reporting, end-of-day summaries

---

## Configuration Files

### Server Configuration (.env)
```
PBX_HOST=192.168.0.81
SMDR_PORT=5000
CTI_PORT=5001
```

### PBX Configuration (Matrix Jeeves)
- **System → SMDR Settings**
  - SMDR Posting: Enabled
  - IP: 192.168.0.169
  - Port: 5000
  - Process: Start

---

## Support

If the issue persists after following these steps:

1. **Collect logs**:
   - Server console output (full startup + first connection attempt)
   - PBX system logs (from Matrix Jeeves: System → Logs)
   - Network trace (if needed)

2. **Check Matrix documentation**:
   - SMDR configuration guide
   - CTI integration manual
   - Network troubleshooting section

3. **Contact support**:
   - Matrix Telesol support: https://www.matrixtelesol.com/support
   - Your PBX reseller/integrator

---

## Timeline

- **May 18**: PBX connection implemented with 3-state model
- **May 20**: Socket data handler indentation fixed
- **May 22**: OG handshaking protocol implemented, diagnostic logging added
- **May 22**: This troubleshooting guide created

---

## Next Steps

1. **Restart SMDR service on PBX** (System → Services → SMDR)
2. **Monitor server logs** for ENQ handshake
3. **Make test call** to verify real-time data
4. **Confirm dashboard shows 🟢 green**
5. **Report back** with results


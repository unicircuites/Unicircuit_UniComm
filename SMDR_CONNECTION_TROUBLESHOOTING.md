# SMDR Connection Troubleshooting Guide

## Current Status

**Problem:** PBX is not connecting to the server

**Evidence:**
- Port 5000 is listening ✅
- No connections from PBX ❌
- Dashboard shows "Waiting for PBX Connection" ❌

---

## Step-by-Step Diagnostic

### Step 1: Verify Server is Running

**Check if Node.js process is running:**
```powershell
Get-Process -Name node | Select-Object ProcessName, Id, CPU, Memory
```

**Expected Output:**
```
ProcessName    Id    CPU Memory
node        12345 2.5125
```

**If no process found:**
- Server crashed or not started
- Start server: `cd backend && node server.js`

---

### Step 2: Verify Port is Listening

**Check if port 5000 is listening:**
```powershell
netstat -ano | findstr :5000
```

**Expected Output:**
```
TCP    0.0.0.0:5000           0.0.0.0:0              LISTENING       12345
```

**If not listening:**
- Port might be in use by another process
- Kill the process: `taskkill /PID 12345 /F`
- Restart server: `node server.js`

---

### Step 3: Verify PBX Can Reach Server

**From PBX machine, ping your dev machine:**
```
ping 192.168.0.169
```

**Expected:** Ping succeeds (replies received)

**If ping fails:**
- Network connectivity issue
- Check firewall on dev machine
- Check network cable/WiFi connection
- Check router settings

---

### Step 4: Verify Firewall Allows Port 5000

**Check Windows Firewall:**
```powershell
netsh advfirewall firewall show rule name="PBX-SMDR"
```

**If rule doesn't exist, create it:**
```powershell
netsh advfirewall firewall add rule name="PBX-SMDR" dir=in action=allow protocol=TCP localport=5000
```

**Verify rule was created:**
```powershell
netsh advfirewall firewall show rule name="PBX-SMDR"
```

---

### Step 5: Verify PBX Configuration

**Log into Matrix Jeeves (http://192.168.0.81) and check:**

1. **Reports → SMDR → SMDR Posting**
   - Protocol: `Matrix` ✅
   - Destination Port: `Ethernet` ✅
   - Destination IP Address: `192.168.0.169` ✅ (for dev)
   - Port: `05000` (5000) ✅
   - Process: `Start` ✅

2. **If any setting is wrong:**
   - Update the setting
   - Click "Submit"
   - Wait 10 seconds
   - Restart PBX SMDR service (if available)

3. **If settings are correct:**
   - Restart the PBX (or just the SMDR service)
   - Wait 30 seconds
   - Check if connection appears

---

### Step 6: Monitor Server Logs

**Start server with detailed logging:**
```bash
cd backend
node server.js 2>&1 | tee server.log
```

**Watch for these messages:**

**When server starts:**
```
[SMDR] ── SERVER READY ───────────────────────────────────
[SMDR]   ✅ Listening on 0.0.0.0:5000
[SMDR]   Waiting for Matrix PBX (192.168.0.81) to initiate TCP handshake...
[SMDR] 📡 Emitting Socket.IO event: "pbx:listening"
```

**When PBX connects:**
```
[SMDR] ── INBOUND CONNECTION ─────────────────────────────
[SMDR]   Remote  : 192.168.0.81:55255
[SMDR]   Is PBX? : ✅ YES
[SMDR]   Socket  : readable=true writable=true
```

**When PBX sends ENQ (handshake):**
```
[SMDR] 📥 First data from 192.168.0.81:55255: [0] (hex: 00)
[SMDR] 🤝 Received ENQ handshake from 192.168.0.81:55255
[SMDR] 🤝 Sent ACK response to 192.168.0.81:55255
[SMDR] 📡 Emitting Socket.IO event: "pbx:connected"
```

**When PBX sends call data:**
```
[SMDR] 📥 Cleaned data from 192.168.0.81:55255: "1 01-05-26 10:30:45 00:00:15 In 919545073545 205"
[SMDR] ✅ Parsed: { call_type: 'In', caller: '919545073545', destination: '205', ... }
[SMDR] 📡 Emitting Socket.IO event: "pbx:call"
```

---

### Step 7: Test with Diagnostic Tool

**Run the diagnostic tool:**
```bash
cd backend
node test-smdr-connection.js
```

**Expected Output:**
```
[TEST] ══════════════════════════════════════════════════════
[TEST] SMDR Connection Diagnostic Tool
[TEST] Listening on 0.0.0.0:5000
[TEST] Waiting for PBX to connect...
[TEST] ══════════════════════════════════════════════════════
```

**When PBX connects:**
```
[TEST] ✅ Connection #1 from 192.168.0.81:55255
[TEST] Socket readable: true, writable: true
```

**When PBX sends data:**
```
[TEST] 📥 Data received (XX bytes):
[TEST]   Raw bytes: [0,...]
[TEST]   As string: "..."
[TEST]   Hex: "00..."
```

---

### Step 8: Check Browser Console

**Open dashboard and check browser console (F12):**

**Expected:**
```
[PBX] 🟡 SOCKET EVENT: "pbx:listening"
[PBX-UI] 🟡 Transitioning to LISTENING state
```

**When PBX connects:**
```
[PBX] 🟢 SOCKET EVENT: "pbx:connected"
[PBX-UI] 🟢 Transitioning to CONNECTED state
```

**If you see errors:**
- Screenshot the error
- Check server logs for corresponding errors

---

## Common Issues & Solutions

### Issue 1: "Port 5000 already in use"

**Symptom:**
```
[SMDR] ❌ Server error: EADDRINUSE
```

**Solution:**
```powershell
# Find process using port 5000
netstat -ano | findstr :5000

# Kill the process (replace 12345 with actual PID)
taskkill /PID 12345 /F

# Restart server
node server.js
```

---

### Issue 2: "Connection refused" or "No connections"

**Symptom:**
- Port 5000 listening
- But no connections from PBX
- Dashboard shows "Waiting for PBX Connection"

**Possible Causes:**
1. PBX SMDR Posting is disabled
2. PBX destination IP is wrong
3. PBX destination port is wrong
4. Firewall blocking connection
5. Network connectivity issue

**Solution:**
1. Verify PBX configuration (Step 5)
2. Verify firewall rule (Step 4)
3. Verify network connectivity (Step 3)
4. Restart PBX SMDR service
5. Check PBX logs for errors

---

### Issue 3: "Connection closes immediately"

**Symptom:**
```
netstat shows: FIN_WAIT_2 or CLOSE_WAIT
```

**Possible Causes:**
1. Server not responding to ENQ handshake
2. Server crashing on connection
3. Data format mismatch

**Solution:**
1. Check server logs for errors
2. Run diagnostic tool to see what data is being sent
3. Verify handshaking code is correct

---

### Issue 4: "Handshake timeout"

**Symptom:**
```
[SMDR] ⚠️  Handshake timeout from 192.168.0.81:... — no ENQ received within 5s
```

**Possible Causes:**
1. PBX not sending ENQ
2. PBX using different protocol
3. Data arriving in multiple packets

**Solution:**
1. Run diagnostic tool to see what data is being sent
2. Check if data starts with 0x00 (ENQ)
3. Increase timeout if needed

---

### Issue 5: "Expected ENQ but got..."

**Symptom:**
```
[SMDR] ⚠️  Expected ENQ (0x00) but got: [...]
[SMDR]    Treating as raw data (no handshaking)
```

**Meaning:**
- PBX is not using OG Handshaking Protocol
- Server is treating it as raw TCP data
- This is OK — server will still process the data

**Solution:**
- Make a test call on PBX
- Check if data is being parsed correctly
- If data is parsed, connection is working!

---

## Quick Checklist

- [ ] Node.js process is running (`Get-Process -Name node`)
- [ ] Port 5000 is listening (`netstat -ano | findstr :5000`)
- [ ] Firewall rule exists for port 5000
- [ ] PBX can ping dev machine (`ping 192.168.0.169`)
- [ ] PBX SMDR Posting is enabled
- [ ] PBX destination IP is 192.168.0.169
- [ ] PBX destination port is 05000 (5000)
- [ ] PBX process is "Start"
- [ ] Server logs show "Listening on 0.0.0.0:5000"
- [ ] Dashboard shows 🟡 yellow indicator

---

## Testing Sequence

1. **Start server:**
   ```bash
   cd backend
   node server.js
   ```

2. **Verify listening:**
   ```powershell
   netstat -ano | findstr :5000
   ```

3. **Check PBX configuration:**
   - Log into Matrix Jeeves
   - Verify SMDR Posting settings

4. **Make test call:**
   - Make a call through PBX
   - Watch server logs

5. **Check dashboard:**
   - Open http://localhost:8088/dashboard.html
   - Look for 🟢 green indicator

6. **Verify call logs:**
   - Check if call appears in call logs table
   - Check if call appears in real-time

---

## If Still Not Working

**Collect diagnostic information:**

1. **Server logs:**
   ```bash
   node server.js 2>&1 | tee server.log
   # Wait 30 seconds
   # Make a test call
   # Wait 10 seconds
   # Copy server.log content
   ```

2. **Network status:**
   ```powershell
   netstat -ano | findstr :5000
   ```

3. **PBX configuration screenshot:**
   - Log into Matrix Jeeves
   - Go to Reports → SMDR → SMDR Posting
   - Take screenshot

4. **Browser console:**
   - Open dashboard
   - Press F12
   - Go to Console tab
   - Take screenshot

5. **Share all of the above** for detailed analysis

---

## Key Points to Remember

✅ **Server must be running** — `node server.js`
✅ **Port 5000 must be listening** — `netstat -ano | findstr :5000`
✅ **Firewall must allow port 5000** — `netsh advfirewall firewall show rule name="PBX-SMDR"`
✅ **PBX must be configured correctly** — Check Matrix Jeeves SMDR Posting
✅ **PBX must be able to reach server** — `ping 192.168.0.169` from PBX
✅ **PBX must send data** — Make a test call

If all of these are correct, the connection will work!

---

## Next Steps

1. **Run through the diagnostic steps above**
2. **Collect the diagnostic information**
3. **Share the results**
4. **We'll identify the exact issue**

The most common issue is **PBX configuration** — make sure:
- Destination IP: `192.168.0.169` (not 192.168.0.205)
- Port: `05000` (5000)
- Process: `Start`

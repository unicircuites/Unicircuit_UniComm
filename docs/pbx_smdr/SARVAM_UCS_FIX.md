# SARVAM UCS Port Mismatch Fix

## The Real Issue Found! 🎯

Your PBX is **SARVAM UCS** (not ETERNITY NE), and there's a **port mismatch**:

- **PBX configured to send to**: Port `5001` (SMDR Posting)
- **Server was listening on**: Port `5000` ❌
- **Server should listen on**: Port `5001` ✓

The PBX was sending data to the wrong port, so the server never received it!

---

## What I Fixed

### 1. Updated `.env` File
Changed:
```
SMDR_PORT=5000  ❌
```

To:
```
SMDR_PORT=5001  ✓
```

This tells the server to listen on port 5001, matching your PBX configuration.

---

## What You Need to Do

### Step 1: Update Firewall Rule

The old firewall rule was for port 5000. You need to update it to port 5001:

```powershell
# Remove old rule
netsh advfirewall firewall delete rule name="PBX-SMDR"

# Add new rule for port 5001
netsh advfirewall firewall add rule name="PBX-SMDR" dir=in action=allow protocol=TCP localport=5001
```

Or manually in Windows Defender Firewall:
1. Open: **Windows Defender Firewall → Advanced Settings**
2. Click: **Inbound Rules**
3. Find: "PBX-SMDR" rule
4. Edit it: Change **Local Port** from `5000` to `5001`
5. Click **OK**

### Step 2: Restart the Server

```powershell
# Stop the running server (Ctrl+C in the terminal)
# Then restart it:
cd "c:\Users\unius\Documents\code workout\UNI_CRM\backend"
node server.js
```

### Step 3: Verify Server is Listening on Port 5001

```powershell
netstat -ano | findstr :5001
```

Should show:
```
TCP    0.0.0.0:5001           0.0.0.0:0              LISTENING       [PID]
```

### Step 4: Check Dashboard

- Refresh dashboard: `http://192.168.0.169:8088/dashboard.html`
- Should show 🟢 green indicator
- Status: "Matrix PBX · Live Connected · Receiving Realtime SMDR Data"

### Step 5: Make a Test Call

- Make a call from any extension
- Call should appear in dashboard within 2-5 seconds
- Verify all details are correct

---

## Why This Happened

The original documentation assumed **ETERNITY NE** (which uses port 5000 by default), but you're using **SARVAM UCS** (which uses port 5001 by default).

Your PBX configuration was correct all along:
- ✓ SMDR Posting: Enabled
- ✓ Destination IP: 192.168.0.169
- ✓ Port: 05001 (5001)
- ✓ Process: Start

The server just wasn't listening on the right port!

---

## Verification Checklist

After making these changes:

- [ ] Firewall rule updated to port 5001
- [ ] Server restarted
- [ ] `netstat -ano | findstr :5001` shows LISTENING
- [ ] Dashboard shows 🟢 green
- [ ] Status shows "Live Connected"
- [ ] Make test call
- [ ] Call appears in log within 5 seconds
- [ ] Call details are correct

---

## Quick Reference

| Item | Value |
|------|-------|
| PBX IP | 192.168.0.81 |
| Server IP | 192.168.0.169 |
| SMDR Port | **5001** (changed from 5000) |
| CTI Port | 5001 |
| PBX Type | SARVAM UCS |
| Interface | https://192.168.0.81:1026/IndexNeSe.html |

---

## If It Still Doesn't Work

1. **Verify PBX configuration**:
   - Open: https://192.168.0.81:1026/IndexNeSe.html
   - Go to: Reports → SMDR → SMDR Posting
   - Verify: Destination IP = 192.168.0.169, Port = 05001

2. **Check server logs**:
   - Look for: `[SMDR] ✅ Listening on 0.0.0.0:5001`
   - Look for: `[SMDR] 🤝 Received ENQ handshake from 192.168.0.81`

3. **Test network connectivity**:
   ```powershell
   # From server, ping PBX
   ping 192.168.0.81
   
   # From PBX, ping server
   ping 192.168.0.169
   ```

4. **Check if PBX can reach server**:
   - In PBX web interface, there's usually a network diagnostic tool
   - Test connectivity to 192.168.0.169:5001

---

## Summary

**Problem**: Port mismatch (PBX sending to 5001, server listening on 5000)
**Solution**: Change SMDR_PORT to 5001 in .env, update firewall, restart server
**Time to fix**: 5 minutes
**Expected result**: Dashboard shows 🟢 green, real-time call logging works


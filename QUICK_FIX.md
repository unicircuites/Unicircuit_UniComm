# Quick Fix: PBX Not Showing Green (🟢)

## The Issue
Dashboard shows 🟡 yellow (listening) instead of 🟢 green (connected).

## The Cause
PBX is sending old SMDR Report format instead of new SMDR Online format. This happens because the SMDR service on the PBX hasn't been restarted after configuration changes.

## The Fix (3 Steps)

### Step 1: Open PBX Web Interface
```
http://192.168.0.81:8080
```
Login with admin credentials.

### Step 2: Restart SMDR Service
Navigate to: **System → Services**

Find "SMDR" service:
1. Click **Stop** (wait 5 seconds)
2. Click **Start** (wait 10 seconds)

### Step 3: Verify
- Check dashboard — should show 🟢 green
- Make a test call
- Call should appear in log within 5 seconds

---

## What You'll See After Fix

### Server Logs
```
[SMDR] 🤝 Received ENQ handshake from 192.168.0.81
[SMDR] 🤝 Sent ACK response to 192.168.0.81
[SMDR] ✅ Emitting pbx:connected event (OG-Handshaking protocol)
```

### Dashboard
- Indicator: 🟢 Green
- Status: "Matrix PBX · Live Connected · Receiving Realtime SMDR Data"
- Live badge appears

---

## If It Still Doesn't Work

Check these in order:

1. **Is server running?**
   ```powershell
   netstat -ano | findstr :5000
   ```
   Should show: `LISTENING`

2. **Can PBX reach server?**
   - From PBX: `ping 192.168.0.169`
   - Should respond

3. **Is firewall rule active?**
   ```powershell
   netsh advfirewall firewall show rule name="PBX-SMDR"
   ```
   Should show: `Enabled: Yes`

4. **Check PBX config**
   - System → SMDR Settings
   - IP: `192.168.0.169` ✓
   - Port: `5000` ✓
   - Enabled: Yes ✓

---

## Full Troubleshooting Guide
See: `PBX_CONNECTION_TROUBLESHOOTING.md`


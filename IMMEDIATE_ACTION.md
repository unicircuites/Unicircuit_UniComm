# IMMEDIATE ACTION REQUIRED

## The Problem (FOUND!)
Your PBX is sending SMDR data to **port 5001**, but your server was listening on **port 5000**.

## The Fix (DONE!)
✅ Updated `.env` file: `SMDR_PORT=5000` → `SMDR_PORT=5001`

## What You Need to Do NOW (3 Steps)

### Step 1: Update Firewall (2 minutes)

**Option A: PowerShell (Recommended)**
```powershell
# Run as Administrator
netsh advfirewall firewall delete rule name="PBX-SMDR"
netsh advfirewall firewall add rule name="PBX-SMDR" dir=in action=allow protocol=TCP localport=5001
```

**Option B: Manual**
1. Open: **Windows Defender Firewall → Advanced Settings**
2. Click: **Inbound Rules**
3. Find: "PBX-SMDR" rule
4. Edit: Change **Local Port** from `5000` to `5001`
5. Click **OK**

### Step 2: Restart Server (1 minute)

```powershell
# Stop current server (Ctrl+C in terminal)
# Then run:
cd "c:\Users\unius\Documents\code workout\UNI_CRM\backend"
node server.js
```

### Step 3: Verify (1 minute)

```powershell
# Check server is listening on 5001
netstat -ano | findstr :5001
```

Should show:
```
TCP    0.0.0.0:5001           0.0.0.0:0              LISTENING
```

---

## Expected Result

After these 3 steps:

✅ Dashboard shows 🟢 green (not 🟡 yellow)
✅ Status: "Matrix PBX · Live Connected"
✅ Make a test call → appears in log within 5 seconds
✅ Real-time call logging works

---

## Verification

1. Refresh dashboard: `http://192.168.0.169:8088/dashboard.html`
2. Check indicator color (should be 🟢 green)
3. Make a test call
4. Verify call appears in log

---

## If You Need Help

See: `SARVAM_UCS_FIX.md` for detailed troubleshooting

---

## Timeline

- **Before**: Server listening on 5000, PBX sending to 5001 ❌
- **Now**: `.env` updated to 5001 ✓
- **Next**: Update firewall and restart server
- **Result**: Connection should work immediately


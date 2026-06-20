# PBX Connection Issue — Solution Summary

## Problem Statement
Dashboard shows 🟡 yellow (listening) instead of 🟢 green (connected), even though the PBX is connecting and sending data.

## Root Cause
The Matrix PBX is configured for **SMDR Online** (real-time) but is still sending **SMDR Report** (historical) data format. This happens because the SMDR service on the PBX hasn't been restarted after configuration changes.

### Evidence
- Server receives data from PBX ✓
- Data is being parsed and saved to database ✓
- But first byte is CRLF (0x0d0a) instead of ENQ (0x00)
- This indicates SMDR Report format, not SMDR Online format

## Solution

### Immediate Action Required
**Restart the SMDR service on the Matrix PBX:**

1. Open: `http://192.168.0.81:8080` (PBX web interface)
2. Navigate to: **System → Services**
3. Find "SMDR" service
4. Click **Stop** (wait 5 seconds)
5. Click **Start** (wait 10 seconds)
6. Check dashboard — should show 🟢 green

### Why This Works
When you restart the SMDR service, the PBX reloads its configuration and switches from SMDR Report format to SMDR Online format. The server will then receive the ENQ (0x00) handshake character, complete the OG handshaking protocol, and emit the `pbx:connected` event.

## What Changed in Code

### Enhanced Logging
Added detailed diagnostic logging to `backend/services/matrixSmdr.js`:

```javascript
// When ENQ is NOT received:
console.warn(`[SMDR]    This usually means PBX is sending SMDR Report instead of SMDR Online`);
console.warn(`[SMDR]    FIX: Restart SMDR service on PBX (System → Services → SMDR)`);
```

This helps users understand what's happening and what to do about it.

### Fallback Behavior
The server gracefully handles both scenarios:
- **With ENQ (0x00)**: Uses OG-Handshaking protocol ✓
- **Without ENQ**: Falls back to raw-tcp protocol ✓

Both emit `pbx:connected` event, so the dashboard can show 🟢 green in either case.

## Expected Behavior After Fix

### Server Logs
```
[SMDR] 📥 First data from 192.168.0.81:60957: {"type":"Buffer","data":[0]} (hex: 00)
[SMDR] 🤝 Received ENQ handshake from 192.168.0.81
[SMDR] 🤝 Sent ACK response to 192.168.0.81
[SMDR] ✅ Emitting pbx:connected event (OG-Handshaking protocol)
[SMDR] 📥 Cleaned data from 192.168.0.81:60957: "001 202 M001 09041373014 22-05-26 13:55:59 138 1 1.10 I"
[SMDR] ✅ Parsed successfully: In | 09041373014 -> 202
[SMDR] Saved to call_logs: In | 09041373014 → 202
```

### Dashboard Changes
- Indicator: 🟡 yellow → 🟢 green
- Status: "Matrix PBX · Live Connected · Receiving Realtime SMDR Data"
- Live badge appears
- New calls appear in real-time

### Real-Time Call Logging
- Make a test call
- Call appears in dashboard within 5 seconds
- CRM contact call count increments
- Call duration and type recorded

## Verification Checklist

After restarting SMDR service:

- [ ] Dashboard shows 🟢 green indicator
- [ ] Status text shows "Live Connected"
- [ ] Live badge is visible
- [ ] Make a test call
- [ ] Call appears in log within 5 seconds
- [ ] Call details are correct (caller, duration, type)
- [ ] CRM contact call count incremented

## If It Still Doesn't Work

### Quick Checks
1. **Is server running?** → `netstat -ano | findstr :5000` should show LISTENING
2. **Can PBX reach server?** → From PBX: `ping 192.168.0.169` should respond
3. **Is firewall rule active?** → `netsh advfirewall firewall show rule name="PBX-SMDR"` should show Enabled: Yes
4. **Check PBX config** → System → SMDR Settings should show IP=192.168.0.169, Port=5000

### Detailed Troubleshooting
See: `PBX_CONNECTION_TROUBLESHOOTING.md`

## Technical Details

### SMDR Online Protocol (OG Handshaking)
1. PBX connects to server on port 5000
2. PBX sends ENQ (0x00) — "Are you ready?"
3. Server responds with ACK (0x06) — "Yes, I'm ready"
4. PBX sends call records wrapped in STX (0x02) and ETX (0x03)
5. Server parses and saves to database

### SMDR Report Format (What We Were Getting)
- No handshake
- Human-readable text with headers
- Historical data, not real-time
- Requires manual restart to switch to SMDR Online

## Files Modified

- `backend/services/matrixSmdr.js` — Enhanced logging for diagnostic clarity

## Files Created

- `QUICK_FIX.md` — Quick reference for the fix
- `PBX_CONNECTION_TROUBLESHOOTING.md` — Comprehensive troubleshooting guide
- `SMDR_PROTOCOL_DETAILS.md` — Technical protocol documentation
- `SOLUTION_SUMMARY.md` — This file

## Next Steps

1. **Restart SMDR service on PBX** (System → Services → SMDR)
2. **Monitor server logs** for ENQ handshake
3. **Make test call** to verify real-time data
4. **Confirm dashboard shows 🟢 green**
5. **Report back** with results

---

## Timeline

- **May 18, 2026**: PBX connection implemented with 3-state model
- **May 20, 2026**: Socket data handler indentation fixed
- **May 22, 2026**: OG handshaking protocol implemented, diagnostic logging added
- **May 22, 2026**: Comprehensive troubleshooting guides created

---

## Support Resources

- **Quick Fix**: `QUICK_FIX.md`
- **Full Troubleshooting**: `PBX_CONNECTION_TROUBLESHOOTING.md`
- **Technical Details**: `SMDR_PROTOCOL_DETAILS.md`
- **Matrix Documentation**: ETERNITY NE V1R7.3.3 System Manual
- **PBX Web Interface**: `http://192.168.0.81:8080`


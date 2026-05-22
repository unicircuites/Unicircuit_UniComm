---
inclusion: always
---

# SMDR PBX Connection Protocol — MANDATORY

## ⚠️ CRITICAL: PBX Settings Are FIXED

**DO NOT ask about or suggest changing PBX settings.**

The following are **FIXED and FINAL**:
- **PBX IP**: `192.168.0.81` (Matrix SARVAM UCS)
- **SMDR Port**: `5001` (PBX sends data to this port)
- **Destination IP**: `192.168.0.169` (local dev machine)
- **Process Status**: "Start" (must be running on PBX)

These settings are configured on the PBX side and will NOT be changed. Accept them as given.

---

## Current SMDR Connection Status

### ✅ Server Side (Working)
- Server listening on `0.0.0.0:5001` ✅
- TCP server initialized and ready ✅
- Socket.IO listeners registered ✅
- `/api/pbx/status` endpoint available ✅

### ❌ PBX Side (NOT Connected)
- **Status**: Listening, waiting for PBX connection
- **Connected Peers**: 0
- **Last Activity**: null
- **Root Cause**: PBX SMDR service NOT sending data to port 5001

---

## Debugging Checklist

When PBX connection fails:

1. **Check server is listening**:
   ```javascript
   fetch('/api/pbx/status').then(r => r.json()).then(d => console.log(d));
   ```
   Expected: `listening: true, connected: false`

2. **Check server logs for inbound connections**:
   ```
   [SMDR-DEBUG] INBOUND CONNECTION RECEIVED
   [SMDR] 🟢 PBX CONNECTED
   ```

3. **If no inbound connection after 60 seconds**:
   - PBX SMDR service is NOT running
   - PBX firewall is blocking outbound to 192.168.0.169:5001
   - PBX network routing issue

---

## What NOT to Do

❌ Do NOT ask "Is IP set correctly?"
❌ Do NOT ask "Is port configured?"
❌ Do NOT suggest changing PBX settings
❌ Do NOT ask user to verify PBX configuration
❌ Do NOT ask about SMDR Posting page settings

These are all FIXED. Accept them as given.

---

## Next Steps When Connection Fails

If PBX is not connecting after 60 seconds:

1. Check if PBX SMDR service is actually **running** (not just configured)
2. Check PBX network connectivity to 192.168.0.169
3. Check if PBX firewall allows outbound TCP to 192.168.0.169:5001
4. Check if there are any PBX error logs

**Do NOT change any settings. Only diagnose why connection is not happening.**

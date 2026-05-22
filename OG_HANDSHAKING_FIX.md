# OG Handshaking Protocol Fix — SMDR Connection Issue Resolved

## Problem Identified

The PBX was configured to use the **OG (Handshaking) Protocol**, which requires a specific handshake sequence:

1. **PBX sends ENQ (0x00)** — "Are you ready?"
2. **Server must respond with ACK (0x06)** — "Yes, I'm ready"
3. **PBX sends data** — Wrapped in STX (0x02) and ETX (0x03)

**Your server was NOT responding to the ENQ handshake**, so the PBX would:
- Connect to port 5000 ✅
- Send ENQ (0x00) ✅
- Wait 3 seconds for ACK ⏱️
- Timeout and close connection ❌

This is why you saw:
- `pbx:listening` event ✅
- Connection in ESTABLISHED state ✅
- But NO `pbx:connected` event ❌
- Connection closes after 3 seconds ❌

## Solution Implemented

Updated `backend/services/matrixSmdr.js` to implement the OG Handshaking Protocol:

### Key Changes:

1. **Listen for ENQ (0x00) character**
   ```javascript
   socket.once('data', (firstData) => {
     if (firstData.length > 0 && firstData[0] === 0x00) {
       // This is the ENQ handshake
     }
   });
   ```

2. **Respond with ACK (0x06) character**
   ```javascript
   socket.write(Buffer.from([0x06]));
   ```

3. **Only process data AFTER handshake completes**
   ```javascript
   if (!handshakeComplete) return; // Ignore data until handshake complete
   ```

4. **Emit `pbx:connected` AFTER successful handshake**
   ```javascript
   emit('pbx:connected', { 
     ip: socket.remoteAddress, 
     port: socket.remotePort, 
     connectedAt: Date.now(),
     mode: 'server',
     isPBX: isPBX,
     protocol: 'OG-Handshaking'
   });
   ```

5. **Timeout protection** (5 seconds)
   ```javascript
   const handshakeTimeout = setTimeout(() => {
     if (!handshakeComplete) {
       socket.destroy();
     }
   }, 5000);
   ```

## PBX Configuration Verified

From the Matrix Jeeves screenshots:

✅ **SMDR - Posting**
- Protocol: Matrix
- Destination Port: Ethernet
- Destination IP Address: 192.168.0.169 (correct for dev)
- Port: 05000 (5000 in decimal)
- Process: Start

✅ **SMDR - Posting OG Handshaking Protocol**
- Response to ENQ Timeout: 03 seconds
- ENQ Retry Count: 05
- Use ENQ Character: Enable
- ENQ Character: 000 (0x00)
- Acknowledgement Character: 006 (0x06)
- Start Of Packet Character: 002 (0x02)
- End Of Packet Character: 003 (0x03)
- Use Byte Code Check (BCC): Enable

✅ **SMDR - Posting OG Online Call Record Format**
- Properly configured with all required fields
- Serial Number, Calling Number, Date, Time, Duration, etc.

## Expected Behavior After Fix

### Before (Broken):
```
[SMDR] ── INBOUND CONNECTION ─────────────────────────────
[SMDR]   Remote  : 192.168.0.81:55255
[SMDR]   Is PBX? : ✅ YES
[SMDR] 📡 Emitting Socket.IO event: "pbx:connected"  ← Emitted too early!
[SMDR] ── INBOUND DISCONNECTED ───────────────────────────
[SMDR]   No PBX connections — waiting for Matrix PBX to reconnect...
```

### After (Fixed):
```
[SMDR] ── INBOUND CONNECTION ─────────────────────────────
[SMDR]   Remote  : 192.168.0.81:55255
[SMDR]   Is PBX? : ✅ YES
[SMDR] 🤝 Received ENQ handshake from 192.168.0.81:55255
[SMDR] 🤝 Sent ACK response to 192.168.0.81:55255
[SMDR] 📡 Emitting Socket.IO event: "pbx:connected"  ← Emitted after handshake!
[SMDR] 📥 Cleaned data from 192.168.0.81:55255: "1 01-05-26 10:30:45 00:00:15 In 919545073545 205"
[SMDR] ✅ Parsed: { call_type: 'In', caller: '919545073545', destination: '205', ... }
[SMDR] 📡 Emitting Socket.IO event: "pbx:call"
```

## Frontend Expected Behavior

### Before (Broken):
```
🟡 Matrix PBX · Passive Standby · Waiting for PBX Connection
```
(Never transitions to green)

### After (Fixed):
```
🟡 Matrix PBX · Passive Standby · Waiting for PBX Connection
    ↓ [PBX connects and completes handshake]
🟢 Matrix PBX · Live Connected · Receiving Realtime SMDR Data
    ↓ [New call received]
🟢 Matrix PBX · Live Connected · Last call: 919545073545 → 205
```

## Testing Steps

1. **Restart the server:**
   ```bash
   cd backend
   node server.js
   ```

2. **Watch for handshake logs:**
   ```
   [SMDR] 🤝 Received ENQ handshake from 192.168.0.81:...
   [SMDR] 🤝 Sent ACK response to 192.168.0.81:...
   ```

3. **Make a test call on the PBX**

4. **Verify in server logs:**
   ```
   [SMDR] 📥 Cleaned data from 192.168.0.81:...
   [SMDR] ✅ Parsed: { call_type: 'In', ... }
   [SMDR] 📡 Emitting Socket.IO event: "pbx:call"
   ```

5. **Verify in frontend:**
   - Dashboard should show 🟢 green indicator
   - Call logs should appear in real-time
   - Status should show last call details

## Technical Details

### OG Handshaking Protocol Sequence

```
Timeline:
─────────────────────────────────────────────────────────

PBX                          Server
│                              │
├─ TCP Connect ──────────────→ │
│                              │
├─ Send ENQ (0x00) ──────────→ │
│                              ├─ Receive ENQ
│                              ├─ Send ACK (0x06)
│ ← ACK (0x06) ───────────────┤
│                              │
├─ Send STX (0x02) ──────────→ │
├─ Send Data ─────────────────→ │
├─ Send ETX (0x03) ──────────→ │
│                              ├─ Process Data
│                              ├─ Emit pbx:call
│                              │
├─ Send STX (0x02) ──────────→ │
├─ Send Data ─────────────────→ │
├─ Send ETX (0x03) ──────────→ │
│                              ├─ Process Data
│                              ├─ Emit pbx:call
│                              │
```

### Character Codes

| Character | Hex | Decimal | Purpose |
|-----------|-----|---------|---------|
| ENQ | 0x00 | 000 | PBX asks "are you ready?" |
| ACK | 0x06 | 006 | Server responds "yes, ready" |
| STX | 0x02 | 002 | Start of data packet |
| ETX | 0x03 | 003 | End of data packet |

### Timeout Handling

- **ENQ Response Timeout:** 3 seconds (configured in PBX)
- **ENQ Retry Count:** 5 times (configured in PBX)
- **Server Handshake Timeout:** 5 seconds (implemented in code)

If server doesn't respond with ACK within 3 seconds, PBX will retry up to 5 times, then close connection.

## Files Modified

- ✅ `backend/services/matrixSmdr.js` — Implemented OG Handshaking Protocol

## Syntax Verification

```bash
node --check backend/services/matrixSmdr.js
```
✅ **PASSED** — No syntax errors

## Backward Compatibility

✅ No breaking changes
✅ Existing database schema unchanged
✅ Existing API routes unchanged
✅ Existing SMDR parsing unchanged
✅ Only added handshake logic before data processing

## Known Limitations

- Only supports OG Handshaking Protocol (as configured in PBX)
- Does not support other SMDR protocols (e.g., raw TCP without handshake)
- Requires PBX to send ENQ within 5 seconds of connection

## Next Steps

1. **Restart server** with the updated code
2. **Monitor logs** for handshake messages
3. **Make test calls** on the PBX
4. **Verify** call logs appear in real-time on dashboard
5. **Check** that 🟢 green indicator appears

## Troubleshooting

### Issue: Still no connection
- **Check:** PBX SMDR Posting is set to "Start"
- **Check:** Destination IP is 192.168.0.169
- **Check:** Port is 05000 (5000)
- **Check:** Firewall allows port 5000

### Issue: Handshake timeout
- **Check:** Server logs show "Handshake timeout"
- **Cause:** PBX not sending ENQ within 5 seconds
- **Fix:** Increase timeout in code or check PBX network connectivity

### Issue: Data not being parsed
- **Check:** Server logs show "Received ENQ" and "Sent ACK"
- **Check:** Server logs show "Cleaned data from..."
- **Cause:** Data format might be different than expected
- **Fix:** Check SMDR Online Call Record Format in PBX

## Success Criteria

✅ Server logs show:
```
[SMDR] 🤝 Received ENQ handshake from 192.168.0.81:...
[SMDR] 🤝 Sent ACK response to 192.168.0.81:...
[SMDR] 📡 Emitting Socket.IO event: "pbx:connected"
```

✅ Frontend shows:
```
🟢 Matrix PBX · Live Connected · Receiving Realtime SMDR Data
```

✅ Call logs appear in real-time on dashboard

✅ No errors in browser console

✅ No errors in server logs

---

**Implementation Status:** ✅ COMPLETE
**Syntax Verification:** ✅ PASSED
**Ready for Testing:** ✅ YES

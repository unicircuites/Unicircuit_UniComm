# PBX 3-State Connection Model Implementation

## Overview
Implemented a proper 3-state PBX connection model to distinguish between:
1. **LISTENING** — TCP server started, waiting for PBX connection
2. **CONNECTED** — Actual PBX socket connected, receiving SMDR data
3. **DISCONNECTED** — PBX socket closed, server still listening

## Changes Made

### 1. `backend/services/matrixSmdr.js`

#### Event: `pbx:listening` (was `pbx:ready`)
- **When**: TCP server starts listening on port 5000
- **Emitted**: In `tcpServer.listen()` callback
- **Data**: `{ mode: 'server', port: SMDR_PORT, connectedAt: Date.now() }`
- **Meaning**: Server is ready to accept connections, but no PBX connected yet

```javascript
emit('pbx:listening', { mode: 'server', port: SMDR_PORT, connectedAt: Date.now() });
```

#### Event: `pbx:connected` (NEW)
- **When**: Actual PBX socket connects to the server
- **Emitted**: In `net.createServer((socket) => {})` callback
- **Data**: `{ ip: socket.remoteAddress, port: socket.remotePort, connectedAt: Date.now(), mode: 'server', isPBX: boolean }`
- **Meaning**: PBX is actively connected and sending SMDR data

```javascript
emit('pbx:connected', { 
  ip: socket.remoteAddress, 
  port: socket.remotePort, 
  connectedAt: Date.now(),
  mode: 'server',
  isPBX: isPBX
});
```

#### Event: `pbx:disconnected` (ENHANCED)
- **When**: PBX socket closes or errors
- **Emitted**: In `socket.on('close')` handler
- **Data**: `{ disconnectedAt: Date.now(), reason: string, peers: number, fatal: false }`
- **Meaning**: PBX disconnected, but server continues listening for reconnection

```javascript
emit('pbx:disconnected', { 
  disconnectedAt: Date.now(),
  reason: hadError ? 'Socket error' : 'Peer disconnected',
  peers: connectedPeers,
  fatal: false
});
```

### 2. `backend/server.js`

#### Updated `systemBridge()` function
- Added handler for `pbx:listening` event
- Updated `pbx:connected` handler to use new data structure (`ip` instead of `host`)
- Enhanced `pbx:disconnected` handler to distinguish between fatal and non-fatal disconnects
- Added legacy `pbx:ready` handler (maps to `pbx:listening` for backward compatibility)

**State Transitions:**
```
pbx:listening  → Server online, status='listening'
pbx:connected  → Server online, status='connected', clientHost set
pbx:disconnected (non-fatal) → Server online, status='listening' (waiting for reconnect)
pbx:disconnected (fatal) → Server offline
```

### 3. `dashboard.html`

#### New Event Listener: `pbx:listening`
- Calls `pbxOnListening()` function
- Shows yellow (🟡) indicator for passive standby

#### Updated Event Listeners
- Added legacy `pbx:ready` handler (maps to `pbxOnListening()`)
- Updated `pbx:connected` handler to use new data structure

#### New UI Function: `pbxOnListening()`
```javascript
function pbxOnListening(data) {
  // Yellow indicator (🟡)
  // Text: "Matrix PBX · Passive Standby · Waiting for PBX Connection"
  // Shows listening port
}
```

#### Updated UI Function: `pbxOnConnected()`
```javascript
function pbxOnConnected(data) {
  // Green indicator (🟢)
  // Text: "Matrix PBX · Live Connected · Receiving Realtime SMDR Data"
  // Shows active SMDR session from IP
}
```

#### Updated UI Function: `pbxOnDisconnected()`
```javascript
function pbxOnDisconnected(data) {
  if (isFatal) {
    // Red indicator (🔴)
    // Text: "Matrix PBX · Offline · [error reason]"
  } else {
    // Yellow indicator (🟡) — back to listening
    // Text: "Matrix PBX · Passive Standby · Waiting for PBX Connection"
  }
}
```

## UI State Indicators

| State | Indicator | Text | Behavior |
|-------|-----------|------|----------|
| **LISTENING** | 🟡 Yellow | "Passive Standby · Waiting for PBX Connection" | Shows stored DB logs, no realtime updates |
| **CONNECTED** | 🟢 Green | "Live Connected · Receiving Realtime SMDR Data" | Shows realtime call logs, active indicators |
| **DISCONNECTED (non-fatal)** | 🟡 Yellow | "Passive Standby · Waiting for PBX Connection" | Back to stored logs, listening continues |
| **DISCONNECTED (fatal)** | 🔴 Red | "Offline · [error reason]" | Error state, server needs restart |

## Architecture Preserved

✅ **Passive TCP Server** — PBX connects TO us (not the other way around)
✅ **No active client mode** — Legacy `startClient()` remains disabled
✅ **Existing call parsing** — No changes to SMDR parsing logic
✅ **Database storage** — All calls still saved to `call_logs` table
✅ **Socket.IO forwarding** — All events forwarded to frontend

## Expected Behavior

### Case 1: Backend starts, PBX not connected
```
[SMDR] ✅ Listening on 0.0.0.0:5000
[SMDR] Waiting for Matrix PBX (192.168.0.81) to initiate TCP handshake...
→ Emit: pbx:listening
→ Frontend: 🟡 Passive Standby · Waiting for PBX Connection
→ DB logs visible, no realtime updates
```

### Case 2: PBX connects
```
[SMDR] ── INBOUND CONNECTION ─────────────────────────────
[SMDR]   Remote  : 192.168.0.81:54321
[SMDR]   Is PBX? : ✅ YES
→ Emit: pbx:connected
→ Frontend: 🟢 Live Connected · Receiving Realtime SMDR Data
→ Realtime call logs appear
```

### Case 3: PBX disconnects
```
[SMDR] ── INBOUND DISCONNECTED ───────────────────────────
[SMDR]   Active connections remaining: 0
[SMDR]   No PBX connections — waiting for Matrix PBX to reconnect...
→ Emit: pbx:disconnected (fatal: false)
→ Frontend: 🟡 Passive Standby · Waiting for PBX Connection
→ Back to stored logs, listening continues
```

### Case 4: Server error (fatal)
```
[SMDR] ❌ Server error: EADDRINUSE (port already in use)
→ Emit: pbx:disconnected (fatal: true)
→ Frontend: 🔴 Offline · [error reason]
→ Error state, requires manual restart
```

## Testing Checklist

- [ ] Start server — verify 🟡 yellow indicator appears
- [ ] Connect PBX — verify 🟢 green indicator appears
- [ ] Disconnect PBX — verify 🟡 yellow indicator returns
- [ ] Verify stored DB logs always visible
- [ ] Verify realtime indicators only during 🟢 connected state
- [ ] Verify call logs refresh on new calls during connected state
- [ ] Verify no errors in browser console
- [ ] Verify no errors in server logs

## Files Modified

1. `backend/services/matrixSmdr.js` — Event emission logic
2. `backend/server.js` — Event forwarding and state management
3. `dashboard.html` — UI state handlers and indicators

## Backward Compatibility

- Legacy `pbx:ready` event still supported (maps to `pbx:listening`)
- Existing `pbx:connected` and `pbx:disconnected` handlers updated but compatible
- No breaking changes to database or API routes

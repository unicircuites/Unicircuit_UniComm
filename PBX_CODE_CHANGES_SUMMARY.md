# PBX 3-State Implementation — Code Changes Summary

## File 1: `backend/services/matrixSmdr.js`

### Change 1: Replace `pbx:ready` with `pbx:listening`

**Location:** Line ~600 (in `tcpServer.listen()` callback)

**Before:**
```javascript
emit('pbx:ready', { mode: 'server', port: SMDR_PORT });
```

**After:**
```javascript
emit('pbx:listening', { mode: 'server', port: SMDR_PORT, connectedAt: Date.now() });
```

**Reason:** Distinguish between "server listening" and "PBX connected"

---

### Change 2: Add `pbx:connected` event when socket connects

**Location:** Line ~520 (in `net.createServer((socket) => {})` callback)

**Before:**
```javascript
emit('pbx:connected', { host: socket.remoteAddress, port: SMDR_PORT, mode: 'server' });
```

**After:**
```javascript
emit('pbx:connected', { 
  ip: socket.remoteAddress, 
  port: socket.remotePort, 
  connectedAt: Date.now(),
  mode: 'server',
  isPBX: isPBX
});
```

**Reason:** Emit only when actual socket connects, include more metadata

---

### Change 3: Enhance `pbx:disconnected` event

**Location:** Line ~570 (in `socket.on('close')` handler)

**Before:**
```javascript
emit('pbx:disconnected', { fatal: false, reason: 'Peer disconnected', peers: connectedPeers });
```

**After:**
```javascript
emit('pbx:disconnected', { 
  disconnectedAt: Date.now(),
  reason: hadError ? 'Socket error' : 'Peer disconnected',
  peers: connectedPeers,
  fatal: false
});
```

**Reason:** Include timestamp and distinguish error types

---

## File 2: `backend/server.js`

### Change: Update `systemBridge()` function

**Location:** Line ~80 (in `systemBridge()` function)

**Before:**
```javascript
else if (event === 'pbx:connected') {
  markOnline('pbx');
  serviceState.pbx.clientHost = data?.host || null;
  serviceState.pbx.status = 'connected'; // differentiate from 'online' (ready)
}
else if (event === 'pbx:ready') {
  markOnline('pbx');
  serviceState.pbx.port = data?.port || SMDR_PORT;
  serviceState.pbx.mode = data?.mode || 'server';
}
else if (event === 'pbx:disconnected') {
  serviceState.pbx.clientHost = null;
  if (data?.fatal) {
    markOffline('pbx', data.error || data.reason);
  } else {
    serviceState.pbx.status = 'online'; // back to ready mode
  }
}
```

**After:**
```javascript
else if (event === 'pbx:listening') {
  // Server is listening but no PBX connected yet
  markOnline('pbx');
  serviceState.pbx.port = data?.port || SMDR_PORT;
  serviceState.pbx.mode = data?.mode || 'server';
  serviceState.pbx.status = 'listening';
}
else if (event === 'pbx:connected') {
  // Actual PBX socket connected
  markOnline('pbx');
  serviceState.pbx.clientHost = data?.ip || data?.host || null;
  serviceState.pbx.status = 'connected';
  serviceState.pbx.connectedAt = data?.connectedAt || Date.now();
}
else if (event === 'pbx:ready') {
  // Legacy event — treat as listening
  markOnline('pbx');
  serviceState.pbx.port = data?.port || SMDR_PORT;
  serviceState.pbx.mode = data?.mode || 'server';
  serviceState.pbx.status = 'listening';
}
else if (event === 'pbx:disconnected') {
  serviceState.pbx.clientHost = null;
  serviceState.pbx.status = 'listening'; // Back to listening mode
  if (data?.fatal) {
    markOffline('pbx', data.error || data.reason);
  } else {
    // Non-fatal disconnect — server still listening
    const ev = activityLog.append({ 
      type: 'info', 
      service: 'pbx', 
      message: `PBX disconnected: ${data?.reason || 'Connection lost'} — listening for reconnection`,
      timestamp: _now() 
    });
    try { _origEmit('system:activity', ev); } catch (_) { }
  }
}
```

**Also update the event filter at the end:**

**Before:**
```javascript
if (!['wa:connected', 'wa:disconnected', 'pbx:connected', 'pbx:disconnected'].includes(event)) {
```

**After:**
```javascript
if (!['wa:connected', 'wa:disconnected', 'pbx:connected', 'pbx:disconnected', 'pbx:listening', 'pbx:ready'].includes(event)) {
```

**Reason:** Handle new `pbx:listening` state and maintain backward compatibility with `pbx:ready`

---

## File 3: `dashboard.html`

### Change 1: Add `pbx:listening` event listener

**Location:** Line ~16495 (in Socket.IO event handlers)

**Before:**
```javascript
waSocket.on('pbx:ready', (data) => {
  console.log('[PBX] 🟢 SOCKET EVENT: "pbx:ready" (Server listening)', data);
  pbxOnReady(data);
});
waSocket.on('pbx:connected', (data) => {
  console.log('[PBX] 🟢 SOCKET EVENT: "pbx:connected"', data);
  pbxOnConnected(data);
});
```

**After:**
```javascript
waSocket.on('pbx:listening', (data) => {
  console.log('[PBX] 🟡 SOCKET EVENT: "pbx:listening" (Server listening, waiting for PBX)', data);
  pbxOnListening(data);
});
waSocket.on('pbx:ready', (data) => {
  console.log('[PBX] 🟢 SOCKET EVENT: "pbx:ready" (Server listening)', data);
  pbxOnListening(data); // Treat legacy pbx:ready as pbx:listening
});
waSocket.on('pbx:connected', (data) => {
  console.log('[PBX] 🟢 SOCKET EVENT: "pbx:connected"', data);
  pbxOnConnected(data);
});
```

**Reason:** Handle new `pbx:listening` event and maintain backward compatibility

---

### Change 2: Replace PBX state handler functions

**Location:** Line ~20130 (function definitions)

**Before:**
```javascript
function pbxOnReady(data) {
  console.log('[PBX-UI] 🟢 Transitioning to READY state (Passive Standby)...', data);
  const dot = document.getElementById('pbx-dot');
  const txt = document.getElementById('pbx-status-text');
  const info = document.getElementById('pbx-listener-info');
  if (dot) dot.style.background = 'var(--green)';
  if (txt) {
    txt.textContent = `Matrix PBX · Online · Ready for Calls`;
    txt.style.color = 'var(--text)';
  }
  if (info) info.textContent = `Listening on Port ${data.port || 5001} (${data.mode || 'server'})`;
  updateServiceIndicator('pbx', true);
}

function pbxOnConnected(data) {
  console.log('[PBX-UI] 🟢 Transitioning to CONNECTED state...', data);
  const dot = document.getElementById('pbx-dot');
  const txt = document.getElementById('pbx-status-text');
  const info = document.getElementById('pbx-listener-info');
  const badge = document.getElementById('pbx-live-badge');
  if (dot) dot.style.background = 'var(--green)';
  if (txt) {
    txt.textContent = `Matrix PBX · Connected · (Client: ${data.host})`;
    txt.style.color = 'var(--green2)';
  }
  if (info) info.textContent = `Active SMDR session from ${data.host}`;
  if (badge) badge.style.display = 'inline-flex';
  updateServiceIndicator('pbx', true);
}

function pbxOnDisconnected(data) {
  const isFatal = data && data.fatal === true;
  console.warn(`[PBX-UI] 🔴 Disconnected (Fatal: ${isFatal})`, data);

  const dot = document.getElementById('pbx-dot');
  const txt = document.getElementById('pbx-status-text');
  const badge = document.getElementById('pbx-live-badge');

  if (badge) badge.style.display = 'none';

  if (isFatal) {
    if (dot) dot.style.background = 'var(--red2)';
    if (txt) {
      txt.textContent = `Matrix PBX · Offline · ${data.reason || 'Server error'}`;
      txt.style.color = 'var(--red2)';
    }
    updateServiceIndicator('pbx', false);
  } else {
    // Just a peer disconnect, keep server "Online" but in waiting mode
    if (dot) dot.style.background = 'var(--green)';
    if (txt) {
      txt.textContent = 'Matrix PBX · Online · Ready for Calls';
      txt.style.color = 'var(--text)';
    }
    updateServiceIndicator('pbx', true);
  }
}
```

**After:**
```javascript
function pbxOnListening(data) {
  console.log('[PBX-UI] 🟡 Transitioning to LISTENING state (Passive Standby)...', data);
  const dot = document.getElementById('pbx-dot');
  const txt = document.getElementById('pbx-status-text');
  const info = document.getElementById('pbx-listener-info');
  if (dot) dot.style.background = 'var(--gold)'; // Yellow for listening/waiting
  if (txt) {
    txt.textContent = `Matrix PBX · Passive Standby · Waiting for PBX Connection`;
    txt.style.color = 'var(--text)';
  }
  if (info) info.textContent = `Listening on Port ${data.port || 5001} (${data.mode || 'server'})`;
  updateServiceIndicator('pbx', true);
}

function pbxOnConnected(data) {
  console.log('[PBX-UI] 🟢 Transitioning to CONNECTED state...', data);
  const dot = document.getElementById('pbx-dot');
  const txt = document.getElementById('pbx-status-text');
  const info = document.getElementById('pbx-listener-info');
  const badge = document.getElementById('pbx-live-badge');
  if (dot) dot.style.background = 'var(--green)'; // Green for connected
  if (txt) {
    txt.textContent = `Matrix PBX · Live Connected · Receiving Realtime SMDR Data`;
    txt.style.color = 'var(--green2)';
  }
  if (info) info.textContent = `Active SMDR session from ${data.ip || data.host}`;
  if (badge) badge.style.display = 'inline-flex';
  updateServiceIndicator('pbx', true);
}

function pbxOnDisconnected(data) {
  const isFatal = data && data.fatal === true;
  console.warn(`[PBX-UI] 🔴 Disconnected (Fatal: ${isFatal})`, data);

  const dot = document.getElementById('pbx-dot');
  const txt = document.getElementById('pbx-status-text');
  const badge = document.getElementById('pbx-live-badge');

  if (badge) badge.style.display = 'none';

  if (isFatal) {
    // Fatal error — server offline
    if (dot) dot.style.background = 'var(--red2)';
    if (txt) {
      txt.textContent = `Matrix PBX · Offline · ${data.reason || 'Server error'}`;
      txt.style.color = 'var(--red2)';
    }
    updateServiceIndicator('pbx', false);
  } else {
    // Non-fatal disconnect — server still listening, waiting for reconnection
    if (dot) dot.style.background = 'var(--gold)'; // Yellow for listening/waiting
    if (txt) {
      txt.textContent = 'Matrix PBX · Passive Standby · Waiting for PBX Connection';
      txt.style.color = 'var(--text)';
    }
    updateServiceIndicator('pbx', true);
  }
}
```

**Reason:** 
- New `pbxOnListening()` function for passive standby state (yellow indicator)
- Updated `pbxOnConnected()` to use `data.ip` instead of `data.host`
- Updated `pbxOnDisconnected()` to return to listening state (yellow) on non-fatal disconnect

---

## Summary of Changes

| File | Change | Type | Impact |
|------|--------|------|--------|
| matrixSmdr.js | Replace `pbx:ready` with `pbx:listening` | Event | Clarifies server listening state |
| matrixSmdr.js | Add `pbx:connected` with enhanced data | Event | Emits when actual socket connects |
| matrixSmdr.js | Enhance `pbx:disconnected` with timestamp | Event | Better disconnect tracking |
| server.js | Add `pbx:listening` handler | Logic | Manages listening state |
| server.js | Update `pbx:connected` handler | Logic | Uses new data structure |
| server.js | Update `pbx:disconnected` handler | Logic | Distinguishes fatal vs non-fatal |
| dashboard.html | Add `pbx:listening` listener | UI | Handles new event |
| dashboard.html | Add `pbxOnListening()` function | UI | Yellow indicator for listening |
| dashboard.html | Update `pbxOnConnected()` function | UI | Green indicator for connected |
| dashboard.html | Update `pbxOnDisconnected()` function | UI | Yellow for non-fatal, red for fatal |

---

## Verification Steps

1. **Syntax Check:**
   ```bash
   node --check backend/services/matrixSmdr.js
   node --check backend/server.js
   ```

2. **Start Server:**
   ```bash
   node server.js
   ```
   Expected: `[SMDR] ✅ Listening on 0.0.0.0:5000` + `pbx:listening` event

3. **Connect PBX:**
   - Configure PBX to connect to server
   - Expected: `[SMDR] ── INBOUND CONNECTION` + `pbx:connected` event

4. **Disconnect PBX:**
   - Stop PBX or close connection
   - Expected: `[SMDR] ── INBOUND DISCONNECTED` + `pbx:disconnected` event

5. **Frontend UI:**
   - Verify 🟡 yellow indicator on startup
   - Verify 🟢 green indicator when PBX connects
   - Verify 🟡 yellow indicator when PBX disconnects
   - Verify 🔴 red indicator on server error

---

## Backward Compatibility

✅ Legacy `pbx:ready` event still supported (maps to `pbx:listening`)
✅ Existing `pbx:connected` and `pbx:disconnected` handlers updated but compatible
✅ No breaking changes to database or API routes
✅ No changes to SMDR parsing logic
✅ All existing call logs continue to work

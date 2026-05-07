# Design Document — System Activity Log

## Overview

This feature adds real-time service health visibility to the UniComm Pro dashboard. Four external services — PostgreSQL, WhatsApp (Baileys), Matrix PBX (SMDR), and Outlook (Microsoft Graph) — currently fail silently. The design introduces:

1. A backend **activity log ring buffer** (in-memory, 500 events) that records every service state change.
2. A new **`backend/routes/system.js`** route file exposing `GET /api/system/status` and `GET /api/system/log`.
3. **Socket.IO bridge emitters** in `server.js` that translate existing `wa:*` / `pbx:*` events into `system:service_online` / `system:service_offline` events, plus periodic probes for Outlook and PostgreSQL.
4. **Live topbar health indicators** replacing the four static pills currently hardcoded in `dashboard.html`.
5. A **slide-over Activity Log Panel** that shows the last 100 events with live Socket.IO updates.
6. **Offline/reconnect toast notifications** using the existing `notify()` function with extended durations.
7. **JWT user display** decoded from `localStorage` and shown in the sidebar and panel header.

No new npm packages are required. No new database tables are needed. All log storage is in-memory on the backend process.

---

## Architecture

```mermaid
graph TD
    subgraph Backend
        WA[whatsapp.js<br/>wa:connected / wa:disconnected]
        PBX[matrixSmdr.js<br/>pbx:connected / pbx:disconnected]
        DB[db/pool.js<br/>pool error event]
        MS[msGraph.js<br/>isAuthenticated()]

        LOG[activityLog.js<br/>Ring Buffer — 500 events]
        SYS[routes/system.js<br/>GET /api/system/status<br/>GET /api/system/log]

        SERVER[server.js<br/>Socket.IO bridge + probes]
    end

    subgraph Frontend — dashboard.html
        TOPBAR[Topbar Health Indicators<br/>4 live dots]
        PANEL[Activity Log Panel<br/>slide-over drawer]
        TOAST[Offline/Reconnect Toasts<br/>notify() extended]
        USER[JWT User Display<br/>sidebar + panel header]
    end

    WA -->|wa:connected / wa:disconnected| SERVER
    PBX -->|pbx:connected / pbx:disconnected| SERVER
    DB -->|pool error| SERVER
    MS -->|probe every 60s| SERVER

    SERVER -->|append event| LOG
    SERVER -->|system:service_online<br/>system:service_offline<br/>system:log_snapshot| TOPBAR
    SERVER -->|same events| PANEL
    SERVER -->|same events| TOAST

    SYS -->|reads| LOG
    TOPBAR -->|GET /api/system/status on load| SYS
    PANEL -->|GET /api/system/log on open| SYS
```

The design is deliberately additive. Existing `wa:*` and `pbx:*` Socket.IO events are not removed — they continue to drive the WhatsApp and PBX sections. The new `system:*` events are layered on top in `server.js` without touching `whatsapp.js` or `matrixSmdr.js`.

---

## Components and Interfaces

### 1. `backend/services/activityLog.js` — Ring Buffer Module

A standalone module with no external dependencies. Exported as a singleton.

```js
// Public API
activityLog.append(event)   // → stored event with seq assigned
activityLog.getRecent(n)    // → array of last n events (newest last)
activityLog.getAll()        // → full buffer contents (newest last)
activityLog.size()          // → current count
```

**Event shape** (all fields required):
```js
{
  seq:       Number,   // monotonically increasing, starts at 1
  type:      String,   // 'online' | 'offline' | 'error' | 'user_login'
  service:   String,   // 'whatsapp' | 'pbx' | 'outlook' | 'postgres' | 'system'
  message:   String,   // human-readable description
  timestamp: String,   // ISO 8601 UTC
}
```

**Ring buffer implementation**: a fixed-length array with a write-pointer. When the buffer is full (500 entries), the oldest entry is overwritten. `getRecent(n)` returns the last `n` entries in insertion order.

---

### 2. `backend/routes/system.js` — REST Endpoints

Both routes require the existing `authenticate` middleware from `backend/middleware/auth.js`.

#### `GET /api/system/status`

Returns the live state of all four services. PostgreSQL is probed live (lightweight `SELECT 1`). The other three read from in-memory state flags maintained by the bridge in `server.js`.

**Response shape:**
```json
{
  "whatsapp":  { "status": "online",  "lastConnected": "2025-01-15T10:30:00Z", "lastDisconnected": null },
  "pbx":       { "status": "offline", "lastConnected": "2025-01-15T09:00:00Z", "lastDisconnected": "2025-01-15T10:00:00Z" },
  "outlook":   { "status": "online",  "lastConnected": "2025-01-15T08:00:00Z", "lastDisconnected": null },
  "postgres":  { "status": "online",  "lastConnected": "2025-01-15T10:30:00Z", "lastDisconnected": null }
}
```

The route imports `activityLog` and the shared `serviceState` object (see §3 below). It does not import `io` — it is stateless with respect to Socket.IO.

#### `GET /api/system/log`

Returns recent log entries. Accepts optional `?limit=N` query parameter (default 100, capped at 500). Returns entries in reverse-chronological order (newest first) to match the UI requirement.

**Response shape:**
```json
{
  "events": [ /* array of event objects */ ],
  "total":  42
}
```

---

### 3. Bridge and Probes in `server.js`

A `serviceState` object tracks the current status and timestamps for all four services. This object is shared between the bridge, the probes, and the route handler.

```js
const serviceState = {
  whatsapp: { status: 'offline', lastConnected: null, lastDisconnected: null },
  pbx:      { status: 'offline', lastConnected: null, lastDisconnected: null },
  outlook:  { status: 'offline', lastConnected: null, lastDisconnected: null },
  postgres: { status: 'offline', lastConnected: null, lastDisconnected: null },
};
```

**Bridge — WA events** (added after `wa.setIO(io)` in `server.js`):
```js
io.on('connection', (socket) => {
  // Send snapshot to newly connected client
  socket.emit('system:log_snapshot', { events: activityLog.getRecent(100) });
});

// Intercept existing wa:connected / wa:disconnected
// These are emitted by whatsapp.js via io.emit() — we listen on the server side
// using a local event bus pattern (see §3a below)
```

Because `whatsapp.js` calls `io.emit()` directly (not a Node EventEmitter), the bridge uses a thin wrapper: `server.js` replaces the `io.emit` call path by registering a Socket.IO server-side middleware that intercepts outgoing events. A simpler alternative — and the one used here — is to have `whatsapp.js` and `matrixSmdr.js` call a shared `emitWithBridge(event, data)` helper instead of `io.emit()` directly. However, to avoid touching those files (per the WhatsApp change protocol), the bridge instead uses **Socket.IO's `io.on('connection')` + a local Node.js `EventEmitter`** pattern:

**§3a — Local event bus approach (no changes to whatsapp.js or matrixSmdr.js):**

`server.js` wraps the `io` object's `emit` method after construction to intercept `wa:*` and `pbx:*` events:

```js
const _origEmit = io.emit.bind(io);
io.emit = function(event, data) {
  _origEmit(event, data);
  systemBridge(event, data);   // side-effect: update state + append log + emit system:* events
};
```

`systemBridge(event, data)` handles:
- `wa:connected` → mark whatsapp online, append log, emit `system:service_online`
- `wa:disconnected` → mark whatsapp offline, append log, emit `system:service_offline`
- `pbx:connected` → mark pbx online, append log, emit `system:service_online`
- `pbx:disconnected` → mark pbx offline, append log, emit `system:service_offline`

**§3b — Periodic probes:**

```js
// Outlook probe — every OUTLOOK_PROBE_INTERVAL_MS (default 60000)
setInterval(async () => {
  try {
    const auth = await msGraph.isAuthenticated();
    const was = serviceState.outlook.status;
    if (auth && was !== 'online') {
      markOnline('outlook');
    } else if (!auth && was !== 'offline') {
      markOffline('outlook', 'Outlook token expired or revoked');
    }
  } catch (err) {
    console.error('[System] Outlook probe error:', err.message);
  }
}, outlookProbeInterval);

// PostgreSQL probe — every DB_PROBE_INTERVAL_MS (default 30000)
setInterval(async () => {
  try {
    await pool.query('SELECT 1');
    const was = serviceState.postgres.status;
    if (was !== 'online') markOnline('postgres');
  } catch (err) {
    const was = serviceState.postgres.status;
    if (was !== 'offline') markOffline('postgres', err.message);
  }
}, dbProbeInterval);
```

`markOnline(service)` and `markOffline(service, reason)` are helpers that update `serviceState`, append to `activityLog`, and call `_origEmit('system:service_online', ...)` / `_origEmit('system:service_offline', ...)`.

**§3c — New client snapshot:**

```js
io.on('connection', (socket) => {
  socket.emit('system:log_snapshot', { events: activityLog.getRecent(100) });
});
```

---

### 4. Frontend — Topbar Health Indicators

The four existing static pills in `dashboard.html` are replaced with dynamic elements:

```html
<!-- Replace existing static pills with: -->
<div class="pill-tag" id="svc-postgres">
  <span class="svc-dot" id="dot-postgres"></span> PostgreSQL
</div>
<div class="pill-tag" id="svc-pbx">
  <span class="svc-dot" id="dot-pbx"></span> Matrix PBX
</div>
<div class="pill-tag" id="svc-whatsapp">
  <i class="fab fa-whatsapp" id="dot-whatsapp" style="font-size:11px;"></i> WA Business
</div>
<div class="pill-tag" id="svc-outlook">
  <i class="fas fa-envelope" id="dot-outlook" style="font-size:11px;"></i> Outlook
</div>
```

A `updateServiceIndicator(service, online)` JS function sets the dot/icon colour:
- Online: `var(--green)` / `#25D366` for WA / `#0078d4` for Outlook
- Offline: `var(--red)`

On page load, `initSystemStatus()` calls `GET /api/system/status` and sets all four indicators. The `showDbStatus()` function is retired — the PostgreSQL indicator replaces it.

---

### 5. Frontend — Activity Log Panel

A slide-over drawer appended to `<body>`. It slides in from the right when the log button is clicked and is dismissed by clicking the overlay or pressing Escape.

**HTML structure:**
```html
<div id="activity-log-overlay" style="display:none; ...overlay styles..."></div>
<div id="activity-log-panel" style="...drawer styles...">
  <div id="alp-header">
    <span>Activity Log (<span id="alp-count">0</span>)</span>
    <div id="alp-user-info"><!-- JWT user name + email --></div>
    <button id="alp-clear-btn">Clear</button>
    <button id="alp-close-btn">✕</button>
  </div>
  <div id="alp-list"><!-- event rows prepended here --></div>
</div>
```

**Topbar trigger button** (added to `.topbar-actions`):
```html
<button class="btn btn-ghost btn-sm" id="activity-log-btn" onclick="openActivityLog()">
  <i class="fas fa-list-alt"></i> Activity Log
</button>
```

**Event row template:**
```js
function renderLogEvent(ev) {
  const icons = { online: '🟢', offline: '🔴', error: '🟡', user_login: '🔵' };
  const ts = new Date(ev.timestamp);
  const formatted = ts.toLocaleTimeString('en-GB') + ' ' + ts.toLocaleDateString('en-GB');
  return `<div class="alp-row alp-${ev.type}">
    <span class="alp-icon">${icons[ev.type] || '⚪'}</span>
    <div class="alp-body">
      <span class="alp-service">${ev.service}</span>
      <span class="alp-msg">${ev.message}</span>
    </div>
    <span class="alp-ts">${formatted}</span>
  </div>`;
}
```

**Live updates**: when `system:service_online` or `system:service_offline` arrives while the panel is open, `prependLogEvent(ev)` prepends a new row and increments the count badge.

**Keyboard accessibility**: `Escape` key closes the panel; focus is trapped inside while open using a `focusTrap` helper that cycles Tab between the first and last focusable elements.

---

### 6. Frontend — Offline Notification Toasts

The existing `notify(title, sub, color, icon)` function auto-dismisses after 3400ms. The requirements call for 8000ms (offline) and 4000ms (reconnect). Rather than modifying `notify()` (which would affect all existing toasts), a new `notifyService(service, online, reason)` wrapper is introduced that temporarily overrides `notifTimer` duration:

```js
function notifyService(service, online, reason) {
  const duration = online ? 4000 : 8000;
  const color    = online ? 'var(--green)' : 'var(--red)';
  const icon     = online ? 'fas fa-check-circle' : 'fas fa-exclamation-triangle';
  const title    = online
    ? `${service} reconnected`
    : `${service} went offline`;
  const sub      = online ? '' : (reason || 'Connection lost');

  // Show toast
  const n = document.getElementById('notif');
  // ... populate fields same as notify() ...
  n.classList.add('show');
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => n.classList.remove('show'), duration);
}
```

**Per-service deduplication**: a `Map<service, toastTimerId>` tracks active offline toasts. If a second `system:service_offline` arrives for the same service while a toast is visible, the existing timer is cleared and the toast content is updated in place (requirement 6.7). Reconnect toasts always show fresh (requirement 6.4).

**Multiple simultaneous failures** (requirement 6.6): toasts are queued with a 300ms stagger using a `toastQueue` array so each service gets its own visible toast.

---

### 7. Frontend — JWT User Display

The JWT is already stored in `localStorage` as `uc_token`. The auth guard already decodes `uc_user` (a JSON object stored separately). The design uses the existing `uc_user` object — no additional JWT decode library is needed.

**Sidebar** (already partially implemented — `sidebar-name` and `sidebar-role` are populated in the auth guard block): no change needed beyond ensuring the existing code runs.

**Activity Log Panel header**: on panel open, read `uc_user` from localStorage and render:
```js
const user = JSON.parse(localStorage.getItem('uc_user') || '{}');
document.getElementById('alp-user-info').innerHTML =
  `<span>${user.name || 'Unknown'}</span> <span style="color:var(--muted)">${user.email || ''}</span>`;
```

**JWT expiry handling**: the existing `apiFetch()` wrapper already redirects to login on 401. The additional requirement (7.3) to append a `user_login` error event before redirect is handled by calling `appendLocalLogEvent('system', 'error', 'Session expired — please log in again')` inside the 401 handler before `window.location.href = 'login.html'`.

---

## Data Models

### Activity Log Event (in-memory)

| Field       | Type   | Description                                      |
|-------------|--------|--------------------------------------------------|
| `seq`       | Number | Monotonically increasing integer, starts at 1    |
| `type`      | String | `'online'` \| `'offline'` \| `'error'` \| `'user_login'` |
| `service`   | String | `'whatsapp'` \| `'pbx'` \| `'outlook'` \| `'postgres'` \| `'system'` |
| `message`   | String | Human-readable description                       |
| `timestamp` | String | ISO 8601 UTC (`new Date().toISOString()`)         |

### Service State (in-memory, `server.js`)

| Field              | Type           | Description                          |
|--------------------|----------------|--------------------------------------|
| `status`           | String         | `'online'` \| `'offline'`            |
| `lastConnected`    | String \| null | ISO 8601 timestamp of last online    |
| `lastDisconnected` | String \| null | ISO 8601 timestamp of last offline   |

### Socket.IO Event Payloads

**`system:service_online`**
```json
{ "service": "whatsapp", "timestamp": "2025-01-15T10:30:00Z", "seq": 42 }
```

**`system:service_offline`**
```json
{ "service": "pbx", "timestamp": "2025-01-15T10:00:00Z", "reason": "TCP connection closed", "seq": 43 }
```

**`system:log_snapshot`**
```json
{ "events": [ /* up to 100 event objects, newest last */ ] }
```

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Status API response completeness

*For any* combination of internal service states (online/offline for each of the four services), the `GET /api/system/status` response SHALL contain all four service keys (`whatsapp`, `pbx`, `outlook`, `postgres`), each with `status`, `lastConnected`, and `lastDisconnected` fields present (values may be null but keys must exist).

**Validates: Requirements 1.1, 1.2**

---

### Property 2: Status API reflects internal state

*For any* combination of boolean states for the four services set in `serviceState`, calling `GET /api/system/status` SHALL return `status: "online"` for each service whose flag is `true` and `status: "offline"` for each service whose flag is `false`.

**Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 1.7**

---

### Property 3: Event payload completeness

*For any* service name and reason string, a `system:service_offline` event emitted by the bridge SHALL contain `service`, `timestamp` (parseable as ISO 8601), `reason`, and `seq` fields. A `system:service_online` event SHALL contain `service`, `timestamp`, and `seq` fields.

**Validates: Requirements 2.1, 2.2**

---

### Property 4: Sequence numbers are strictly increasing

*For any* sequence of N `system:service_online` and `system:service_offline` events emitted in order, the `seq` field of each event SHALL be strictly greater than the `seq` field of the preceding event.

**Validates: Requirement 2.9**

---

### Property 5: Activity log event structure

*For any* event appended to the activity log, reading it back via `activityLog.getRecent(1)` SHALL return an object containing all five required fields: `seq`, `type`, `service`, `message`, and `timestamp` (ISO 8601 parseable).

**Validates: Requirement 3.1**

---

### Property 6: Ring buffer capacity invariant

*For any* N events appended to the activity log where N ≥ 500, `activityLog.size()` SHALL equal exactly 500, and the log SHALL contain the N most recently appended events (not the earliest ones).

**Validates: Requirements 3.2, 3.3**

---

### Property 7: Log query limit is respected

*For any* integer N in the range [1, 500], `GET /api/system/log?limit=N` SHALL return at most N events, and if the log contains ≥ N events, it SHALL return exactly N events (the most recent N).

**Validates: Requirement 3.6**

---

### Property 8: Health indicators reflect API response

*For any* combination of service statuses returned by `GET /api/system/status`, after `initSystemStatus()` completes, each of the four health indicator dots SHALL display green if the corresponding service status is `"online"` and red if it is `"offline"`.

**Validates: Requirements 4.2, 4.3, 4.4**

---

### Property 9: Health indicators update on Socket.IO events

*For any* valid service name in a `system:service_online` event, the corresponding topbar health indicator SHALL transition to green. *For any* valid service name in a `system:service_offline` event, the corresponding indicator SHALL transition to red.

**Validates: Requirements 4.5, 4.6**

---

### Property 10: Probe emits only on state transitions

*For any* sequence of probe results for a given service, `system:service_online` SHALL only be emitted when the probe result transitions from `false` to `true`, and `system:service_offline` SHALL only be emitted when the probe result transitions from `true` to `false`. Repeated identical results SHALL NOT produce additional events.

**Validates: Requirements 8.2, 8.3, 8.5, 8.6**

---

## Error Handling

### Backend

| Scenario | Handling |
|---|---|
| `GET /api/system/status` — PostgreSQL probe times out | Catch the error, return `status: "offline"` for postgres with the error message; do not crash the request |
| `GET /api/system/status` — called without JWT | `authenticate` middleware returns 401 before the handler runs |
| Outlook probe throws unhandled exception | Wrapped in `try/catch`; error logged to console; probe schedule continues via `setInterval` |
| PostgreSQL probe throws | Same as above; `markOffline('postgres', err.message)` called |
| `io.emit` wrapper throws | Wrapped in `try/catch`; original emit still proceeds; bridge failure is non-fatal |
| Activity log `append()` called with malformed event | Validate required fields; throw `TypeError` with descriptive message so callers fail fast |

### Frontend

| Scenario | Handling |
|---|---|
| `GET /api/system/status` fails on load | Log warning; leave all indicators in a neutral grey state; do not block page load |
| Socket.IO disconnects | Existing reconnect logic handles this; indicators remain at last known state |
| `uc_user` missing from localStorage | Panel header shows "Unknown user"; sidebar already handles this gracefully |
| JWT expires mid-session | `apiFetch()` 401 handler appends session-expired log event, then redirects |
| `system:log_snapshot` arrives with malformed events | Filter out events missing required fields before rendering |

---

## Testing Strategy

### Unit Tests (example-based)

Focus on specific scenarios and edge cases:

- `activityLog.append()` with valid and invalid event shapes
- `activityLog.getRecent(n)` with n > buffer size, n = 0, n = exact buffer size
- `GET /api/system/status` with mocked service states (all online, all offline, mixed)
- `GET /api/system/status` returns 401 without JWT
- `GET /api/system/log?limit=N` with N = 0, N = 1, N = 500, N = 501 (capped)
- Bridge: `wa:connected` event triggers `system:service_online` for whatsapp
- Bridge: `pbx:disconnected` event triggers `system:service_offline` for pbx
- Probe: Outlook probe emits offline only on false-after-true transition
- Probe: PostgreSQL probe emits online only on success-after-failure transition
- `notifyService()` uses 8000ms for offline, 4000ms for reconnect

### Property-Based Tests

The project uses JavaScript on both ends. The recommended PBT library is **[fast-check](https://github.com/dubzzz/fast-check)** (no new runtime dependency needed for tests — add as a `devDependency`).

Each property test runs a minimum of **100 iterations**.

**Tag format: `Feature: system-activity-log, Property N: <property_text>`**

```js
// Feature: system-activity-log, Property 1: Status API response completeness
fc.assert(fc.property(
  fc.record({
    whatsapp: fc.boolean(), pbx: fc.boolean(),
    outlook: fc.boolean(), postgres: fc.boolean()
  }),
  (states) => {
    setServiceStates(states);
    const res = callStatusAPI();
    return ['whatsapp','pbx','outlook','postgres'].every(svc =>
      res[svc] && 'status' in res[svc] && 'lastConnected' in res[svc] && 'lastDisconnected' in res[svc]
    );
  }
), { numRuns: 100 });

// Feature: system-activity-log, Property 4: Sequence numbers are strictly increasing
fc.assert(fc.property(
  fc.array(fc.record({ service: fc.constantFrom('whatsapp','pbx','outlook','postgres'), online: fc.boolean() }), { minLength: 2, maxLength: 50 }),
  (events) => {
    const emitted = [];
    events.forEach(e => e.online ? bridge.markOnline(e.service) : bridge.markOffline(e.service, 'test'));
    // collect emitted system:* events
    for (let i = 1; i < emitted.length; i++) {
      if (emitted[i].seq <= emitted[i-1].seq) return false;
    }
    return true;
  }
), { numRuns: 100 });

// Feature: system-activity-log, Property 6: Ring buffer capacity invariant
fc.assert(fc.property(
  fc.integer({ min: 500, max: 1000 }),
  (n) => {
    const log = createFreshLog();
    for (let i = 0; i < n; i++) log.append({ type:'online', service:'whatsapp', message:`event ${i}`, timestamp: new Date().toISOString() });
    return log.size() === 500 && log.getRecent(500)[499].message === `event ${n-1}`;
  }
), { numRuns: 100 });
```

### Integration Tests

- Start the Express server with a real PostgreSQL connection; call `GET /api/system/status` and verify postgres shows online.
- Connect a Socket.IO test client; verify `system:log_snapshot` is received within 1000ms of connection.
- Trigger `wa:connected` via the WA service mock; verify `system:service_online` is received by a connected test client.

### Smoke Tests

- Server starts without errors after adding `backend/routes/system.js` and the bridge code.
- `GET /api/health` still returns 200 (existing health check unaffected).
- `GET /api/system/status` returns 200 with a valid JWT.
- `GET /api/system/status` returns 401 without a JWT.

# Implementation Plan: System Activity Log

## Overview

Implement real-time service health visibility for UniComm Pro. The work is split into five phases: the backend ring-buffer module, the REST API routes, the Socket.IO bridge and probes in `server.js`, the frontend topbar indicators and activity log panel, and finally the offline toast notifications and JWT user display. Each phase builds on the previous one and is wired together at the end.

No new npm runtime packages are required. `fast-check` is added as a `devDependency` for property-based tests only.

---

## Tasks

- [x] 1. Create the `activityLog` ring-buffer module
  - Create `backend/services/activityLog.js` as a singleton module
  - Implement a fixed-length array (capacity 500) with a write-pointer for O(1) appends
  - Implement `append(event)` — validates all five required fields (`seq`, `type`, `service`, `message`, `timestamp`), throws `TypeError` on missing fields, assigns the next monotonically increasing `seq`, stores the event, and returns the stored event
  - Implement `getRecent(n)` — returns the last `n` events in insertion order (newest last); handles `n > size` and `n = 0` gracefully
  - Implement `getAll()` — returns full buffer contents in insertion order
  - Implement `size()` — returns current count (0–500)
  - Export the singleton instance
  - _Requirements: 3.1, 3.2, 3.3_

  - [ ]* 1.1 Write property test for ring-buffer capacity invariant
    - **Property 6: Ring buffer capacity invariant**
    - **Validates: Requirements 3.2, 3.3**
    - Add `fast-check` as a `devDependency` in `backend/package.json`
    - Create `backend/tests/activityLog.property.test.js`
    - For any N in [500, 1000], append N events and assert `size() === 500` and the last event is the most recently appended

  - [ ]* 1.2 Write property test for event structure invariant
    - **Property 5: Activity log event structure**
    - **Validates: Requirement 3.1**
    - For any valid event object, `append()` followed by `getRecent(1)` returns an object with all five required fields and a parseable ISO 8601 timestamp

  - [ ]* 1.3 Write unit tests for `activityLog`
    - Test `append()` with valid and invalid event shapes (missing fields, wrong types)
    - Test `getRecent(n)` with `n > size`, `n = 0`, `n = exact capacity`
    - Test `size()` before and after filling the buffer
    - _Requirements: 3.1, 3.2, 3.3_

- [x] 2. Create `backend/routes/system.js` — REST endpoints
  - Create `backend/routes/system.js`
  - Import `authenticate` middleware from `backend/middleware/auth.js`
  - Import `activityLog` from `backend/services/activityLog.js`
  - Import `pool` from `backend/db/pool.js`
  - Import `msGraph` from `backend/services/msGraph.js`
  - Declare and export a `serviceState` object (whatsapp, pbx, outlook, postgres — all initially `offline` with null timestamps); this object will be mutated by the bridge in `server.js`
  - Implement `GET /api/system/status` (requires `authenticate`):
    - Probe PostgreSQL live with `pool.query('SELECT 1')` inside a try/catch; update `serviceState.postgres` accordingly
    - Return the full `serviceState` object with `status`, `lastConnected`, `lastDisconnected` for all four services
    - Respond within 3000ms; on PostgreSQL timeout return `offline` for postgres without crashing
  - Implement `GET /api/system/log` (requires `authenticate`):
    - Accept optional `?limit=N` query param (default 100, cap at 500)
    - Return `{ events: [...], total: N }` in reverse-chronological order (newest first)
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 3.6_

  - [ ]* 2.1 Write property test for Status API response completeness
    - **Property 1: Status API response completeness**
    - **Validates: Requirements 1.1, 1.2**
    - Create `backend/tests/systemRoutes.property.test.js`
    - For any combination of boolean states for the four services set in `serviceState`, assert the response contains all four service keys each with `status`, `lastConnected`, and `lastDisconnected` fields present

  - [ ]* 2.2 Write property test for Status API state reflection
    - **Property 2: Status API reflects internal state**
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 1.7**
    - For any combination of boolean states set in `serviceState`, assert `GET /api/system/status` returns `"online"` for each `true` flag and `"offline"` for each `false` flag

  - [ ]* 2.3 Write property test for log query limit
    - **Property 7: Log query limit is respected**
    - **Validates: Requirement 3.6**
    - For any integer N in [1, 500], assert `GET /api/system/log?limit=N` returns at most N events, and exactly N events when the log contains ≥ N entries

  - [ ]* 2.4 Write unit tests for system routes
    - Test `GET /api/system/status` with mocked service states (all online, all offline, mixed)
    - Test `GET /api/system/status` returns 401 without a valid JWT
    - Test `GET /api/system/log?limit=N` with N = 0, N = 1, N = 500, N = 501 (capped to 500)
    - _Requirements: 1.1, 1.8, 1.9, 3.6_

- [x] 3. Add Socket.IO bridge and probes to `server.js`
  - Import `activityLog` and `serviceState` (from `backend/routes/system.js`) at the top of `server.js`
  - Import `msGraph` from `backend/services/msGraph.js`
  - Read probe intervals from env: `OUTLOOK_PROBE_INTERVAL_MS` (default 60000) and `DB_PROBE_INTERVAL_MS` (default 30000)
  - Implement `markOnline(service)` helper: update `serviceState[service].status = 'online'` and `lastConnected`, append event to `activityLog`, call `_origEmit('system:service_online', { service, timestamp, seq })`
  - Implement `markOffline(service, reason)` helper: update `serviceState[service].status = 'offline'` and `lastDisconnected`, append event to `activityLog`, call `_origEmit('system:service_offline', { service, timestamp, reason, seq })`
  - Wrap `io.emit` after `wa.setIO(io)` and `smdr.setIO(io)`: store `_origEmit = io.emit.bind(io)`, replace `io.emit` with a wrapper that calls `_origEmit` then `systemBridge(event, data)` inside a try/catch (bridge failure is non-fatal)
  - Implement `systemBridge(event, data)`: handle `wa:connected` → `markOnline('whatsapp')`, `wa:disconnected` → `markOffline('whatsapp', data?.reason)`, `pbx:connected` → `markOnline('pbx')`, `pbx:disconnected` → `markOffline('pbx', data?.reason)`
  - Listen for PostgreSQL pool `error` event: `pool.on('error', err => markOffline('postgres', err.message))`
  - Add `io.on('connection', socket => socket.emit('system:log_snapshot', { events: activityLog.getRecent(100) }))` — sends snapshot to each new client
  - Add Outlook probe `setInterval`: call `msGraph.isAuthenticated()`, call `markOnline`/`markOffline` only on state transitions (not on repeated identical results)
  - Add PostgreSQL probe `setInterval`: run `pool.query('SELECT 1')`, call `markOnline`/`markOffline` only on state transitions; wrap in try/catch, log errors to console
  - Register `backend/routes/system.js` under `app.use('/api/system', apiLimiter, require('./routes/system'))` in `server.js`
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3.4, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_

  - [ ]* 3.1 Write property test for event payload completeness
    - **Property 3: Event payload completeness**
    - **Validates: Requirements 2.1, 2.2**
    - Create `backend/tests/bridge.property.test.js`
    - For any service name and reason string, assert `system:service_offline` payload contains `service`, `timestamp` (ISO 8601 parseable), `reason`, and `seq`; assert `system:service_online` payload contains `service`, `timestamp`, and `seq`

  - [ ]* 3.2 Write property test for strictly increasing sequence numbers
    - **Property 4: Sequence numbers are strictly increasing**
    - **Validates: Requirement 2.9**
    - For any sequence of N online/offline bridge calls, collect emitted `system:*` events and assert each `seq` is strictly greater than the previous

  - [ ]* 3.3 Write property test for probe state-transition-only emission
    - **Property 10: Probe emits only on state transitions**
    - **Validates: Requirements 8.2, 8.3, 8.5, 8.6**
    - For any sequence of probe results for a given service, assert `system:service_online` is emitted only when transitioning from `false` to `true`, and `system:service_offline` only when transitioning from `true` to `false`; repeated identical results produce no additional events

  - [ ]* 3.4 Write unit tests for the bridge
    - Test `wa:connected` triggers `system:service_online` for whatsapp
    - Test `wa:disconnected` triggers `system:service_offline` for whatsapp with reason
    - Test `pbx:connected` / `pbx:disconnected` trigger corresponding system events
    - Test Outlook probe emits offline only on false-after-true transition
    - Test PostgreSQL probe emits online only on success-after-failure transition
    - _Requirements: 2.4, 2.5, 2.6, 2.7, 8.2, 8.3, 8.5, 8.6_

- [x] 4. Checkpoint — verify backend is wired correctly
  - Ensure all backend tests pass, ask the user if questions arise.
  - Smoke-test: server starts without errors after adding `activityLog.js`, `routes/system.js`, and bridge code
  - Verify `GET /api/health` still returns 200
  - Verify `GET /api/system/status` returns 200 with a valid JWT and 401 without one
  - Verify `system:log_snapshot` is received by a Socket.IO test client within 1000ms of connection

- [x] 5. Replace static topbar pills with live Health Indicators in `dashboard.html`
  - Replace the four existing static pill elements in the topbar with dynamic elements using IDs `svc-postgres`, `svc-pbx`, `svc-whatsapp`, `svc-outlook` and inner dot/icon spans with IDs `dot-postgres`, `dot-pbx`, `dot-whatsapp`, `dot-outlook`
  - Add CSS class `.svc-dot` (6px circle, default grey) to the `<style>` block
  - Implement `updateServiceIndicator(service, online)` JS function: sets dot/icon colour to `var(--green)` when online, `var(--red)` when offline; uses `#25D366` for WhatsApp and `#0078d4` for Outlook icons
  - Implement `initSystemStatus()`: calls `GET /api/system/status` via `apiFetch`, sets all four indicators to correct initial state; on failure logs a warning and leaves indicators in neutral grey — does not block page load
  - Call `initSystemStatus()` from the existing auth-guard success block (after JWT validation) so it runs within 2000ms of page load
  - Remove the existing `showDbStatus()` call and its implementation (the PostgreSQL indicator replaces it)
  - Wire Socket.IO listeners: `socket.on('system:service_online', e => updateServiceIndicator(e.service, true))` and `socket.on('system:service_offline', e => updateServiceIndicator(e.service, false))`
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10_

  - [ ]* 5.1 Write property test for health indicator state reflection
    - **Property 8: Health indicators reflect API response**
    - **Validates: Requirements 4.2, 4.3, 4.4**
    - For any combination of service statuses returned by a mocked `GET /api/system/status`, after `initSystemStatus()` completes, assert each of the four indicator dots is green for `"online"` and red for `"offline"`

  - [ ]* 5.2 Write property test for health indicator Socket.IO updates
    - **Property 9: Health indicators update on Socket.IO events**
    - **Validates: Requirements 4.5, 4.6**
    - For any valid service name in a `system:service_online` event, assert the corresponding indicator transitions to green; for `system:service_offline`, assert it transitions to red

- [x] 6. Implement the Activity Log Panel slide-over drawer in `dashboard.html`
  - Add the "Activity Log" trigger button to `.topbar-actions`: `<button class="btn btn-ghost btn-sm" id="activity-log-btn" onclick="openActivityLog()"><i class="fas fa-list-alt"></i> Activity Log</button>`
  - Append the overlay `<div id="activity-log-overlay">` and drawer `<div id="activity-log-panel">` to `<body>` with the structure defined in the design (header with count badge, user info, Clear button, close button; scrollable `#alp-list`)
  - Add CSS for the panel (slide-in from right, z-index above content, dark card background matching `var(--card)`, border, shadow)
  - Implement `openActivityLog()`: show overlay and panel, call `GET /api/system/log` via `apiFetch` to load the 100 most recent events, render them in reverse-chronological order using `renderLogEvent(ev)`, populate `#alp-user-info` from `localStorage` `uc_user`, update count badge
  - Implement `closeActivityLog()`: hide overlay and panel, restore focus to the trigger button
  - Implement `renderLogEvent(ev)`: returns an HTML string with colour-coded icon (🟢 online, 🔴 offline, 🟡 error, 🔵 user_login), service name, message, and timestamp formatted as `HH:MM:SS DD/MM/YYYY`
  - Implement `prependLogEvent(ev)`: prepends a new rendered row to `#alp-list` and increments the count badge — called when `system:service_online` or `system:service_offline` arrives while the panel is open
  - Wire Socket.IO listeners to call `prependLogEvent` when the panel is open
  - Implement the "Clear" button: empties `#alp-list` and resets count badge to 0 (local view only, no backend call)
  - Implement keyboard accessibility: Escape key closes the panel; implement `focusTrap` that cycles Tab between the first and last focusable elements inside the panel while it is open
  - Filter out events missing required fields before rendering (handle malformed `system:log_snapshot` payloads)
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

- [x] 7. Implement offline Notification Toasts and JWT user display
  - Implement `notifyService(service, online, reason)` function in `dashboard.html`:
    - Uses 8000ms duration for offline events, 4000ms for reconnect events
    - Red accent + warning icon for offline; green accent + check icon for reconnect
    - Populates the existing `#notif` element (same DOM structure as `notify()`) and manages `notifTimer`
  - Implement per-service deduplication: maintain a `Map<service, toastTimerId>` — if a second `system:service_offline` arrives for the same service while a toast is visible, clear the existing timer and update the toast content in place
  - Implement toast queue with 300ms stagger (`toastQueue` array) so multiple simultaneous failures each get their own visible toast
  - Wire `socket.on('system:service_offline', e => notifyService(e.service, false, e.reason))` and `socket.on('system:service_online', e => notifyService(e.service, true))` in the Socket.IO setup block
  - Implement JWT user display: in the auth-guard success block, read `uc_user` from `localStorage` and populate the sidebar `#sidebar-name` and `#sidebar-role` elements (if not already populated by existing code)
  - Implement session-expiry log event: in the existing `apiFetch()` 401 handler, call `appendLocalLogEvent('system', 'error', 'Session expired — please log in again')` before redirecting to `login.html`
  - Implement `appendLocalLogEvent(service, type, message)`: prepends a locally-generated event row to `#alp-list` if the panel is open (no backend call needed)
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.1, 7.2, 7.3, 7.4_

  - [ ]* 7.1 Write unit tests for `notifyService`
    - Test offline toast uses 8000ms duration
    - Test reconnect toast uses 4000ms duration
    - Test duplicate offline event for same service updates existing toast rather than stacking
    - _Requirements: 6.3, 6.5, 6.7_

- [x] 8. Final checkpoint — end-to-end verification
  - Ensure all tests pass, ask the user if questions arise.
  - Verify the four topbar indicators initialise correctly on page load
  - Verify a simulated `wa:connected` / `wa:disconnected` event updates the topbar indicator and prepends a row in the Activity Log Panel
  - Verify the Activity Log Panel opens, loads events, and closes with Escape
  - Verify an offline toast shows for 8s and a reconnect toast shows for 4s
  - Verify `GET /api/system/log` returns events in reverse-chronological order

---

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- The `io.emit` wrapper approach avoids any changes to `whatsapp.js` or `matrixSmdr.js` (WhatsApp change protocol compliance)
- `serviceState` is exported from `routes/system.js` and imported by `server.js` so both the REST handler and the bridge share the same object reference
- Property tests use `fast-check` added as a `devDependency` only — no runtime impact
- Each property test references its property number from the design document for traceability
- Checkpoints at tasks 4 and 8 ensure incremental validation before proceeding to the next phase

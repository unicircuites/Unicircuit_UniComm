# Requirements Document

## Introduction

UniComm Pro integrates four external services — Outlook (Microsoft Graph), WhatsApp Business (Baileys), Matrix PBX (SMDR TCP), and PostgreSQL — that can go offline silently without any visible warning to the dashboard user. This feature adds a **System Activity Log** that gives the operator continuous, real-time visibility into service health, connection events, error conditions, and the identity of the currently logged-in user. It also upgrades the existing topbar status indicators from static decorations to live, reactive health badges, and introduces proactive toast/alert notifications so the operator is never caught off-guard by a silent service failure.

---

## Glossary

- **Activity_Log**: The in-memory and optionally persisted ordered list of timestamped system events shown in the dashboard.
- **Activity_Log_Panel**: The UI panel (slide-over drawer or dedicated section) that renders the Activity_Log entries.
- **Dashboard**: The single-page application served from `dashboard.html`.
- **Event**: A discrete, timestamped record of a service state change, error, or user action appended to the Activity_Log.
- **Health_Indicator**: A visual element in the topbar that reflects the current online/offline status of a single service.
- **JWT_User**: The authenticated operator whose identity is decoded from the JSON Web Token stored in the browser.
- **Notification_Toast**: A transient overlay message displayed in the bottom-right corner of the Dashboard when a service goes offline or reconnects.
- **Outlook_Service**: The Microsoft Graph OAuth2 integration managed by `backend/services/msGraph.js`.
- **PBX_Service**: The Matrix Eternity SMDR TCP listener managed by `backend/services/matrixSmdr.js`.
- **PostgreSQL_Service**: The database connection pool managed by `backend/db/pool.js`.
- **Service**: Any of the four integrations: Outlook_Service, WhatsApp_Service, PBX_Service, PostgreSQL_Service.
- **Service_Status**: The current state of a Service — either `online` or `offline`.
- **Socket_IO_Server**: The Socket.IO instance attached to the Express HTTP/HTTPS server in `backend/server.js`.
- **Status_API**: The REST endpoint `GET /api/system/status` that returns the current Service_Status of all Services.
- **WhatsApp_Service**: The Baileys-based WhatsApp Business integration managed by `backend/services/whatsapp.js`.

---

## Requirements

### Requirement 1: Service Status API

**User Story:** As an operator, I want a single API endpoint that returns the current online/offline status of all services, so that the Dashboard can display accurate health information on load.

#### Acceptance Criteria

1. THE Status_API SHALL return a JSON object containing the Service_Status, last-connected timestamp, and last-disconnected timestamp for each of the four Services.
2. WHEN the Status_API is called, THE Status_API SHALL reflect the live connection state of each Service at the time of the request.
3. WHEN the PostgreSQL_Service connection pool is reachable, THE Status_API SHALL report PostgreSQL_Service as `online`.
4. IF the PostgreSQL_Service connection pool query fails, THEN THE Status_API SHALL report PostgreSQL_Service as `offline`.
5. WHEN the WhatsApp_Service `isConnected` flag is `true`, THE Status_API SHALL report WhatsApp_Service as `online`.
6. WHEN the PBX_Service `isConnected` flag is `true`, THE Status_API SHALL report PBX_Service as `online`.
7. WHEN the Outlook_Service `isAuthenticated()` check returns `true`, THE Status_API SHALL report Outlook_Service as `online`.
8. THE Status_API SHALL respond within 3000ms under normal operating conditions.
9. THE Status_API SHALL require a valid JWT Bearer token in the `Authorization` header.

---

### Requirement 2: Real-Time Service Events via Socket.IO

**User Story:** As an operator, I want the Dashboard to receive service state changes instantly without polling, so that I see disconnections and reconnections the moment they happen.

#### Acceptance Criteria

1. WHEN any Service transitions from `online` to `offline`, THE Socket_IO_Server SHALL emit a `system:service_offline` event containing the service name, timestamp, and a human-readable reason string.
2. WHEN any Service transitions from `offline` to `online`, THE Socket_IO_Server SHALL emit a `system:service_online` event containing the service name and timestamp.
3. WHEN the Outlook_Service token refresh fails, THE Socket_IO_Server SHALL emit a `system:service_offline` event with reason `"Outlook token expired"`.
4. WHEN the WhatsApp_Service emits `wa:disconnected`, THE Socket_IO_Server SHALL also emit `system:service_offline` for WhatsApp_Service with the disconnect reason code included.
5. WHEN the WhatsApp_Service emits `wa:connected`, THE Socket_IO_Server SHALL also emit `system:service_online` for WhatsApp_Service.
6. WHEN the PBX_Service emits `pbx:disconnected`, THE Socket_IO_Server SHALL also emit `system:service_offline` for PBX_Service.
7. WHEN the PBX_Service emits `pbx:connected`, THE Socket_IO_Server SHALL also emit `system:service_online` for PBX_Service.
8. WHEN the PostgreSQL_Service pool emits an `error` event, THE Socket_IO_Server SHALL emit `system:service_offline` for PostgreSQL_Service.
9. THE Socket_IO_Server SHALL include a monotonically increasing sequence number in every `system:service_online` and `system:service_offline` event payload so the Dashboard can detect missed events.

---

### Requirement 3: Activity Log Data Model and Storage

**User Story:** As an operator, I want service events to be stored in an ordered log, so that I can review what happened during a session even after the fact.

#### Acceptance Criteria

1. THE Activity_Log SHALL store each Event as a record containing: event type (`online` | `offline` | `error` | `user_login`), service name, message, timestamp (ISO 8601), and sequence number.
2. THE Activity_Log SHALL retain a minimum of 500 Events in memory on the backend at any time.
3. WHEN the Activity_Log reaches 500 Events, THE Activity_Log SHALL discard the oldest Event before appending a new one (ring-buffer behaviour).
4. THE Socket_IO_Server SHALL emit a `system:log_snapshot` event to each newly connected Socket.IO client containing the most recent 100 Events from the Activity_Log.
5. WHEN a JWT_User authenticates successfully, THE Activity_Log SHALL append a `user_login` Event recording the user's name, email, and login timestamp.
6. THE Activity_Log SHALL be queryable via `GET /api/system/log` returning the most recent N Events (default 100, maximum 500), requiring a valid JWT Bearer token.

---

### Requirement 4: Topbar Health Indicators

**User Story:** As an operator, I want the topbar to show live colour-coded status dots for each service, so that I can assess system health at a glance without opening any panel.

#### Acceptance Criteria

1. THE Dashboard SHALL display a Health_Indicator in the topbar for each of the four Services: Outlook_Service, WhatsApp_Service, PBX_Service, and PostgreSQL_Service.
2. WHEN a Service is `online`, THE Health_Indicator for that Service SHALL display a green dot and the service label.
3. WHEN a Service is `offline`, THE Health_Indicator for that Service SHALL display a red dot and the service label.
4. WHEN the Dashboard first loads, THE Dashboard SHALL call the Status_API and set each Health_Indicator to the correct initial state within 2000ms of page load.
5. WHEN a `system:service_online` event is received, THE Dashboard SHALL update the corresponding Health_Indicator to green without a page reload.
6. WHEN a `system:service_offline` event is received, THE Dashboard SHALL update the corresponding Health_Indicator to red without a page reload.
7. THE Health_Indicator for PBX_Service SHALL replace the existing static green dot currently hardcoded in the topbar HTML.
8. THE Health_Indicator for WhatsApp_Service SHALL replace the existing static WhatsApp pill currently hardcoded in the topbar HTML.
9. THE Health_Indicator for Outlook_Service SHALL replace the existing static Outlook pill currently hardcoded in the topbar HTML.
10. THE Health_Indicator for PostgreSQL_Service SHALL replace the existing `db-status-badge` dynamically injected by `showDbStatus()`.

---

### Requirement 5: Activity Log Panel UI

**User Story:** As an operator, I want to open a panel that shows a scrollable, timestamped log of all service events during the current session, so that I can diagnose when and why a service went offline.

#### Acceptance Criteria

1. THE Dashboard SHALL provide a button or icon in the topbar that opens the Activity_Log_Panel.
2. WHEN the Activity_Log_Panel is opened, THE Dashboard SHALL display the 100 most recent Events from the Activity_Log in reverse-chronological order (newest first).
3. THE Activity_Log_Panel SHALL render each Event with: a colour-coded icon (green for `online`, red for `offline`, amber for `error`, blue for `user_login`), the service name or actor, the event message, and the timestamp formatted as `HH:MM:SS DD/MM/YYYY`.
4. WHEN a new Event arrives via Socket.IO while the Activity_Log_Panel is open, THE Dashboard SHALL prepend the new Event to the Activity_Log_Panel without requiring a manual refresh.
5. THE Activity_Log_Panel SHALL display the name and email of the currently logged-in JWT_User at the top of the panel.
6. THE Activity_Log_Panel SHALL include a "Clear" button that removes all displayed entries from the local view without affecting the backend log.
7. WHILE the Activity_Log_Panel is open and contains more than 0 Events, THE Dashboard SHALL display the count of Events in the panel header.
8. THE Activity_Log_Panel SHALL be accessible via keyboard (openable and closable with the Escape key) and SHALL trap focus while open.

---

### Requirement 6: Offline Notification Toasts

**User Story:** As an operator, I want a visible alert the moment any service goes offline, so that I don't discover a failure only when I try to use that service.

#### Acceptance Criteria

1. WHEN a `system:service_offline` event is received, THE Dashboard SHALL display a Notification_Toast identifying the service that went offline and the reason.
2. THE Notification_Toast SHALL be visually distinct from normal informational toasts, using a red accent colour and a warning icon.
3. THE Notification_Toast for a service-offline event SHALL remain visible for a minimum of 8000ms before auto-dismissing.
4. WHEN a `system:service_online` event is received for a service that was previously offline, THE Dashboard SHALL display a Notification_Toast confirming the reconnection, using a green accent colour.
5. THE Notification_Toast for a reconnection event SHALL auto-dismiss after 4000ms.
6. WHEN multiple services go offline within 2000ms of each other, THE Dashboard SHALL display a separate Notification_Toast for each service rather than collapsing them.
7. IF a Notification_Toast is already visible for a given service and a second offline event arrives for the same service, THEN THE Dashboard SHALL update the existing toast rather than stacking a duplicate.

---

### Requirement 7: Logged-In User Display

**User Story:** As an operator, I want to see which user is currently logged into the dashboard, so that I can confirm the correct account is active and audit sessions.

#### Acceptance Criteria

1. THE Dashboard SHALL decode the JWT stored in `localStorage` and display the JWT_User's name and role in the sidebar user block on every page load.
2. THE Dashboard SHALL display the JWT_User's email in the Activity_Log_Panel header.
3. WHEN the JWT expires, THE Dashboard SHALL append a `user_login` Event of type `error` to the Activity_Log with message `"Session expired — please log in again"` before redirecting to the login page.
4. THE Dashboard SHALL NOT expose the raw JWT token value in any visible UI element.

---

### Requirement 8: Backend Service Health Probing

**User Story:** As an operator, I want the backend to actively detect silent failures (such as an expired Outlook token) rather than waiting for an explicit error, so that the activity log reflects reality even when no user action triggers a failure.

#### Acceptance Criteria

1. THE Socket_IO_Server SHALL probe the Outlook_Service authentication status every 60 seconds by calling `isAuthenticated()`.
2. WHEN the Outlook_Service probe returns `false` after previously returning `true`, THE Socket_IO_Server SHALL emit `system:service_offline` with reason `"Outlook token expired or revoked"`.
3. WHEN the Outlook_Service probe returns `true` after previously returning `false`, THE Socket_IO_Server SHALL emit `system:service_online` for Outlook_Service.
4. THE Socket_IO_Server SHALL probe the PostgreSQL_Service every 30 seconds by executing a lightweight query (`SELECT 1`).
5. WHEN the PostgreSQL_Service probe fails, THE Socket_IO_Server SHALL emit `system:service_offline` for PostgreSQL_Service with the error message included.
6. WHEN the PostgreSQL_Service probe succeeds after a previous failure, THE Socket_IO_Server SHALL emit `system:service_online` for PostgreSQL_Service.
7. THE probing intervals SHALL be configurable via environment variables `OUTLOOK_PROBE_INTERVAL_MS` and `DB_PROBE_INTERVAL_MS`, defaulting to 60000ms and 30000ms respectively.
8. IF a probe throws an unhandled exception, THEN THE Socket_IO_Server SHALL catch the exception, log it to the server console, and continue the probe schedule without crashing.

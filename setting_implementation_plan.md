Implementation Plan — Settings & Sync (Full Redesign with Test Cases)

    Problem Statement:

    Settings tab has broken scrolling, incomplete coverage, and no way to verify a service is actually
    working end-to-end. Need a comprehensive control panel where any frontend/sync issue can be diagnosed
    and fixed without leaving the tab.

    Requirements:

    - Fix scrolling (broken due to flex height)
    - Two-column layout: left nav tabs + right scrollable content
    - All sync actions per service
    - Test case per service that actually pings/verifies the service is alive and responding correctly
    - Persistent action log across all actions

  ────────────────────────────────────────────────────────────────────────────────────────────────────────

    Background from codebase:

    ┌────────────┬───────────────────────────────────────────────────────────────────────┐
    │ Service    │ Existing test-able endpoints                                          │
    ├────────────┼───────────────────────────────────────────────────────────────────────┤
    │ WhatsApp   │ GET /api/wa/status → {connected, phone}, GET /api/wa/resolution-stats │
    ├────────────┼───────────────────────────────────────────────────────────────────────┤
    │ PBX        │ GET /api/calls (uses DB + SMDR), topbar dot color reflects TCP status │
    ├────────────┼───────────────────────────────────────────────────────────────────────┤
    │ Outlook    │ GET /api/outlook/status or check checkOutlookStatus()                 │
    ├────────────┼───────────────────────────────────────────────────────────────────────┤
    │ PostgreSQL │ GET /api/health                                                       │
    └────────────┴───────────────────────────────────────────────────────────────────────┘

  ────────────────────────────────────────────────────────────────────────────────────────────────────────

    Task Breakdown:

    Task 1: Fix scrolling + two-column shell

    - Replace current sec-settings inner wrapper with: left sidebar (180px, fixed) + right panel (flex:1;
    overflow-y:auto; height:calc(100vh - 98px))
    - Left sidebar has 4 nav items: WhatsApp, PBX, Outlook, System — clicking shows corresponding right
    panel div
    - CSS: .settings-tab-nav, .settings-tab-panel
    - Demo: tab is scrollable, left nav highlights active tab

    Task 2: WhatsApp panel

    Actions:

    - Sync Chats & Contacts
    - Reload Chats (UI only)
    - Resolve LIDs
    - Reset Group Contacts (confirm dialog)
    - Create Backup
    - Import Chat (.txt)
    - Load Backup
    - Disconnect
    - Reset WA Data (danger, double-confirm)

    Status row: phone number, LID progress bar (resolved/total), chat count, contact count

    Test case — "Run WA Test":

    - Calls GET /api/wa/status → checks connected === true
    - Calls GET /api/wa/resolution-stats → checks response has totalChats > 0
    - Sends a test ping: POST /api/wa/send with { jid: 'status@broadcast', message: '' } skipped — instead
    just checks socket is alive via status
    - Logs: ✅ Connected as +91XXXXX / ❌ Not connected

    Task 3: PBX panel

    Actions:

    - Sync Call Logs
    - Reconnect PBX TCP
    - Sync Recordings to DB

    Status: last SMDR received timestamp, TCP dot

    Test case — "Run PBX Test":

    - Calls GET /api/calls?limit=1 with auth → checks response has at least 1 record
    - Checks topbar PBX dot color for TCP live status
    - Logs: ✅ PBX reachable, last call`<timestamp>` / ❌ No call records or TCP offline

    Task 4: Outlook panel

    Actions:

    - Sync Inbox
    - Open Inbox (navigate)
    - Re-authenticate (opens OAuth flow)

    Status: connected account email, token expiry if available

    Test case — "Run Outlook Test":

    - Calls GET /api/outlook/status (or checkOutlookStatus() result) → checks connected === true
    - Calls GET /api/email/messages?limit=1 → checks at least 1 email returned
    - Logs: ✅ Outlook connected as user@domain / ❌ Not authenticated

    Task 5: System Status panel

    6-tile status grid:

    - PostgreSQL — GET /api/health
    - WhatsApp — /api/wa/status
    - Matrix PBX — topbar dot
    - Outlook — outlook status
    - WA Chats count
    - LID Resolution %

    Test case — "Run Full System Test":

    - Runs all 4 service tests sequentially
    - Shows a summary: 4/4 ✅ or X/4 ❌ with individual pass/fail lines

    Task 6: Persistent action log (shared across all tabs)

    - 200px monospace log div, timestamps on every line
    - Clear Log button
    - Copy Log button (copies to clipboard)
    - Log persists when switching between WA/PBX/Outlook/System tabs

    Task 7: JS — settingsRefreshStatus, test runners, tab switcher

    - settingsShowTab(tab) — switches active tab panel
    - settingsRunWaTest(), settingsRunPbxTest(), settingsRunOutlookTest(), settingsRunFullTest()
    - settingsClearLog(), settingsCopyLog()
    - All use getAuthHeaders() directly (no apiFetch) to avoid 401 redirect bug implement this plan

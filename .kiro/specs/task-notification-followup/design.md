# Design Document

## Feature: Task Notification & Follow-Up

---

## Overview

This feature extends the UniComm Pro dashboard with a complete task lifecycle management system built on top of the existing `mail_reply_tasks` table and `backend/routes/mailTasks.js` routes. It adds:

1. **DB migration** — `ALTER TABLE` to add new columns for assignee contact details, notification config, triage state, and timestamps.
2. **Extended backend routes** — updated POST/PATCH to accept new fields; automatic triage_tag derivation; a new `PATCH /:id/triage` convenience endpoint.
3. **Notification scheduler** — `backend/services/taskNotifier.js` using `node-cron` to send WhatsApp and/or Outlook email reminders before task due times.
4. **Frontend** — a task edit/create modal with all new fields, triage badge rendering on email rows, and a Follow-Up Control Panel.

The design follows existing patterns: Express routes with `authenticate` middleware, `pool.query` for DB access, `activityLog.append` for audit events, `node-cron` for scheduling (same as `marketingCron.js`), and vanilla JS with the existing `notify()` / modal pattern in `dashboard.html`.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  dashboard.html (frontend)                                      │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │  Task Edit Modal │  │ Follow-Up Panel  │  │ Triage Badge │  │
│  │  (create/edit)   │  │ (open tasks list)│  │ (email rows) │  │
│  └────────┬─────────┘  └────────┬─────────┘  └──────┬───────┘  │
│           │                     │                    │          │
│           └─────────────────────┴────────────────────┘          │
│                                 │                               │
│                    REST API calls (fetch + JWT)                  │
└─────────────────────────────────┼───────────────────────────────┘
                                  │
┌─────────────────────────────────▼───────────────────────────────┐
│  backend/routes/mailTasks.js                                    │
│                                                                 │
│  GET    /api/mail-tasks/          list tasks (with filters)     │
│  GET    /api/mail-tasks/by-message/:id  tasks for one email     │
│  GET    /api/mail-tasks/users     active system users           │
│  POST   /api/mail-tasks/          create task                   │
│  PATCH  /api/mail-tasks/:id       update task                   │
│  PATCH  /api/mail-tasks/:id/triage  quick triage update         │
│  DELETE /api/mail-tasks/:id       delete task                   │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
              ┌───────────────────┴──────────────────┐
              │                                      │
┌─────────────▼──────────────┐   ┌───────────────────▼──────────┐
│  PostgreSQL                │   │  backend/services/            │
│  mail_reply_tasks table    │   │  taskNotifier.js              │
│  (extended schema)         │   │                               │
│                            │   │  node-cron (every 30s)        │
│                            │   │  ├─ query eligible tasks      │
│                            │   │  ├─ send WA via POST /wa/send │
│                            │   │  └─ send email via graphPost  │
└────────────────────────────┘   └──────────────────────────────┘
```

---

## Components and Interfaces

### 1. DB Migration — `backend/db/migrations/add_task_notification_fields.js`

A standalone migration script (run once) that adds the new columns to `mail_reply_tasks`. The script is idempotent — it uses `ADD COLUMN IF NOT EXISTS`.

**New columns:**

| Column | Type | Default | Notes |
|---|---|---|---|
| `assigned_to_name` | TEXT | NULL | Denormalized assignee name (for non-system-user assignees) |
| `assigned_to_email` | VARCHAR(200) | NULL | Assignee email for email notifications |
| `assigned_to_phone` | VARCHAR(30) | NULL | Assignee phone (E.164 or local) for WA notifications |
| `notify_channel` | VARCHAR(10) | `'wa'` | `wa` / `email` / `both` |
| `notify_before_minutes` | INTEGER | `60` | Lead time before `due_at` |
| `triage_tag` | VARCHAR(10) | `'none'` | `red` / `yellow` / `green` / `none` |
| `replied_at` | TIMESTAMPTZ | NULL | When the task was marked as replied |
| `notified_at` | TIMESTAMPTZ | NULL | When the scheduler last sent a notification |

The existing `assigned_to_name` and `assigned_to_email` columns in the current `taskSelectSql()` are **computed via JOIN** from the `users` table. After migration, the table has its own `assigned_to_name` and `assigned_to_email` columns for non-system-user assignees. The SELECT query must be updated to use `COALESCE(t.assigned_to_name, assignee.name)` and `COALESCE(t.assigned_to_email, assignee.email)` so system-user tasks continue to work.

### 2. Updated `backend/routes/mailTasks.js`

#### `taskSelectSql()` — updated

```js
function taskSelectSql() {
  return `
    SELECT t.*,
           COALESCE(t.assigned_to_name, assignee.name)  AS assigned_to_name,
           COALESCE(t.assigned_to_email, assignee.email) AS assigned_to_email,
           creator.name AS assigned_by_name
    FROM mail_reply_tasks t
    LEFT JOIN users assignee ON assignee.id = t.assigned_to
    LEFT JOIN users creator  ON creator.id  = t.assigned_by
  `;
}
```

#### `normalizeNotifyChannel(value)`

```js
function normalizeNotifyChannel(v) {
  const s = String(v || '').trim().toLowerCase();
  return ['wa', 'email', 'both'].includes(s) ? s : 'wa';
}
```

#### `normalizeTriageTag(value)`

```js
function normalizeTriageTag(v) {
  const s = String(v || '').trim().toLowerCase();
  return ['red', 'yellow', 'green', 'none'].includes(s) ? s : 'none';
}
```

#### `deriveTriageTag(status, dueAt, repliedAt, manualTag)` — pure helper

Encodes the automatic triage derivation rules from Requirements 5.2–5.4. Called inside POST and PATCH before writing to DB.

```
if status is 'done' or 'cancelled'  → 'green'
else if repliedAt is non-null        → 'yellow'
else if (status is 'open' or 'in_progress') AND dueAt < now AND repliedAt is null → 'red'
else                                 → manualTag (preserve manual override, default 'none')
```

#### `POST /api/mail-tasks/` — extended fields

Accepts all new fields in `req.body`:
- `assigned_to_name`, `assigned_to_email`, `assigned_to_phone`
- `notify_channel`, `notify_before_minutes`
- `triage_tag` (manual; overridden by `deriveTriageTag`)

The `assigned_to` field is now optional (not required) to support non-system-user assignees. Validation: at least one of `assigned_to` (integer) or `assigned_to_name` must be present.

#### `PATCH /api/mail-tasks/:id` — extended fields

Accepts all new fields. Applies `deriveTriageTag` after resolving the new status/replied_at values. Handles `replied_at` — if `req.body.replied_at === 'now'`, stores `NOW()`.

#### `PATCH /api/mail-tasks/:id/triage` — new convenience endpoint

Accepts `{ triage_tag }` only. Validates against allowed values. Returns updated task. Used by the Follow-Up Panel's quick triage controls.

#### `GET /api/mail-tasks/` — follow-up panel filter

Adds support for `?panel=1` query param which filters to `status IN ('open','in_progress','waiting')` and orders by triage severity (red → yellow → green/none) then `due_at ASC`.

### 3. `backend/services/taskNotifier.js` — Notification Scheduler

A new service module following the same pattern as `marketingCron.js`.

**Interface:**
```js
module.exports = { start };
// start(pool, io) — called from server.js after pool and io are ready
```

**Cron schedule:** `*/30 * * * * *` (every 30 seconds — well within the 60s requirement).

**Eligibility query:**
```sql
SELECT * FROM mail_reply_tasks
WHERE status IN ('open', 'in_progress')
  AND due_at IS NOT NULL
  AND notify_channel IS NOT NULL
  AND notify_channel != 'none'
  AND notified_at IS NULL
  AND due_at > NOW()
  AND due_at <= NOW() + (notify_before_minutes * INTERVAL '1 minute')
```

**Notification dispatch:**
- `notify_channel = 'wa'` or `'both'`: POST to `http://localhost:{PORT}/api/wa/send` with `{ jid: phoneToJid(assigned_to_phone), message: buildWaMessage(task) }`. Uses an internal HTTP call (same server) with a service token, or calls the WA service directly via `require('../services/whatsapp').sendMessage(jid, text)`.
- `notify_channel = 'email'` or `'both'`: calls `graph.graphPost('/me/sendMail', buildEmailPayload(task))`.

**After sending:** `UPDATE mail_reply_tasks SET notified_at = NOW() WHERE id = $1`.

**Error handling:** All errors are caught, logged via `activityLog.append`, and do not propagate (no unhandled rejections).

**Message templates:**

WA message:
```
📋 Task Reminder
Subject: {subject}
Due: {due_at formatted as DD MMM YYYY HH:mm}
From: {sender_name}
{notes ? '\nNotes: ' + notes : ''}
```

Email subject: `Task Reminder: {subject}`
Email body (HTML): structured reminder with the same fields.

### 4. Frontend — `dashboard.html`

#### 4a. Triage Badge Helper

```js
function triageBadgeHtml(tag) {
  if (!tag || tag === 'none') return '';
  const map = {
    red:    { color: 'var(--red2)',  icon: 'fa-circle-exclamation', label: 'Urgent' },
    yellow: { color: 'var(--gold)',  icon: 'fa-clock',              label: 'Replied' },
    green:  { color: 'var(--green)', icon: 'fa-circle-check',       label: 'Done' },
  };
  const t = map[tag];
  if (!t) return '';
  return `<span class="triage-dot" title="${t.label}" style="color:${t.color};margin-right:4px;">
    <i class="fa ${t.icon}" style="font-size:10px;"></i>
  </span>`;
}
```

Injected into each email row's sender cell when the row's `message_id` has a matching task with a non-`none` triage_tag. The inbox render function fetches triage data via `GET /api/mail-tasks/by-message/:messageId` (already exists) or via a batch endpoint.

#### 4b. Task Edit Modal — `#task-modal-overlay`

Fields:
- Subject (text input, pre-filled from email)
- Assignee section: display of selected assignee name + "Change" button that opens the existing assignee picker
- Priority (select: low / normal / high / urgent)
- Due date/time (datetime-local input)
- Notify channel (radio: WA only / Email only / Both)
- Notify before (number input + unit select: minutes / hours / days — converts to minutes on submit)
- Notes (textarea)
- Triage tag (select: none / red / yellow / green)
- Status (select: open / in_progress / waiting / done / cancelled) — shown in edit mode only

Validation (client-side before submit):
- `due_at` must be a valid datetime (and ideally future, with a warning if past)
- At least one of `assigned_to` or `assigned_to_name` must be set

Functions:
- `openTaskModal(emailRow)` — create mode, pre-fills from email row data
- `openTaskEditModal(task)` — edit mode, pre-fills all fields from task object
- `closeTaskModal()`
- `submitTaskModal()` — POST or PATCH, closes on success, shows inline error on failure

#### 4c. Follow-Up Panel — `#followup-panel`

A slide-in panel (same pattern as other panels in the dashboard) triggered by a "Follow-Up" button in the Outlook section toolbar.

On open: fetches `GET /api/mail-tasks/?panel=1` (triage-ordered open tasks).

Each row shows:
- Triage badge
- Subject (truncated)
- Assignee name
- Due date/time (highlighted red + "Overdue" label if `due_at < now` and `replied_at` is null)
- Priority badge
- Status badge
- Actions: "Mark Replied" | "Resolve" | "Edit"

Action handlers:
- **Mark Replied**: `PATCH /api/mail-tasks/:id` with `{ replied_at: 'now' }` → refreshes list
- **Resolve**: `PATCH /api/mail-tasks/:id` with `{ status: 'done' }` → refreshes list
- **Edit**: calls `openTaskEditModal(task)`

Empty state: "No open follow-up tasks" message.

---

## Data Models

### `mail_reply_tasks` — full schema after migration

```sql
CREATE TABLE mail_reply_tasks (
  id                    SERIAL PRIMARY KEY,
  message_id            TEXT NOT NULL,
  conversation_id       TEXT,
  subject               TEXT,
  sender_name           TEXT,
  sender_email          TEXT,
  preview               TEXT,
  importance            VARCHAR(20)  DEFAULT 'normal',
  priority              VARCHAR(20)  DEFAULT 'normal',   -- low/normal/high/urgent
  status                VARCHAR(30)  DEFAULT 'open',     -- open/in_progress/waiting/done/cancelled
  assigned_to           INT REFERENCES users(id) ON DELETE SET NULL,
  assigned_by           INT REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_name      TEXT,                            -- NEW: denormalized for non-system assignees
  assigned_to_email     VARCHAR(200),                    -- NEW: for email notifications
  assigned_to_phone     VARCHAR(30),                     -- NEW: for WA notifications
  notify_channel        VARCHAR(10)  DEFAULT 'wa',       -- NEW: wa/email/both
  notify_before_minutes INT          DEFAULT 60,         -- NEW: lead time in minutes
  triage_tag            VARCHAR(10)  DEFAULT 'none',     -- NEW: red/yellow/green/none
  replied_at            TIMESTAMPTZ,                     -- NEW: when marked as replied
  notified_at           TIMESTAMPTZ,                     -- NEW: when scheduler sent notification
  due_at                TIMESTAMPTZ,
  notes                 TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ
);
```

### Triage Tag Derivation Rules

```
status ∈ {done, cancelled}                                    → triage_tag = 'green'
replied_at IS NOT NULL                                        → triage_tag = 'yellow'
status ∈ {open, in_progress} AND due_at < NOW() AND replied_at IS NULL → triage_tag = 'red'
otherwise                                                     → preserve manual value (default 'none')
```

These rules are applied server-side in `deriveTriageTag()` on every POST and PATCH, ensuring the tag is always consistent with the task state.

### Notification Eligibility Criteria

A task is eligible for notification when ALL of the following hold:
1. `status IN ('open', 'in_progress')`
2. `due_at IS NOT NULL`
3. `notify_channel IS NOT NULL AND notify_channel != 'none'`
4. `notified_at IS NULL` (not yet notified)
5. `NOW() >= due_at - (notify_before_minutes * INTERVAL '1 minute')` (within the window)
6. `NOW() < due_at` (not yet overdue — notification is a reminder, not a late alert)

### Phone → JID Conversion

For WA notifications, `assigned_to_phone` is converted to a WhatsApp JID:
- Strip all non-digit characters
- If the number starts with `0`, replace with `91` (Indian local format)
- If the number does not start with a country code (length < 11), prepend `91`
- Append `@s.whatsapp.net`

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Task list ordering invariant

*For any* collection of tasks with varying priorities and `due_at` values, the list returned by `GET /api/mail-tasks/` must be ordered such that for every adjacent pair (task[i], task[i+1]): the priority rank of task[i] is ≤ the priority rank of task[i+1], and when priorities are equal, `due_at` of task[i] is ≤ `due_at` of task[i+1].

**Validates: Requirements 1.2**

### Property 2: Priority normalization

*For any* string value that is not one of `low`, `normal`, `high`, or `urgent`, creating or updating a task with that priority value must result in the stored priority being `normal`.

**Validates: Requirements 1.8**

### Property 3: Status normalization

*For any* string value that is not one of `open`, `in_progress`, `waiting`, `done`, or `cancelled`, creating or updating a task with that status value must result in the stored status being `open`.

**Validates: Requirements 1.9**

### Property 4: completed_at lifecycle round-trip

*For any* task, setting `status = 'done'` must result in `completed_at` being a non-null recent timestamp, and subsequently setting `status` to any value other than `done` must result in `completed_at` being `NULL`.

**Validates: Requirements 1.6, 1.7**

### Property 5: Assignee contact fields round-trip

*For any* combination of `assigned_to_email` and `assigned_to_phone` values, creating a task with those values and then fetching the task must return the same values unchanged.

**Validates: Requirements 2.1, 2.3, 2.6**

### Property 6: notify_channel normalization

*For any* string value that is not one of `wa`, `email`, or `both`, creating or updating a task with that `notify_channel` value must result in the stored value being `wa`.

**Validates: Requirements 2.2**

### Property 7: triage_tag normalization

*For any* string value that is not one of `red`, `yellow`, `green`, or `none`, creating or updating a task with that `triage_tag` value must result in the stored value being `none`.

**Validates: Requirements 2.5**

### Property 8: Triage derivation — done/cancelled → green

*For any* task, patching `status` to `done` or `cancelled` must result in `triage_tag` being `green` in the returned record, regardless of the task's previous triage_tag value.

**Validates: Requirements 5.2**

### Property 9: Triage derivation — replied_at → yellow

*For any* task that is not in `done` or `cancelled` status, patching `replied_at` to a non-null timestamp must result in `triage_tag` being `yellow` in the returned record.

**Validates: Requirements 5.3**

### Property 10: Notification eligibility — window check

*For any* task with `status ∈ {open, in_progress}`, non-null `due_at`, non-null `notify_channel`, and `notified_at = NULL`: the `shouldNotify(task, now)` function must return `true` if and only if `now >= due_at - notify_before_minutes minutes` AND `now < due_at`.

**Validates: Requirements 4.2**

### Property 11: Notification idempotence

*For any* task where `notified_at` is non-null, the `shouldNotify(task, now)` function must return `false` regardless of the current time or any other task field values.

**Validates: Requirements 4.3, 4.8**

### Property 12: Non-existent task returns 404

*For any* integer ID that does not correspond to an existing task record, both `PATCH /api/mail-tasks/:id` and `DELETE /api/mail-tasks/:id` must return HTTP 404 with a non-empty `error` field.

**Validates: Requirements 1.5**

---

## Error Handling

| Scenario | Backend response | Frontend behaviour |
|---|---|---|
| `message_id` missing on POST | 400 `{ error: 'message_id is required' }` | Inline validation before submit |
| No assignee on POST | 400 `{ error: 'assigned_to or assigned_to_name is required' }` | Inline validation before submit |
| Task not found on PATCH/DELETE | 404 `{ error: 'Task not found' }` | Toast error via `notify()` |
| Invalid triage_tag on PATCH triage | 400 `{ error: 'Invalid triage_tag' }` | Toast error |
| WA not connected during notification | No send; `activityLog.append` with type `error` | No frontend impact (background) |
| Graph API error during email notification | No send; `activityLog.append` with type `error` | No frontend impact (background) |
| DB error in scheduler tick | Caught; `console.error` + `activityLog.append` | No frontend impact |
| `due_at` in the past on create (client) | Warning shown but not blocked | Inline warning in modal |
| API call fails in modal | Modal stays open; error shown inline | Inline `#task-modal-error` div |

The scheduler wraps every tick in a `try/catch` and wraps each individual task's notification in its own `try/catch`, so a failure on one task never prevents other tasks from being processed in the same tick.

---

## Testing Strategy

### Unit Tests

Focus on the pure logic functions that are easiest to test in isolation:

- `normalizePriority(value)` — valid values pass through, invalid → `'normal'`
- `normalizeStatus(value)` — valid values pass through, invalid → `'open'`
- `normalizeNotifyChannel(value)` — valid values pass through, invalid → `'wa'`
- `normalizeTriageTag(value)` — valid values pass through, invalid → `'none'`
- `deriveTriageTag(status, dueAt, repliedAt, manualTag)` — all four derivation branches
- `shouldNotify(task, now)` — window boundary conditions (at boundary, just inside, just outside)
- `phoneToJid(phone)` — Indian local format, E.164 format, already-formatted numbers
- `buildWaMessage(task)` — message contains subject, due time, sender name
- Task list ordering — given an array of tasks, verify sort comparator produces correct order

### Property-Based Tests

Use a property-based testing library (e.g., [fast-check](https://github.com/dubzzz/fast-check) for Node.js) with a minimum of 100 iterations per property.

Each test is tagged with a comment referencing the design property:
```js
// Feature: task-notification-followup, Property N: <property text>
```

**Properties to implement as PBT:**

- **Property 2** — Generate arbitrary strings, verify `normalizePriority` returns `'normal'` for any non-valid input.
- **Property 3** — Generate arbitrary strings, verify `normalizeStatus` returns `'open'` for any non-valid input.
- **Property 6** — Generate arbitrary strings, verify `normalizeNotifyChannel` returns `'wa'` for any non-valid input.
- **Property 7** — Generate arbitrary strings, verify `normalizeTriageTag` returns `'none'` for any non-valid input.
- **Property 4** — Generate arbitrary task objects, verify `deriveTriageTag('done', ...)` always returns `'green'`, and `deriveTriageTag(nonDoneStatus, ...)` with no `repliedAt` and non-overdue `dueAt` returns the manual tag.
- **Property 8** — Generate arbitrary (status, dueAt, repliedAt, manualTag) tuples where status ∈ {done, cancelled}, verify `deriveTriageTag` returns `'green'`.
- **Property 9** — Generate arbitrary tuples where status ∉ {done, cancelled} and repliedAt is non-null, verify `deriveTriageTag` returns `'yellow'`.
- **Property 10** — Generate arbitrary (task, now) pairs, verify `shouldNotify` returns true iff the window condition holds.
- **Property 11** — Generate arbitrary tasks with `notified_at` set to any non-null value, verify `shouldNotify` always returns false.
- **Property 1** — Generate random arrays of task objects, sort them using the same comparator as the route, verify the ordering invariant holds for every adjacent pair.

### Integration Tests

- POST → GET round-trip: create a task, fetch it by ID, verify all fields match.
- PATCH status=done: verify `completed_at` is set and `triage_tag` is `'green'`.
- PATCH status=open after done: verify `completed_at` is NULL.
- DELETE: verify 200 `{ ok: true }` and subsequent GET returns 404.
- Scheduler tick with a mock DB: verify eligible tasks are dispatched and `notified_at` is set.
- Scheduler tick with `notified_at` already set: verify no second dispatch.

### Smoke Tests

- Verify the cron expression `*/30 * * * * *` fires at ≤60s intervals.
- Verify `taskNotifier.start()` does not throw on startup.
- Verify migration script is idempotent (run twice, no error).

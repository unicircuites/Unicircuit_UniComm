# Implementation Plan: Task Notification & Follow-Up

## Overview

Extend the existing `mail_reply_tasks` backend and `dashboard.html` frontend with new columns, a notification scheduler, triage tag logic, a follow-up control panel, and a full task edit/create modal. All work builds incrementally on the existing `backend/routes/mailTasks.js` and `dashboard.html` patterns.

## Tasks

- [x] 1. DB migration — add new columns to `mail_reply_tasks`
  - Create `backend/db/migrations/add_task_notification_fields.js`
  - Use `ADD COLUMN IF NOT EXISTS` for all eight new columns: `assigned_to_name`, `assigned_to_email`, `assigned_to_phone`, `notify_channel`, `notify_before_minutes`, `triage_tag`, `replied_at`, `notified_at`
  - Add defaults: `notify_channel DEFAULT 'wa'`, `notify_before_minutes DEFAULT 60`, `triage_tag DEFAULT 'none'`
  - Script must be idempotent (safe to run twice)
  - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 4.3_

- [x] 2. Extend `backend/routes/mailTasks.js` — normalizers and triage logic
  - [x] 2.1 Add `normalizeNotifyChannel(value)` and `normalizeTriageTag(value)` helper functions
    - `normalizeNotifyChannel`: valid values `wa`, `email`, `both`; default `wa`
    - `normalizeTriageTag`: valid values `red`, `yellow`, `green`, `none`; default `none`
    - _Requirements: 2.2, 2.5_

  - [ ]* 2.2 Write property tests for `normalizeNotifyChannel` and `normalizeTriageTag`
    - **Property 6: notify_channel normalization** — arbitrary strings not in `{wa, email, both}` must return `'wa'`
    - **Property 7: triage_tag normalization** — arbitrary strings not in `{red, yellow, green, none}` must return `'none'`
    - **Validates: Requirements 2.2, 2.5**
    - Use `fast-check`; place in `backend/tests/normalizers.test.js`

  - [x] 2.3 Add `deriveTriageTag(status, dueAt, repliedAt, manualTag)` pure helper function
    - Encode all four derivation branches from the design: done/cancelled → green, repliedAt non-null → yellow, open/in_progress + overdue + no reply → red, otherwise → manualTag
    - _Requirements: 5.2, 5.3, 5.4_

  - [ ]* 2.4 Write property tests for `deriveTriageTag`
    - **Property 4: completed_at lifecycle** — `deriveTriageTag('done', ...)` always returns `'green'`
    - **Property 8: done/cancelled → green** — any status ∈ {done, cancelled} always returns `'green'`
    - **Property 9: replied_at → yellow** — status ∉ {done, cancelled} with non-null repliedAt always returns `'yellow'`
    - **Validates: Requirements 5.2, 5.3, 1.6, 1.7**
    - Use `fast-check`; place in `backend/tests/deriveTriageTag.test.js`

  - [ ]* 2.5 Write property tests for `normalizePriority` and `normalizeStatus`
    - **Property 2: priority normalization** — arbitrary non-valid strings must return `'normal'`
    - **Property 3: status normalization** — arbitrary non-valid strings must return `'open'`
    - **Validates: Requirements 1.8, 1.9**
    - Use `fast-check`; place in `backend/tests/normalizers.test.js`

- [x] 3. Update `taskSelectSql()` and POST/PATCH routes to handle new fields
  - [x] 3.1 Update `taskSelectSql()` to use `COALESCE(t.assigned_to_name, assignee.name)` and `COALESCE(t.assigned_to_email, assignee.email)`
    - Ensures system-user tasks continue to resolve names via JOIN while non-system assignees use stored values
    - _Requirements: 2.1, 2.4_

  - [x] 3.2 Update `POST /api/mail-tasks/` to accept and persist all new fields
    - Accept `assigned_to_name`, `assigned_to_email`, `assigned_to_phone`, `notify_channel`, `notify_before_minutes`, `triage_tag`, `replied_at`
    - Change `assigned_to` to optional; validate that at least one of `assigned_to` or `assigned_to_name` is present
    - Apply `normalizeNotifyChannel`, `normalizeTriageTag`, and `deriveTriageTag` before INSERT
    - _Requirements: 1.1, 2.1, 2.2, 2.3, 2.4, 2.5, 5.2, 5.3, 5.4_

  - [x] 3.3 Update `PATCH /api/mail-tasks/:id` to accept and persist all new fields
    - Accept all new fields; handle `replied_at: 'now'` → `NOW()`
    - Apply `deriveTriageTag` after resolving new status/replied_at values
    - Preserve `completed_at` lifecycle (set on done, clear on non-done)
    - _Requirements: 1.3, 1.6, 1.7, 2.1, 2.2, 2.3, 2.5, 2.6, 5.2, 5.3, 5.4_

  - [x] 3.4 Add `PATCH /api/mail-tasks/:id/triage` convenience endpoint
    - Accept `{ triage_tag }` only; validate against allowed values; return 400 with descriptive error for invalid values
    - Return updated task on success; 404 if task not found
    - _Requirements: 5.5, 1.5_

  - [x] 3.5 Add `?panel=1` filter to `GET /api/mail-tasks/`
    - When `panel=1`, filter to `status IN ('open','in_progress','waiting')` and order by triage severity (red → yellow → green/none) then `due_at ASC`
    - _Requirements: 6.1_

  - [ ]* 3.6 Write property tests for task list ordering
    - **Property 1: task list ordering invariant** — for any random array of tasks, the sort comparator must produce an order where priority rank is non-decreasing and due_at is non-decreasing within equal priorities
    - **Validates: Requirements 1.2**
    - Use `fast-check`; place in `backend/tests/taskOrdering.test.js`

  - [ ]* 3.7 Write property tests for non-existent task 404 behaviour
    - **Property 12: non-existent task returns 404** — PATCH and DELETE with any integer ID not in the DB must return HTTP 404 with a non-empty `error` field
    - **Validates: Requirements 1.5**
    - Place in `backend/tests/mailTasks.integration.test.js`

- [ ] 4. Checkpoint — verify backend routes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Create `backend/services/taskNotifier.js` — notification scheduler
  - [x] 5.1 Implement `shouldNotify(task, now)` pure function
    - Returns `true` iff: `notified_at` is null, `status ∈ {open, in_progress}`, `due_at` is non-null, `notify_channel` is non-null and not `none`, `now >= due_at - notify_before_minutes minutes`, and `now < due_at`
    - _Requirements: 4.2, 4.3, 4.8_

  - [ ]* 5.2 Write property tests for `shouldNotify`
    - **Property 10: notification eligibility window check** — `shouldNotify` returns true iff the window condition holds for eligible tasks
    - **Property 11: notification idempotence** — any task with non-null `notified_at` must return false regardless of other fields
    - **Validates: Requirements 4.2, 4.3, 4.8**
    - Use `fast-check`; place in `backend/tests/taskNotifier.test.js`

  - [x] 5.3 Implement `phoneToJid(phone)` helper
    - Strip non-digits; handle Indian local format (leading `0` → `91`); prepend `91` if length < 11; append `@s.whatsapp.net`
    - _Requirements: 4.4_

  - [x] 5.4 Implement `buildWaMessage(task)` and `buildEmailPayload(task)` message builders
    - WA message: includes subject, due_at formatted as `DD MMM YYYY HH:mm`, sender_name, and notes if present
    - Email: subject `Task Reminder: {subject}`, HTML body with same fields
    - _Requirements: 4.4, 4.5_

  - [x] 5.5 Implement the cron tick — query eligible tasks and dispatch notifications
    - Use `node-cron` schedule `*/30 * * * * *`
    - Query DB for eligible tasks using the eligibility SQL from the design
    - For each eligible task: send WA via `require('./whatsapp').sendMessage(jid, text)` if channel is `wa` or `both` and phone is non-null; send email via `msGraph.graphPost` if channel is `email` or `both` and email is non-null
    - After successful send: `UPDATE mail_reply_tasks SET notified_at = NOW() WHERE id = $1`
    - Wrap each task's dispatch in its own `try/catch`; log failures via `activityLog.append` with type `error`; do not rethrow
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [x] 5.6 Export `start(pool)` and wire into `backend/server.js`
    - Call `taskNotifier.start(pool)` after pool is ready, following the same pattern as `marketingCron`
    - _Requirements: 8.1, 8.2, 8.3_

- [ ] 6. Checkpoint — verify scheduler
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Frontend — triage badge rendering in email inbox rows
  - [x] 7.1 Add `triageBadgeHtml(tag)` helper function in `dashboard.html`
    - Returns colored icon span for `red`, `yellow`, `green`; empty string for `none`
    - Use existing CSS variables `var(--red2)`, `var(--gold)`, `var(--green)` and Font Awesome icons
    - _Requirements: 5.1_

  - [x] 7.2 Inject triage badges into Outlook inbox email rows
    - After rendering the inbox list, fetch triage data for visible `message_id` values via `GET /api/mail-tasks/by-message/:messageId` (or batch if available)
    - Inject `triageBadgeHtml(tag)` into each row's sender cell
    - _Requirements: 5.1, 5.6_

- [x] 8. Frontend — Assignee Picker component
  - [x] 8.1 Build the four-tab assignee picker modal (`#assignee-picker-overlay`)
    - Tabs: System Users (`GET /api/mail-tasks/users`), Outlook Contacts (`GET /api/outlook/contacts`), WhatsApp Contacts (`GET /api/wa/chats` filtered to non-group), Contact Groups (`GET /api/groups`)
    - On contact select: populate `assigned_to_name`, `assigned_to_email`, `assigned_to_phone` in the parent task form; set `assigned_to` integer id for system users
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [x] 8.2 Add WA phone warning when no phone is available
    - If selected contact has no phone and `notify_channel` is `wa` or `both`, display inline warning: "WhatsApp notification requires a phone number"
    - _Requirements: 3.8_

- [x] 9. Frontend — Task Edit/Create Modal (`#task-modal-overlay`)
  - [x] 9.1 Build the modal HTML structure and CSS
    - Fields: subject, assignee display + "Change" button, priority select, due datetime-local, notify channel radio, notify-before number + unit select (minutes/hours/days), notes textarea, triage tag select, status select (edit mode only)
    - Include `#task-modal-error` div for inline API errors
    - _Requirements: 7.1, 7.2, 7.3_

  - [x] 9.2 Implement `openTaskModal(emailRow)` — create mode
    - Pre-fill `message_id`, subject, sender_name, sender_email from the email row data
    - _Requirements: 7.1_

  - [x] 9.3 Implement `openTaskEditModal(task)` — edit mode
    - Pre-fill all fields from the task object including status select
    - Convert `notify_before_minutes` back to the appropriate unit for display
    - _Requirements: 7.2_

  - [x] 9.4 Implement `submitTaskModal()` — form submission
    - Convert notify-before value to minutes based on selected unit
    - Client-side validation: `due_at` must be present (warn if past), assignee must be selected
    - POST for new tasks, PATCH for edits; close modal on success; show inline error on failure
    - _Requirements: 7.4, 7.5, 7.6, 7.7_

  - [x] 9.5 Wire "Create Task" button onto each email row in the inbox list
    - Pass email row data to `openTaskModal(emailRow)` on click
    - _Requirements: 7.1_

- [x] 10. Frontend — Follow-Up Control Panel (`#followup-panel`)
  - [x] 10.1 Build the panel HTML structure and CSS
    - Slide-in panel triggered by a "Follow-Up" button in the Outlook section toolbar
    - Each task row: triage badge, subject, assignee name, due date/time, priority badge, status badge, action buttons (Mark Replied / Resolve / Edit)
    - Overdue rows: red highlight + "Overdue" label when `due_at < now` and `replied_at` is null
    - Empty state message: "No open follow-up tasks"
    - _Requirements: 6.1, 6.2, 6.6, 6.7_

  - [x] 10.2 Implement panel open/load logic
    - On open: fetch `GET /api/mail-tasks/?panel=1` and render task rows
    - _Requirements: 6.1_

  - [x] 10.3 Implement action handlers
    - "Mark Replied": `PATCH /api/mail-tasks/:id` with `{ replied_at: 'now' }` → refresh list
    - "Resolve": `PATCH /api/mail-tasks/:id` with `{ status: 'done' }` → refresh list
    - "Edit": call `openTaskEditModal(task)`
    - Refresh list after each action without full page reload
    - _Requirements: 6.3, 6.4, 6.5, 6.8_

- [x] 11. Final checkpoint — end-to-end verification
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Run the DB migration script once before starting the server: `node backend/db/migrations/add_task_notification_fields.js`
- The `taskNotifier` service requires the WhatsApp service to be connected for WA notifications; failures are logged silently
- Property tests use `fast-check` — install with `npm install --save-dev fast-check` in the `backend` directory if not already present
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation

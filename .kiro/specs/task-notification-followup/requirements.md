# Requirements Document

## Introduction

This feature extends the UniComm Pro dashboard with full task lifecycle management for Outlook email reply tasks, automated WhatsApp and email reminder notifications, and a triage tagging system that gives operators a visual at-a-glance status for every email thread. The work builds on the existing `mail_reply_tasks` table and routes in the Node.js/Express backend and the single-page `dashboard.html` frontend.

## Glossary

- **Task**: A `mail_reply_tasks` record linked to an Outlook email message, representing a follow-up action assigned to a person.
- **Assignee**: The person responsible for completing a task. May be a system user, an Outlook contact, a WhatsApp contact, or a member of a contact group.
- **Triage_Tag**: A colored status indicator (red / yellow / green / none) stored on a task and displayed on the email list row.
- **Notification_Scheduler**: The background service (node-cron) that fires WhatsApp and/or email reminders at the configured time before a task's due date.
- **Reminder_Window**: The configurable lead time (in minutes) before `due_at` at which a reminder is sent.
- **WA_Service**: The existing Baileys-based WhatsApp service accessible via `POST /api/wa/send`.
- **Graph_Service**: The existing Microsoft Graph service used to send Outlook emails via `backend/services/msGraph.js`.
- **Follow_Up_Panel**: A dedicated UI panel listing all open tasks with their triage status and quick-action controls.
- **System_User**: A user record in the `users` table.
- **Outlook_Contact**: A contact retrieved from the Microsoft Graph contacts endpoint.
- **WA_Contact**: A contact stored in the `wa_contacts` / `wa_chats` tables.
- **Contact_Group**: A recipient group stored in the existing `recipient_groups` table.

---

## Requirements

### Requirement 1: Full Task CRUD

**User Story:** As a dashboard operator, I want to create, view, edit, and delete reply tasks so that I can manage the full lifecycle of email follow-up actions.

#### Acceptance Criteria

1. WHEN a user submits a new task form with a valid `message_id`, assignee, and `due_at`, THE Task_Manager SHALL create a new task record and return it with HTTP 201.
2. WHEN a user requests the task list, THE Task_Manager SHALL return all tasks ordered by priority (urgent → high → normal → low) then by `due_at` ascending.
3. WHEN a user submits an edit form for an existing task, THE Task_Manager SHALL update all provided fields (subject, assignee details, priority, due_at, notes, status, notify_channel, notify_before_minutes) and return the updated record.
4. WHEN a user deletes a task by its id, THE Task_Manager SHALL remove the record and return HTTP 200 with `{ ok: true }`.
5. IF a task id does not exist during update or delete, THEN THE Task_Manager SHALL return HTTP 404 with a descriptive error message.
6. WHEN a task's status is set to `done`, THE Task_Manager SHALL record `completed_at` as the current timestamp.
7. WHEN a task's status is changed away from `done`, THE Task_Manager SHALL clear `completed_at` to NULL.
8. THE Task_Manager SHALL accept `priority` values of `low`, `normal`, `high`, or `urgent` only, and SHALL default to `normal` for any unrecognised value.
9. THE Task_Manager SHALL accept `status` values of `open`, `in_progress`, `waiting`, `done`, or `cancelled` only, and SHALL default to `open` for any unrecognised value.

---

### Requirement 2: Extended Task Fields

**User Story:** As a dashboard operator, I want to store the assignee's email address and WhatsApp phone number on a task so that the system can send notifications without additional lookups.

#### Acceptance Criteria

1. THE Task_Manager SHALL store `assigned_to_email` (VARCHAR 200) and `assigned_to_phone` (VARCHAR 30) on every task record.
2. THE Task_Manager SHALL store `notify_channel` with allowed values `wa`, `email`, or `both`, defaulting to `wa`.
3. THE Task_Manager SHALL store `notify_before_minutes` (INTEGER) representing the lead time before `due_at` at which a reminder is sent, defaulting to 60.
4. WHEN a task is created or updated with an assignee selected from the assignee picker, THE Task_Manager SHALL populate `assigned_to_email` and `assigned_to_phone` from the selected contact's data.
5. THE Task_Manager SHALL store `triage_tag` with allowed values `red`, `yellow`, `green`, or `none`, defaulting to `none`.
6. THE Task_Manager SHALL store `replied_at` (TIMESTAMPTZ) recording when the task was marked as replied.

---

### Requirement 3: Assignee Picker

**User Story:** As a dashboard operator, I want to pick a task assignee from system users, Outlook contacts, WhatsApp contacts, or contact groups so that I can assign tasks to any person in the system.

#### Acceptance Criteria

1. WHEN the assignee picker is opened, THE Assignee_Picker SHALL display four tabs: System Users, Outlook Contacts, WhatsApp Contacts, and Contact Groups.
2. WHEN the System Users tab is active, THE Assignee_Picker SHALL fetch and display all active users from `GET /api/mail-tasks/users`.
3. WHEN the Outlook Contacts tab is active, THE Assignee_Picker SHALL fetch and display contacts from `GET /api/outlook/contacts`.
4. WHEN the WhatsApp Contacts tab is active, THE Assignee_Picker SHALL fetch and display contacts from `GET /api/wa/chats` filtered to individual (non-group) chats.
5. WHEN the Contact Groups tab is active, THE Assignee_Picker SHALL fetch and display groups from `GET /api/groups`.
6. WHEN a contact is selected, THE Assignee_Picker SHALL populate the task form's `assigned_to_name`, `assigned_to_email`, and `assigned_to_phone` fields from the selected contact's data.
7. WHEN a system user is selected, THE Assignee_Picker SHALL set `assigned_to` (integer user id) in addition to name and email.
8. IF no phone number is available for the selected contact and `notify_channel` is `wa` or `both`, THEN THE Assignee_Picker SHALL display a warning that WhatsApp notification requires a phone number.

---

### Requirement 4: Notification Scheduler

**User Story:** As a dashboard operator, I want the system to automatically send WhatsApp and/or email reminders to the assignee before a task's due time so that no follow-up is missed.

#### Acceptance Criteria

1. THE Notification_Scheduler SHALL run on a recurring interval of no more than 60 seconds to check for tasks requiring notification.
2. WHEN a task has `status = 'open'` or `status = 'in_progress'`, a non-null `due_at`, a non-null `notify_channel` other than `none`, and the current time is within the `notify_before_minutes` window before `due_at`, THE Notification_Scheduler SHALL send the configured notification(s).
3. WHEN a notification has been sent for a task, THE Notification_Scheduler SHALL record `notified_at` on the task record to prevent duplicate sends.
4. IF `notify_channel` is `wa` or `both` and `assigned_to_phone` is non-null, THEN THE Notification_Scheduler SHALL send a WhatsApp message via `POST /api/wa/send` containing the task subject, due time, sender name, and notes.
5. IF `notify_channel` is `email` or `both` and `assigned_to_email` is non-null, THEN THE Notification_Scheduler SHALL send an Outlook email via the Graph_Service containing the task subject, due time, sender name, and notes.
6. IF the WhatsApp service is not connected when a WA notification is due, THEN THE Notification_Scheduler SHALL log the failure to the activity log and SHALL NOT retry automatically within the same scheduler tick.
7. IF the Graph_Service returns an error when sending an email notification, THEN THE Notification_Scheduler SHALL log the failure to the activity log and SHALL NOT throw an unhandled exception.
8. THE Notification_Scheduler SHALL only send a notification once per task (enforced by `notified_at` being non-null).

---

### Requirement 5: Triage Tags

**User Story:** As a dashboard operator, I want each email row in the inbox list to show a colored triage tag so that I can instantly see the follow-up status of every thread.

#### Acceptance Criteria

1. THE Triage_System SHALL display a colored dot/badge on each email row in the Outlook inbox list: red for urgent/overdue with no reply, yellow for replied but awaiting response, green for resolved/closed, and no badge when `triage_tag = 'none'`.
2. WHEN a task's status is set to `done` or `cancelled`, THE Triage_System SHALL automatically set `triage_tag` to `green`.
3. WHEN `replied_at` is set on a task (marking it as replied), THE Triage_System SHALL automatically set `triage_tag` to `yellow`.
4. WHEN a task has `status = 'open'` or `status = 'in_progress'` and `due_at` is in the past and `replied_at` is null, THE Triage_System SHALL set `triage_tag` to `red`.
5. THE Triage_System SHALL allow a user to manually set `triage_tag` to any allowed value via the task edit form or the Follow_Up_Panel.
6. WHEN the inbox list is rendered, THE Triage_System SHALL fetch triage tags for visible messages by matching `message_id` values against task records.
7. THE Triage_System SHALL store `triage_tag` in the `mail_reply_tasks` table and SHALL NOT require a separate table.

---

### Requirement 6: Follow-Up Control Panel

**User Story:** As a dashboard operator, I want a dedicated follow-up panel showing all open tasks with their triage status so that I can triage, update, and close tasks from a single view.

#### Acceptance Criteria

1. WHEN the Follow_Up_Panel is opened, THE Follow_Up_Panel SHALL fetch and display all tasks with `status` of `open`, `in_progress`, or `waiting`, ordered by triage severity (red first, then yellow, then green/none) then by `due_at` ascending.
2. WHEN a task row is displayed in the Follow_Up_Panel, THE Follow_Up_Panel SHALL show: triage tag badge, subject, assignee name, due date/time, priority badge, and status.
3. WHEN a user clicks "Mark Replied" on a task in the Follow_Up_Panel, THE Follow_Up_Panel SHALL set `replied_at` to the current timestamp and update `triage_tag` to `yellow`.
4. WHEN a user clicks "Resolve" on a task in the Follow_Up_Panel, THE Follow_Up_Panel SHALL set `status` to `done` and update `triage_tag` to `green`.
5. WHEN a user clicks "Edit" on a task in the Follow_Up_Panel, THE Follow_Up_Panel SHALL open the task edit modal pre-populated with the task's current data.
6. WHEN a task's `due_at` is in the past and `replied_at` is null, THE Follow_Up_Panel SHALL highlight the row with a red indicator and display an "Overdue" label.
7. WHEN the Follow_Up_Panel task list is empty, THE Follow_Up_Panel SHALL display a message indicating no open follow-up tasks exist.
8. WHEN a task action (mark replied, resolve) completes successfully, THE Follow_Up_Panel SHALL refresh the task list without a full page reload.

---

### Requirement 7: Task Edit Modal

**User Story:** As a dashboard operator, I want a modal dialog to create and edit tasks with all fields so that I can manage task details without leaving the inbox view.

#### Acceptance Criteria

1. WHEN the task create button is clicked on an email row, THE Task_Modal SHALL open pre-populated with the email's `message_id`, subject, sender name, and sender email.
2. WHEN the task edit button is clicked, THE Task_Modal SHALL open pre-populated with all existing task field values.
3. THE Task_Modal SHALL include fields for: subject, assignee (via Assignee_Picker), priority (dropdown: low/normal/high/urgent), due date and time (datetime-local input), notes (textarea), notification channel (radio: WA only / Email only / Both), notify before (number input + unit selector: minutes/hours/days), and triage tag (dropdown).
4. WHEN the user changes the "notify before" unit between minutes, hours, and days, THE Task_Modal SHALL convert and store the value as minutes in `notify_before_minutes`.
5. WHEN the task form is submitted with valid data, THE Task_Modal SHALL call the appropriate API endpoint (POST for new, PATCH for edit) and close on success.
6. IF the API call fails, THEN THE Task_Modal SHALL display the error message inline without closing the modal.
7. WHEN the task form is submitted, THE Task_Modal SHALL validate that `due_at` is a valid future datetime and that an assignee has been selected, and SHALL display inline validation errors for any missing required fields.

---

### Requirement 8: Scheduler Persistence

**User Story:** As a system operator, I want the notification scheduler to survive server restarts so that reminders are not lost when the server is restarted before a task's due time.

#### Acceptance Criteria

1. WHEN the server starts, THE Notification_Scheduler SHALL query the database for all tasks where `notified_at` is null, `status` is `open` or `in_progress`, and `due_at` is in the future, and SHALL schedule them for notification.
2. WHEN a new task is created or updated with a future `due_at` and a non-null `notify_channel`, THE Notification_Scheduler SHALL include it in the next scheduler tick without requiring a server restart.
3. THE Notification_Scheduler SHALL use the existing `node-cron` package already present in `backend/package.json`.

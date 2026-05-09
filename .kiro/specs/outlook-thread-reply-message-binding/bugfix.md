# Bugfix Requirements Document

## Introduction

The Outlook thread view's Reply / Reply All / Forward / Assign Task buttons are not strictly bound to individual messages within a thread. While the functions `openReplyFromThread(meta, replyAll)` and `forwardFromThread(meta)` receive message-specific metadata, the implementation may still rely on global state (`activeMailMessage`, `activeMessageId`, or thread-level data) instead of treating each message as a fully independent entity. This creates a risk where clicking a reply button on message C might inadvertently use data from message D or the thread root, violating the principle that each message card should be completely self-contained.

Additionally, there is a critical UX issue: Reply / Reply All / Forward / Assign Task buttons are currently visible even when the thread is in a collapsed state (no message expanded). This violates Outlook-style behavior where reply actions should only be visible when a specific message is expanded, and the buttons must be rendered inside the expanded message block, not in a global header toolbar. This creates ambiguous reply context where users cannot clearly identify which message they are replying to.

The expected behavior is true Outlook-style per-message actions: when a user clicks Reply on a specific message in a thread, the system must use ONLY that message's sender, recipients, subject, and body—with zero fallback to any global or thread-level state. Furthermore, reply buttons must only appear when a message is actively expanded, and must be visually contained within that expanded message.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a user clicks Reply on message C in a thread containing messages A, B, C, D THEN the system may use `activeMailMessage` or thread-level data instead of strictly using message C's metadata

1.2 WHEN `openReplyFromThread(meta, replyAll)` is called THEN the system sets `activeMessageId = meta.id` which creates global state coupling

1.3 WHEN `forwardFromThread(meta)` is called THEN the system sets `activeMessageId = meta.id` which creates global state coupling

1.4 WHEN reply functions execute THEN they may fallback to `activeMailMessage` if metadata is incomplete or missing

1.5 WHEN multiple messages in a thread have reply buttons THEN clicking different buttons in sequence may reuse previous message state due to global variable persistence

1.6 WHEN a thread is in collapsed state (no message expanded) THEN Reply/Reply All/Forward/Assign Task buttons are still visible in the header toolbar

1.7 WHEN buttons are rendered in the header toolbar THEN they create ambiguous reply context (unclear which message will be replied to)

1.8 WHEN a user sees reply buttons without an expanded message THEN the system allows global/thread-level reply behavior instead of message-specific behavior

1.9 WHEN the thread view is rendered THEN Reply/Reply All/Assign Task/AI Draft buttons are placed in the email header (`<div class="card-header">`) with IDs `#btn-reply`, `#btn-reply-all`, `#btn-assign-reply`, `#btn-ai-reply` instead of inside each message's `<div class="thread-msg-header">` container

1.10 WHEN buttons are in `.card-header` or near the subject THEN they are not tied to any specific message in the thread

1.11 WHEN header buttons are clicked THEN they may use global functions like `openReply()` instead of message-specific functions

1.12 WHEN buttons are rendered THEN they may be incorrectly placed near the subject line or in a global toolbar instead of being inside the `<div class="thread-msg-header">` container aligned with avatar/sender/email/timestamp

### Expected Behavior (Correct)

2.1 WHEN a user clicks Reply on message C in a thread THEN the system SHALL use ONLY message C's `fromAddr` as the recipient with no fallback to `activeMailMessage` or thread root

2.2 WHEN a user clicks Reply All on message C in a thread THEN the system SHALL use ONLY message C's `toRecipients` and `ccRecipients` with no fallback to global state

2.3 WHEN a user clicks Forward on message C in a thread THEN the system SHALL use ONLY message C's `subject` and `bodyPreview` with no fallback to global state

2.4 WHEN `openReplyFromThread(meta, replyAll)` is called THEN the system SHALL NOT set or rely on `activeMessageId` for recipient resolution

2.5 WHEN `forwardFromThread(meta)` is called THEN the system SHALL NOT set or rely on `activeMessageId` for content resolution

2.6 WHEN metadata passed to reply functions is incomplete (missing `fromAddr`, `toRecipients`, `ccRecipients`, `subject`, or `bodyPreview`) THEN the system SHALL log an error and display a user-facing message instead of silently falling back to global state

2.7 WHEN the compose modal opens from a thread reply action THEN all fields (To, CC, Subject, Body) SHALL be populated exclusively from the `meta` parameter passed to the function

2.8 WHEN a thread is in collapsed state (no message expanded) THEN Reply/Reply All/Forward/Assign Task buttons SHALL NOT be visible

2.9 WHEN a user expands a specific message in a thread THEN Reply/Reply All/Forward/Assign Task buttons SHALL be rendered INSIDE that expanded message block only

2.10 WHEN buttons are rendered THEN they SHALL be visually contained within the expanded message, not in the header toolbar

2.11 WHEN no message is expanded THEN the system SHALL track state with `isThreadExpanded=false` and `activeMessage=null`

2.12 WHEN a message is expanded THEN the system SHALL track state with `isThreadExpanded=true` and `activeMessage={message object}`

2.13 WHEN rendering the UI THEN the system SHALL hide all reply/action buttons if `activeMessage` is null

2.14 WHEN rendering the UI THEN the system SHALL show reply/action buttons inside the expanded message block if `activeMessage` exists

2.15 WHEN the thread view is rendered THEN buttons `#btn-reply`, `#btn-reply-all`, `#btn-assign-reply`, `#btn-ai-reply` SHALL be completely removed or hidden from `<div class="card-header">` and SHALL NEVER be used

2.16 WHEN each message in the thread is rendered THEN Reply/Reply All/Assign Task buttons SHALL be injected inside that message's `<div class="thread-msg-header">` container, aligned horizontally on the right side within the same row as avatar/sender/email/timestamp

2.17 WHEN message-level buttons are rendered THEN they SHALL use `onclick="openReplyFromThread(meta,false)"` for Reply, `onclick="openReplyFromThread(meta,true)"` for Reply All, and `onclick="openTaskModalFromThread(meta)"` for Assign Task

2.18 WHEN message-level buttons are rendered THEN each button SHALL be bound to that specific message's `meta` object containing `fromAddr`, `toRecipients`, `ccRecipients`, `subject`, `bodyPreview`, and `id`

2.19 WHEN message-level buttons are clicked THEN they SHALL NOT use global functions like `openReply()` or rely on `activeMailMessage`

2.20 WHEN the UI is rendered THEN the visual layout SHALL show buttons beside the email/sender (same row), NOT above the thread in the header

2.21 WHEN buttons are rendered THEN they SHALL be DOM siblings of the sender name, email address, and timestamp elements within the sender row container

2.22 WHEN buttons are rendered THEN they SHALL NOT be placed near or attached to the subject line or subject area

2.23 WHEN the visual layout is rendered THEN each message block SHALL show the structure: [Avatar] Sender Email [Buttons] on the first line, with To/CC and message body on subsequent lines

2.24 WHEN buttons are rendered THEN they SHALL be placed inside a `<div class="msg-actions">` container within the `thread-msg-header` element

2.25 WHEN the `thread-msg-header` is styled THEN it SHALL use `display:flex` and `justify-content: space-between` to align buttons to the right side

2.26 WHEN buttons are rendered THEN they SHALL NOT be placed inside `<div class="card-header">` or any global header container

2.27 WHEN the thread view is rendered THEN `thread-msg-header` is the ONLY valid location for per-message action buttons

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a user clicks Reply from the single email view (non-thread) THEN the system SHALL CONTINUE TO use the existing `replyToEmail()` function with `activeMailMessage`

3.2 WHEN a user opens an email from the inbox list THEN the system SHALL CONTINUE TO set `activeMailMessage` for single-view operations

3.3 WHEN a user creates a task from an email THEN the system SHALL CONTINUE TO use `activeMailMessage` for task metadata

3.4 WHEN a user sends a reply THEN the system SHALL CONTINUE TO mark related tasks as done using `activeMessageId` and `activeMailMessage.conversationId`

3.5 WHEN the compose modal opens THEN the system SHALL CONTINUE TO apply default signatures, load templates, and load group dropdowns

3.6 WHEN a reply is sent THEN the system SHALL CONTINUE TO use the correct conversation threading behavior

3.7 WHEN thread messages are rendered THEN the system SHALL CONTINUE TO display To/CC recipients, timestamps, and message previews correctly

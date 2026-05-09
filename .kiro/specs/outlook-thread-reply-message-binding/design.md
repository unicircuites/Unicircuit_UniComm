# Outlook Thread Reply Message Binding Bugfix Design

## Overview

The Outlook thread view currently has two critical issues:

1. **Global State Contamination**: The functions `openReplyFromThread(meta, replyAll)` and `forwardFromThread(meta)` set `activeMessageId = meta.id` at the start of execution, creating global state coupling. While these functions receive message-specific metadata and use it for most operations, this global state assignment creates a risk where subsequent operations or error conditions might inadvertently reference the wrong message.

2. **Incorrect Button Placement**: Reply/Reply All/Forward/Assign Task buttons are currently rendered in TWO locations:
   - **Global header buttons** (lines 1425-1429): `#btn-reply`, `#btn-reply-all`, `#btn-assign-reply`, `#btn-ai-reply` in `.card-header` that use `openReply()` and rely on `activeMailMessage` global state
   - **Per-message buttons** (lines 7995-7999): Correctly placed at the bottom of each expanded message in `thread-msg-body`, using `openReplyFromThread(meta)` with message-specific metadata

The global header buttons violate Outlook-style behavior where reply actions should only be visible when a specific message is expanded, and must be visually bound to that message. Currently, these header buttons are shown even when the thread is collapsed, creating ambiguous reply context.

The fix requires:
1. Eliminating the `activeMessageId` assignment in thread reply functions
2. Completely removing or permanently hiding the global header buttons for thread view
3. Ensuring per-message buttons in `thread-msg-header` are the ONLY visible reply mechanism
4. Moving per-message buttons from `thread-msg-body` (bottom of message) to `thread-msg-header` (aligned with sender row)

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug - when thread reply functions set global state (`activeMessageId`) or when global header buttons are visible/used in thread view
- **Property (P)**: The desired behavior - thread reply functions use ONLY the `meta` parameter with no global state assignment, and reply buttons appear ONLY in the `thread-msg-header` aligned with the sender row
- **Preservation**: Existing single-email-view behavior (non-thread) that must remain unchanged, including `openReply()`, `activeMailMessage`, and global header buttons for single view
- **openReplyFromThread(meta, replyAll)**: Function in `dashboard.html` (line 8064) that handles Reply/Reply All from thread view
- **forwardFromThread(meta)**: Function in `dashboard.html` (line 8151) that handles Forward from thread view
- **activeMessageId**: Global variable (line 5656) that stores the currently active message ID
- **activeMailMessage**: Global variable (line 5656) that stores the full message object for single-view operations
- **thread-msg-header**: The div container (line 7976) that displays sender info, avatar, timestamp, and chevron for each message in a thread
- **thread-msg-body**: The div container (line 7990) that displays the expanded message content and currently contains per-message action buttons
- **card-header**: The div container (line 1423) that contains the email subject and global action buttons
- **meta**: The message metadata object containing `{ id, subject, fromAddr, fromName, toRecipients[], ccRecipients[], receivedDateTime, bodyPreview }`

## Bug Details

### Bug Condition

The bug manifests in two distinct scenarios:

**Scenario 1: Global State Contamination**
When a user clicks Reply/Reply All/Forward on a message in a thread, the functions `openReplyFromThread(meta, replyAll)` or `forwardFromThread(meta)` are called. These functions receive complete message-specific metadata but immediately set `activeMessageId = meta.id` (lines 8069 and 8154), creating global state coupling that violates the principle of message-specific binding.

**Scenario 2: Incorrect Button Placement**
When the thread view is rendered, global header buttons (`#btn-reply`, `#btn-reply-all`, `#btn-assign-reply`, `#btn-ai-reply`) in `.card-header` are shown (line 8313-8316), and per-message buttons are placed at the bottom of each expanded message in `thread-msg-body` instead of in the `thread-msg-header` aligned with the sender row.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { action: string, context: string, location: string }
  OUTPUT: boolean
  
  RETURN (input.action IN ['openReplyFromThread', 'forwardFromThread']
         AND input.context === 'thread-view'
         AND globalStateAssignment(activeMessageId) === true)
         OR
         (input.context === 'thread-view'
         AND (headerButtonsVisible() === true
              OR buttonLocation !== 'thread-msg-header'))
END FUNCTION
```

### Examples

**Example 1: Global State Assignment**
- **Current behavior**: User clicks Reply on message C → `openReplyFromThread(metaC, false)` called → Line 8069 executes `activeMessageId = metaC.id` → Global state is set
- **Expected behavior**: User clicks Reply on message C → `openReplyFromThread(metaC, false)` called → No global state assignment → Function uses ONLY `metaC` parameter

**Example 2: Header Buttons Visible in Thread View**
- **Current behavior**: Thread view loads → `renderThreadView()` called → Line 8313-8316 shows `#btn-reply`, `#btn-reply-all`, etc. in `.card-header` → Buttons visible even when no message expanded
- **Expected behavior**: Thread view loads → Header buttons remain hidden → Only per-message buttons in `thread-msg-header` are visible when message is expanded

**Example 3: Buttons in Wrong Location**
- **Current behavior**: Message expanded → Buttons rendered at line 7995-7999 in `thread-msg-body` (bottom of message) → Buttons appear below message content
- **Expected behavior**: Message expanded → Buttons rendered in `thread-msg-header` (line 7976) → Buttons appear on same row as sender/email/timestamp, aligned to the right

**Example 4: Ambiguous Reply Context**
- **Current behavior**: Thread collapsed → Header buttons visible → User clicks `#btn-reply` → `openReply(false)` called → Uses `activeMailMessage` global state → Unclear which message is being replied to
- **Expected behavior**: Thread collapsed → No buttons visible → User must expand a specific message to see reply buttons → Clear message-specific context

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Single email view (non-thread) must continue to use `openReply()`, `activeMailMessage`, and global header buttons
- Task creation from emails must continue to use `activeMailMessage` for metadata
- Reply sending must continue to mark related tasks as done using `activeMessageId` and `activeMailMessage.conversationId`
- Compose modal must continue to apply default signatures, load templates, and load group dropdowns
- Thread message rendering must continue to display To/CC recipients, timestamps, and message previews correctly

**Scope:**
All inputs that do NOT involve thread view reply actions should be completely unaffected by this fix. This includes:
- Single email view operations (clicking Reply from inbox list)
- Task modal operations
- Compose modal operations unrelated to thread replies
- Email list rendering and selection

## Hypothesized Root Cause

Based on the bug description and code analysis, the root causes are:

1. **Legacy Global State Pattern**: The functions `openReplyFromThread()` and `forwardFromThread()` were likely copied from the single-view `openReply()` function, which legitimately needs to set `activeMessageId` for subsequent operations. However, in thread view, the `meta` parameter contains all necessary data, making the global state assignment unnecessary and potentially harmful.

2. **Dual Button System**: The codebase has evolved to support both single-view and thread-view, but the global header buttons were never properly hidden for thread view. The per-message buttons were added (lines 7995-7999) but the header buttons remained visible, creating redundancy and ambiguity.

3. **Incorrect Button Placement in Thread Messages**: The per-message buttons were placed in `thread-msg-body` (bottom of expanded message) instead of `thread-msg-header` (aligned with sender row), violating Outlook-style UX where action buttons appear beside the sender information.

4. **Missing View State Logic**: There is no explicit logic to detect "thread view active" vs "single view active" and conditionally show/hide the appropriate button set. The code at line 8313-8316 unconditionally shows header buttons when any email is opened.

## Correctness Properties

Property 1: Bug Condition - Thread Reply Functions Use Only Meta Parameter

_For any_ thread reply action where a user clicks Reply/Reply All/Forward on a specific message in a thread, the functions `openReplyFromThread(meta, replyAll)` and `forwardFromThread(meta)` SHALL use ONLY the `meta` parameter for all recipient resolution, subject construction, and body quoting, with NO assignment to `activeMessageId` or reliance on `activeMailMessage`.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.7**

Property 2: Preservation - Single View Behavior Unchanged

_For any_ email opened in single view (non-thread), the system SHALL continue to use `openReply()`, set `activeMailMessage`, show global header buttons, and use `activeMessageId` for task operations, preserving all existing single-view functionality.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

Property 3: Bug Condition - Buttons Only in thread-msg-header

_For any_ message rendered in thread view, reply action buttons (Reply, Reply All, Forward, Assign Task) SHALL be rendered ONLY inside the `thread-msg-header` container aligned with the sender row, and SHALL NOT be rendered in `.card-header` or at the bottom of `thread-msg-body`.

**Validates: Requirements 2.15, 2.16, 2.17, 2.18, 2.20, 2.21, 2.24, 2.25, 2.26, 2.27**

Property 4: Bug Condition - Header Buttons Hidden in Thread View

_For any_ thread view rendering, the global header buttons (`#btn-reply`, `#btn-reply-all`, `#btn-assign-reply`, `#btn-ai-reply`) in `.card-header` SHALL be hidden or removed, and SHALL NOT be visible or clickable.

**Validates: Requirements 2.8, 2.9, 2.10, 2.15**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `dashboard.html`

**Function**: `openReplyFromThread(meta, replyAll)` (line 8064)

**Specific Changes**:

1. **Remove Global State Assignment in openReplyFromThread**:
   - **Location**: Line 8069
   - **Current code**: `activeMessageId = meta.id;`
   - **Change**: Delete this line entirely
   - **Rationale**: The function receives complete metadata in the `meta` parameter and uses it for all operations. The global state assignment is unnecessary and creates coupling.

2. **Remove Global State Assignment in forwardFromThread**:
   - **Location**: Line 8154
   - **Current code**: `activeMessageId = meta.id;`
   - **Change**: Delete this line entirely
   - **Rationale**: Same as above - the `meta` parameter contains all necessary data.

3. **Move Buttons from thread-msg-body to thread-msg-header**:
   - **Location**: Lines 7995-7999 (current button location in `thread-msg-body`)
   - **Current code**:
     ```html
     <!-- Per-message action buttons (Outlook-style, bottom of each message) -->
     <div style="padding:8px 16px 12px 58px;display:flex;gap:6px;align-items:center;border-top:1px solid rgba(255,255,255,0.04);margin-top:4px;">
       <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();openReplyFromThread(${metaAttr},false)" title="Reply to this message"><i class="fas fa-reply"></i> Reply</button>
       <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();openReplyFromThread(${metaAttr},true)"  title="Reply All to this message"><i class="fas fa-reply-all"></i> Reply All</button>
       <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();forwardFromThread(${metaAttr})"         title="Forward this message"><i class="fas fa-share"></i> Forward</button>
     </div>
     ```
   - **Change**: Remove this entire div from `thread-msg-body`
   - **New location**: Inside `thread-msg-header` (line 7976), aligned to the right
   - **New structure**:
     ```html
     <div class="thread-msg-header" onclick="toggleThreadMsg('${msgId}')" style="display:flex;align-items:center;gap:10px;padding:10px 16px;cursor:pointer;transition:background 0.1s;justify-content:space-between;" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background=''">
       <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;">
         <!-- Avatar -->
         <div style="width:32px;height:32px;border-radius:50%;background:${bgColor};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;">${initials}</div>
         <!-- Sender info -->
         <div style="flex:1;min-width:0;">
           <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
             <span style="font-size:12.5px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px;">${escHtml(from)}${fromAddr && fromAddr !== from ? ' <span style="font-weight:400;color:var(--muted);">&lt;'+escHtml(fromAddr)+'&gt;</span>' : ''}</span>
             <span style="font-size:10.5px;color:var(--muted);flex-shrink:0;">${time}</span>
           </div>
           <div class="thread-msg-preview" style="font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${expanded?'display:none;':''}">${escHtml(preview)}</div>
         </div>
       </div>
       <!-- Action buttons (right-aligned) -->
       <div class="msg-actions" style="display:flex;gap:4px;align-items:center;flex-shrink:0;" onclick="event.stopPropagation();">
         <button class="btn btn-ghost btn-xs" onclick="openReplyFromThread(${metaAttr},false)" title="Reply to this message"><i class="fas fa-reply"></i></button>
         <button class="btn btn-ghost btn-xs" onclick="openReplyFromThread(${metaAttr},true)" title="Reply All to this message"><i class="fas fa-reply-all"></i></button>
         <button class="btn btn-ghost btn-xs" onclick="forwardFromThread(${metaAttr})" title="Forward this message"><i class="fas fa-share"></i></button>
       </div>
       <!-- Chevron -->
       <i class="fas fa-chevron-${expanded?'up':'down'} thread-msg-chevron" style="font-size:10px;color:var(--muted);flex-shrink:0;"></i>
     </div>
     ```
   - **Rationale**: Buttons should be visually bound to the sender row, not at the bottom of the message. This matches Outlook UX where actions appear beside the sender information.

4. **Hide Header Buttons in Thread View**:
   - **Location**: Line 8313-8316 (in `renderThreadView()` or similar function)
   - **Current code**:
     ```javascript
     // Show reply buttons
     ['btn-reply','btn-reply-all','btn-assign-reply','btn-ai-reply'].forEach(id => {
       const el = document.getElementById(id);
       if (el) el.style.display = 'inline-flex';
     });
     ```
   - **Change**: Wrap this in a conditional that checks if thread view is active:
     ```javascript
     // Hide header buttons in thread view (per-message buttons are used instead)
     const threadWrap = document.getElementById('email-thread-wrap');
     const isThreadView = threadWrap && threadWrap.style.display !== 'none';
     
     if (!isThreadView) {
       // Show reply buttons only in single view
       ['btn-reply','btn-reply-all','btn-assign-reply','btn-ai-reply'].forEach(id => {
         const el = document.getElementById(id);
         if (el) el.style.display = 'inline-flex';
       });
     } else {
       // Hide header buttons in thread view
       ['btn-reply','btn-reply-all','btn-assign-reply','btn-ai-reply'].forEach(id => {
         const el = document.getElementById(id);
         if (el) el.style.display = 'none';
       });
     }
     ```
   - **Rationale**: Header buttons should only be visible in single view. In thread view, per-message buttons provide the reply mechanism.

5. **Add CSS for msg-actions Container**:
   - **Location**: CSS section (around line 400-500)
   - **New CSS**:
     ```css
     .msg-actions {
       display: flex;
       gap: 4px;
       align-items: center;
       flex-shrink: 0;
     }
     .msg-actions .btn {
       opacity: 0;
       transition: opacity 0.15s;
     }
     .thread-msg-header:hover .msg-actions .btn {
       opacity: 1;
     }
     ```
   - **Rationale**: Buttons should fade in on hover to reduce visual clutter, matching Outlook behavior.

6. **Update thread-msg-header Style**:
   - **Location**: Line 7976
   - **Current style**: `style="display:flex;align-items:center;gap:10px;padding:10px 16px;cursor:pointer;transition:background 0.1s;"`
   - **New style**: `style="display:flex;align-items:center;gap:10px;padding:10px 16px;cursor:pointer;transition:background 0.1s;justify-content:space-between;"`
   - **Rationale**: `justify-content: space-between` ensures buttons are aligned to the right side of the header.

### Code Structure for the Fix

**Target HTML Structure for thread-msg-header:**

```html
<div class="thread-msg-header" onclick="toggleThreadMsg('${msgId}')" 
     style="display:flex;align-items:center;gap:10px;padding:10px 16px;cursor:pointer;transition:background 0.1s;justify-content:space-between;">
  
  <!-- Left section: Avatar + Sender info -->
  <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;">
    <!-- Avatar -->
    <div style="width:32px;height:32px;border-radius:50%;background:${bgColor};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;">
      ${initials}
    </div>
    
    <!-- Sender info -->
    <div style="flex:1;min-width:0;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="font-size:12.5px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px;">
          ${escHtml(from)}${fromAddr && fromAddr !== from ? ' <span style="font-weight:400;color:var(--muted);">&lt;'+escHtml(fromAddr)+'&gt;</span>' : ''}
        </span>
        <span style="font-size:10.5px;color:var(--muted);flex-shrink:0;">${time}</span>
      </div>
      <div class="thread-msg-preview" style="font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${expanded?'display:none;':''}">
        ${escHtml(preview)}
      </div>
    </div>
  </div>
  
  <!-- Right section: Action buttons -->
  <div class="msg-actions" style="display:flex;gap:4px;align-items:center;flex-shrink:0;" onclick="event.stopPropagation();">
    <button class="btn btn-ghost btn-xs" onclick="openReplyFromThread(${metaAttr},false)" title="Reply to this message">
      <i class="fas fa-reply"></i>
    </button>
    <button class="btn btn-ghost btn-xs" onclick="openReplyFromThread(${metaAttr},true)" title="Reply All to this message">
      <i class="fas fa-reply-all"></i>
    </button>
    <button class="btn btn-ghost btn-xs" onclick="forwardFromThread(${metaAttr})" title="Forward this message">
      <i class="fas fa-share"></i>
    </button>
  </div>
  
  <!-- Chevron -->
  <i class="fas fa-chevron-${expanded?'up':'down'} thread-msg-chevron" style="font-size:10px;color:var(--muted);flex-shrink:0;"></i>
</div>
```

**Key Points:**
- `justify-content: space-between` on the header ensures proper spacing
- `onclick="event.stopPropagation()"` on `.msg-actions` prevents the toggle action when clicking buttons
- Each button receives the `meta` object directly via `${metaAttr}` (JSON-encoded metadata)
- No global state is set or referenced in the button handlers
- Buttons are icon-only to save space in the header row

**Function Signature (No Changes Needed):**

```javascript
function openReplyFromThread(meta, replyAll) {
  // REMOVE: activeMessageId = meta.id;
  
  if (!meta || !meta.id) return;
  
  // ... rest of function uses only meta parameter ...
}

function forwardFromThread(meta) {
  // REMOVE: activeMessageId = meta.id;
  
  if (!meta || !meta.id) return;
  
  // ... rest of function uses only meta parameter ...
}
```

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that simulate clicking reply buttons in thread view and assert that global state is NOT set, and that buttons are in the correct location. Run these tests on the UNFIXED code to observe failures and understand the root cause.

**Test Cases**:
1. **Global State Assignment Test**: Open thread view, click Reply on message C, verify `activeMessageId` is set (will fail on unfixed code - confirms bug exists)
2. **Header Buttons Visible Test**: Open thread view, verify header buttons are visible (will fail on unfixed code - confirms bug exists)
3. **Button Location Test**: Open thread view, expand message, verify buttons are in `thread-msg-body` not `thread-msg-header` (will fail on unfixed code - confirms bug exists)
4. **Ambiguous Reply Context Test**: Open thread view without expanding any message, verify header buttons are clickable (will fail on unfixed code - confirms bug exists)

**Expected Counterexamples**:
- `activeMessageId` is set when `openReplyFromThread()` is called
- Header buttons (`#btn-reply`, etc.) are visible in thread view
- Per-message buttons are at the bottom of `thread-msg-body` instead of in `thread-msg-header`
- Possible causes: legacy code pattern, missing view state logic, incorrect HTML structure

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := threadReplyAction_fixed(input)
  ASSERT expectedBehavior(result)
END FOR
```

**Expected Behavior:**
- `activeMessageId` is NOT set when thread reply functions are called
- Header buttons are hidden in thread view
- Per-message buttons are in `thread-msg-header` aligned with sender row
- Clicking buttons uses ONLY the `meta` parameter

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalBehavior(input) = fixedBehavior(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for single-view operations, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Single View Reply Preservation**: Open email in single view (not thread), click Reply, verify `activeMailMessage` is set and used correctly
2. **Task Creation Preservation**: Open email, create task, verify `activeMailMessage` is used for task metadata
3. **Reply Sending Preservation**: Send reply, verify related tasks are marked as done using `activeMessageId` and `activeMailMessage.conversationId`
4. **Header Buttons in Single View**: Open email in single view, verify header buttons are visible and functional

### Unit Tests

- Test `openReplyFromThread()` with various `meta` objects, verify no global state is set
- Test `forwardFromThread()` with various `meta` objects, verify no global state is set
- Test thread view rendering, verify header buttons are hidden
- Test thread view rendering, verify per-message buttons are in `thread-msg-header`
- Test single view rendering, verify header buttons are visible
- Test button click handlers, verify correct `meta` object is passed

### Property-Based Tests

- Generate random thread structures (1-10 messages), verify all per-message buttons use correct metadata
- Generate random message metadata, verify reply functions populate compose modal correctly without global state
- Generate random view states (thread vs single), verify correct button set is visible
- Test that all single-view operations continue to work across many scenarios

### Integration Tests

- Test full thread view flow: open thread, expand message, click Reply, verify compose modal is populated correctly
- Test switching between thread view and single view, verify correct buttons are shown
- Test clicking Reply on different messages in sequence, verify no state leakage between messages
- Test that visual layout shows buttons beside sender/email (same row), not at bottom of message

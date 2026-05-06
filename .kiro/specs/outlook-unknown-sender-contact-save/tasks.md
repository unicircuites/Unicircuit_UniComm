# Implementation Plan: Outlook Unknown Sender Detection & Quick Contact Save

## Overview

Implement client-side unknown-sender detection in `dashboard.html` and a new `POST /api/outlook/contacts` backend endpoint. The work proceeds in layers: ContactResolver module first (the foundation everything else depends on), then the backend endpoint, then the Quick Save Modal, then the visual indicators in each view, and finally cache refresh wiring.

## Tasks

- [x] 1. Add `ContactResolver` module to `dashboard.html`
  - Add the `ContactResolver` IIFE object to the Outlook section JS block in `dashboard.html`, implementing `buildCache(contacts)`, `isUnknownSender(email)`, and `getProviderCategory(email)`
  - `buildCache` must normalise all email addresses to lowercase before inserting into the internal `Map`
  - `isUnknownSender` must return `true` for absent emails AND for emails whose `displayName` is empty/null
  - `getProviderCategory` must match the full domain list from the design (gmail, yahoo, outlook personal, icloud, protonmail, zoho, rediffmail, other)
  - Wire `ContactResolver.buildCache(contactsCache)` into the existing `outlookLoadContacts()` function immediately after `contactsCache` is assigned
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 9.1, 9.4_

  - [ ]* 1.1 Write property test for `isUnknownSender` — cache lookup is case-insensitive
    - **Property 1: Cache lookup is case-insensitive**
    - **Validates: Requirements 1.1, 1.4**

  - [ ]* 1.2 Write property test for `isUnknownSender` — absent email is always unknown
    - **Property 2: Absent email is always unknown**
    - **Validates: Requirements 1.2**

  - [ ]* 1.3 Write property test for `isUnknownSender` — empty displayName → unknown
    - **Property 3: Empty displayName → unknown**
    - **Validates: Requirements 1.3**

  - [ ]* 1.4 Write property test for `isUnknownSender` — non-empty displayName → known
    - **Property 4: Non-empty displayName → known**
    - **Validates: Requirements 1.4**

  - [ ]* 1.5 Write property test for `buildCache` — idempotence
    - **Property 5: Cache rebuild is idempotent**
    - **Validates: Requirements 1.6**

  - [ ]* 1.6 Write property test for `getProviderCategory` — case-insensitive domain matching
    - **Property 8: Provider category is case-insensitive**
    - **Validates: Requirements 9.4**

  - [ ]* 1.7 Write property test for `getProviderCategory` — every unknown email has a provider category
    - **Property 9: Every unknown email has a provider category**
    - **Validates: Requirements 9.1**

- [x] 2. Add `POST /api/outlook/contacts` backend endpoint
  - Add the new route to `backend/routes/outlook.js` after the existing `GET /contacts` route and before `POST /contacts/import`
  - Destructure `displayName`, `email`, `givenName`, `surname`, `mobilePhone`, `companyName` from `req.body`
  - Return HTTP 400 if `displayName` or `email` is missing
  - Build the Graph contact body and call `graph.graphPost('/me/contacts', body, MS_EMAIL)`
  - Return HTTP 201 with `{ id, displayName, emailAddresses }` on success
  - Return HTTP 401 for `NOT_AUTHENTICATED`, HTTP 502 for all other Graph errors
  - The route inherits JWT protection from the existing `router.use(authenticate)` — no extra middleware needed
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

  - [ ]* 2.1 Write unit tests for the POST /api/outlook/contacts route
    - Test 400 when `displayName` missing
    - Test 400 when `email` missing
    - Test 201 with correct response shape on Graph success
    - Test 401 when Graph throws `NOT_AUTHENTICATED`
    - Test 502 when Graph throws any other error
    - _Requirements: 5.5, 5.6, 5.7_

- [x] 3. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Add Quick Save Modal HTML and JavaScript to `dashboard.html`
  - Add the `#qs-modal-overlay` modal HTML to the modal section of `dashboard.html` (alongside existing modals), including the read-only email field, hidden `#qs-source-group` Source field, required Display Name field, optional First/Last Name fields, inline error divs, and Save/Cancel buttons
  - Add the `openQuickSaveModal(email)` function: populate fields, show/hide `#qs-source-group` based on `ContactResolver.isUnknownSender(email)`, populate `#qs-source` with `getProviderCategory` label, open the overlay, and focus the Display Name input
  - Add the `closeQuickSaveModal()` function
  - Add the `submitQuickSave()` function: validate Display Name (show `#qs-dn-error` if empty), validate email format with `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` (show `#qs-api-error` if invalid), set loading state on button, POST to `/api/outlook/contacts` with JWT from the same `getToken()` accessor used by other Outlook fetch calls, handle success (close modal, `notify()` toast, call `outlookLoadContacts()`), handle error (re-enable button, show error in `#qs-api-error`)
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [ ]* 4.1 Write property test for `submitQuickSave` — email format validation
    - **Property 7: Email format validation prevents fetch for invalid addresses**
    - **Validates: Requirements 4.5**

- [x] 5. Add unknown-sender indicators to the Inbox mail list
  - Add the `renderSenderCell(email, displayName)` helper function to the Outlook JS block in `dashboard.html`
  - Modify the existing `outlookRenderInbox()` function to call `renderSenderCell()` for the sender name cell of each row
  - When `isUnknownSender(email)` is true: render the raw email in muted style, an amber "Unknown" badge with `fa-user-question` icon, a provider badge using `getProviderCategory`, and a `btn-xs btn-ghost` "Add Contact" button that calls `openQuickSaveModal(email)`
  - When the sender is known: render the resolved display name as plain text
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 9.2_

- [x] 6. Add unknown-recipient indicators to the Sent mail list
  - Add the `renderRecipientCell(toAddresses, ccAddresses)` helper function to the Outlook JS block in `dashboard.html`
  - Modify the existing `outlookRenderSent()` function to call `renderRecipientCell()` for the recipient cell of each sent row, passing `msg.toRecipients` and `msg.ccRecipients`
  - For each recipient address: if unknown, render email + "Unknown" badge + provider badge + "Add Contact" button; if known, render display name
  - Separate multiple recipients with a `·` separator
  - _Requirements: 2.6, 2.7, 8.1, 8.2, 9.2_

  - [ ]* 6.1 Write property test for `renderRecipientCell` — covers all To and CC addresses
    - **Property 10: Sent recipient scanning covers all To and CC addresses**
    - **Validates: Requirements 8.1**

- [x] 7. Add unknown-sender hint to the Compose View
  - Add a `<div id="compose-unknown-hint">` element directly below the `#compose-to` input in the compose modal HTML, styled with `font-size:11.5px; color:var(--muted2); margin-top:4px; display:none;`
  - Add an `input` event listener on `#compose-to` that calls `ContactResolver.isUnknownSender()` on the current value and shows/hides the hint with an "Add Contact" link that calls `openQuickSaveModal(email)`
  - When the email resolves to a known contact, hide the hint
  - _Requirements: 3.1, 3.2, 3.6_

- [x] 8. Add dismissible unknown-sender banner to the Reply View and Sent Detail View
  - Add the `injectReplyUnknownBanner(senderEmail, containerId)` helper function to the Outlook JS block in `dashboard.html`
  - The banner must: check `ContactResolver.isUnknownSender(senderEmail)` and return early if known; remove any existing `.reply-unknown-banner` before injecting; render the amber banner with "Sender not in Outlook Contacts" text, an "Add Contact" `btn-xs btn-gold` button, and a dismiss `btn-xs btn-ghost` button
  - Call `injectReplyUnknownBanner()` from the reply panel render path, passing the original sender's email
  - For the sent message detail view, call the same helper with the recipient email and adapt the banner text to "Recipient not in Outlook Contacts"
  - _Requirements: 2.8, 3.3, 3.4, 3.5, 3.6, 8.3_

- [x] 9. Update the Contacts Directory card render for unknown/nameless contacts
  - Modify the existing contact card render function in `dashboard.html` to call `renderContactCardTitle(contact)` (or inline the equivalent logic)
  - When `displayName` is empty/null: render the email address as the card title, a "No name saved" subtitle in muted style, and an "Add Name" `btn-xs btn-gold` button that calls `openQuickSaveModal(email)`
  - When `displayName` is non-empty: render display name as title and email as subtitle with no extra label or button
  - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [x] 10. Wire cache refresh and re-render after contact save
  - Ensure `outlookLoadContacts()` calls `ContactResolver.buildCache(contactsCache)` after assigning the fetched contacts (already covered in Task 1, verify it is in place)
  - After `outlookLoadContacts()` completes inside `submitQuickSave()`, re-render the currently active mail list tab: call `outlookRenderInbox()` if the inbox tab is active, or `outlookRenderSent()` if the sent tab is active
  - Verify the compose hint clears automatically on the next `input` event (no extra action needed)
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 6.5_

  - [ ]* 10.1 Write property test for the save → refresh → known round-trip
    - **Property 6: Save → refresh → known**
    - **Validates: Requirements 7.1, 7.2_

- [x] 11. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Task 1 (ContactResolver) must be completed before Tasks 5–10, as all visual indicators depend on it
- Task 4 (Quick Save Modal) must be completed before Tasks 5–10, as all "Add Contact" buttons call `openQuickSaveModal()`
- Task 2 (backend endpoint) must be completed before Task 4's `submitQuickSave()` can be tested end-to-end
- Property tests validate universal correctness properties; unit tests validate specific examples and edge cases
- The `b-purple` badge class is already defined in `dashboard.html` CSS and is used for Yahoo provider badges

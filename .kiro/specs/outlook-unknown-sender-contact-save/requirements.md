# Requirements Document

## Introduction

UniComm Pro's Outlook section currently fetches contacts from Microsoft Graph API and displays them in the Contacts directory. However, when a user sends a new email or replies to someone whose email address is not saved in Outlook Contacts (or is saved without a display name), that person appears as a raw email ID everywhere — in the mail list, in the compose/reply view, and in the Contacts directory. There is no way to quickly save them as a named contact from within the dashboard.

This feature introduces **Unknown Sender Detection and Quick Contact Save** for the Outlook mail section. The system will detect email addresses that lack a proper display name, visually flag them as "unknown", and provide a one-click "Add to Outlook Contact" flow where the email is pre-filled and the user only needs to enter a name. Once saved, the contact appears with a proper name across the entire dashboard — mirroring the WhatsApp experience where a number is visible but unusable until saved with a name.

---

## Glossary

- **Dashboard**: The single-page application served as `dashboard.html`.
- **Outlook_Section**: The Email / Outlook section of the Dashboard, identified as `#sec-email`.
- **Contacts_Directory**: The Contacts section of the Dashboard (`#sec-contacts`) that lists Outlook contacts fetched via Microsoft Graph API.
- **Graph_API**: Microsoft Graph REST API (`https://graph.microsoft.com/v1.0`) used to read and write Outlook data.
- **Contact_Resolver**: The client-side logic in the Dashboard that determines whether an email address has a known display name by cross-referencing the in-memory contacts cache.
- **Unknown_Sender**: An email address that either (a) does not exist in the Contacts_Cache, or (b) exists in the Contacts_Cache but has an empty or null `displayName`.
- **Quick_Save_Modal**: A lightweight modal dialog in the Dashboard that allows the user to save an Unknown_Sender as an Outlook Contact with a display name.
- **Save_Contact_API**: The new backend endpoint `POST /api/outlook/contacts` that creates a contact in the Outlook Contacts folder via Graph API.
- **Contacts_Cache**: The in-memory JavaScript array in the Dashboard populated by `GET /api/outlook/contacts`, used by the Contact_Resolver to avoid repeated API calls.
- **Mail_List**: The list of inbox messages rendered in the Outlook_Section.
- **Sent_List**: The list of sent messages rendered in the Outlook_Section (the Sent folder view).
- **Compose_View**: The email composition modal (`#compose-modal`) used to write new emails.
- **Reply_View**: The reply panel rendered inside the email detail view in the Outlook_Section.
- **Provider_Category**: A human-readable label (e.g., "Gmail", "Edu", "Yahoo", "Outlook Personal", "Other") derived from the domain portion of an email address, used to identify the type of email provider for an Unknown_Sender.

---

## Requirements

### Requirement 1: Unknown Sender Detection

**User Story:** As a UniComm Pro user, I want the dashboard to automatically identify email addresses that have no saved display name in Outlook Contacts, so that I can immediately see which senders or recipients are "unknown" without manually checking the Contacts directory.

#### Acceptance Criteria

1. WHEN the Dashboard loads the Contacts_Directory data via `GET /api/outlook/contacts`, THE Contact_Resolver SHALL build an in-memory lookup map keyed by normalised lowercase email address, storing the resolved display name for each entry.

2. WHEN an email address is absent from the Contacts_Cache (i.e., no contact entry exists with that email address), THE Contact_Resolver SHALL classify that email address as an Unknown_Sender.

3. WHEN an email address is present in the Contacts_Cache but the contact's `displayName` is empty or null, THE Contact_Resolver SHALL classify that email address as an Unknown_Sender.

4. WHEN an email address is present in the Contacts_Cache AND the contact has a non-empty `displayName` (regardless of whether it matches the email address or not), THE Contact_Resolver SHALL classify that email address as a known contact and `isUnknownSender()` SHALL return `false`.

5. THE Contact_Resolver SHALL expose a function `isUnknownSender(emailAddress)` that returns `true` if the given email address is classified as an Unknown_Sender or is absent from the Contacts_Cache, and `false` otherwise.

6. WHEN the Contacts_Cache is refreshed (e.g., after a contact is saved), THE Contact_Resolver SHALL rebuild the lookup map so that newly saved contacts are no longer classified as Unknown_Senders.

---

### Requirement 2: Unknown Sender Visual Indicator in Mail List

**User Story:** As a UniComm Pro user, I want unknown senders and recipients to be visually highlighted in both the inbox and sent mail lists, so that I can spot unsaved contacts at a glance — similar to how WhatsApp shows a phone number instead of a name for unsaved contacts.

#### Acceptance Criteria

1. WHEN the Mail_List renders an inbox message row and the sender's email address is classified as an Unknown_Sender by the Contact_Resolver, THE Dashboard SHALL display the sender's name field with a distinct visual indicator (e.g., a muted amber/orange badge labelled "Unknown" or a person-with-question-mark icon) alongside the raw email address.

2. WHEN the Mail_List renders an inbox message row and the sender's email address resolves to a known display name in the Contacts_Cache, THE Dashboard SHALL display the resolved display name without any unknown indicator.

3. WHEN a message row displays an Unknown_Sender indicator, THE Dashboard SHALL render an inline "Add Contact" icon button (e.g., `fa-user-plus`) adjacent to the sender name in that row.

4. WHEN the user clicks the inline "Add Contact" icon button in a mail list row, THE Dashboard SHALL open the Quick_Save_Modal pre-filled with the sender's email address from that message.

5. THE Dashboard SHALL NOT alter the layout or spacing of mail list rows that have known senders when adding the unknown-sender indicator to rows with unknown senders.

6. WHEN the Sent_List renders a sent message row, THE Dashboard SHALL evaluate each recipient email address in the To and CC fields of that message using `isUnknownSender()`.

7. WHEN any recipient in a Sent_List message row is classified as an Unknown_Sender, THE Dashboard SHALL display the Unknown badge and an inline "Add Contact" button for that recipient address in the sent message row.

8. WHEN the user opens a sent message detail view and the recipient is classified as an Unknown_Sender, THE Dashboard SHALL display the same dismissible banner as the Reply_View (adapted to read "Recipient not in Outlook Contacts") with an "Add Contact" button pre-filled with that recipient's email address.

---

### Requirement 3: Unknown Recipient Indicator in Compose and Reply Views

**User Story:** As a UniComm Pro user, I want to see a warning when I am composing or replying to an email address that is not in my Outlook Contacts, so that I am reminded to save them before or after sending.

#### Acceptance Criteria

1. WHEN the user types or pastes an email address into the "To" field of the Compose_View and that address is classified as an Unknown_Sender by the Contact_Resolver, THE Dashboard SHALL display a non-blocking inline hint below the "To" field reading "Not in Outlook Contacts — " followed by an "Add Contact" link.

2. WHEN the user clicks the "Add Contact" link in the Compose_View hint, THE Dashboard SHALL open the Quick_Save_Modal pre-filled with the email address from the "To" field.

3. WHEN the Reply_View is rendered for a message whose sender is classified as an Unknown_Sender, THE Dashboard SHALL display a dismissible banner above the reply editor reading "Sender not in Outlook Contacts" with an "Add Contact" button.

4. WHEN the user clicks the "Add Contact" button in the Reply_View banner, THE Dashboard SHALL open the Quick_Save_Modal pre-filled with the original sender's email address.

5. WHEN the user dismisses the Reply_View banner, THE Dashboard SHALL hide the banner for the duration of that reply session without affecting other messages.

6. IF the Contact_Resolver returns `false` for an email address (i.e., the sender is already a known contact), THEN THE Dashboard SHALL NOT display the unknown-sender hint or banner for that address.

---

### Requirement 4: Quick Save Modal (Add to Outlook Contact)

**User Story:** As a UniComm Pro user, I want a quick modal form where the email address is already filled in and I only need to type a name, so that saving an unknown sender as an Outlook Contact takes minimal effort.

#### Acceptance Criteria

1. WHEN the Quick_Save_Modal is opened, THE Dashboard SHALL display a form containing: a read-only or pre-filled email address field, a required "Display Name" text input, an optional "First Name" text input, an optional "Last Name" text input, and a "Save Contact" submit button.

2. WHEN the Quick_Save_Modal is opened with a pre-filled email address, THE Dashboard SHALL populate the email field with that address and set focus on the "Display Name" input field.

3. WHEN the user submits the Quick_Save_Modal form with a non-empty "Display Name" and a valid email address, THE Dashboard SHALL call `POST /api/outlook/contacts` with the provided name and email data.

4. IF the "Display Name" field is empty when the user clicks "Save Contact", THEN THE Dashboard SHALL display an inline validation message "Display name is required" and SHALL NOT submit the form.

5. IF the email address field contains a value that does not match a valid email format (RFC 5321 local-part@domain), THEN THE Dashboard SHALL display an inline validation message "Enter a valid email address" and SHALL NOT submit the form.

6. WHILE the Save_Contact_API request is in progress, THE Dashboard SHALL disable the "Save Contact" button and display a loading spinner inside it.

7. WHEN the Save_Contact_API returns a success response, THE Dashboard SHALL close the Quick_Save_Modal, display a success toast notification "Contact saved to Outlook", and refresh the Contacts_Cache by re-fetching `GET /api/outlook/contacts`.

8. IF the Save_Contact_API returns an error response, THEN THE Dashboard SHALL display an error message inside the Quick_Save_Modal without closing it, so the user can retry.

---

### Requirement 5: Save Contact Backend API

**User Story:** As a UniComm Pro developer, I want a backend endpoint that creates a new contact in the Outlook Contacts folder via Microsoft Graph API, so that the Dashboard can save unknown senders without requiring a separate Outlook client.

#### Acceptance Criteria

1. THE Save_Contact_API SHALL accept `POST /api/outlook/contacts` with a JSON body containing at minimum `displayName` (string, required) and `email` (string, required).

2. THE Save_Contact_API SHALL accept optional fields `givenName` (string), `surname` (string), `mobilePhone` (string), and `companyName` (string) in the request body.

3. WHEN a valid request is received, THE Save_Contact_API SHALL call `POST /me/contacts` on the Graph_API with the provided fields mapped to the Microsoft Graph contact schema.

4. WHEN the Graph_API returns a successful `201 Created` response, THE Save_Contact_API SHALL return HTTP 201 with a JSON body containing the created contact's `id`, `displayName`, and `emailAddresses` as returned by Graph_API.

5. IF the request body is missing `displayName` or `email`, THEN THE Save_Contact_API SHALL return HTTP 400 with a JSON error body `{ "error": "displayName and email are required" }`.

6. IF the Graph_API returns an error (e.g., duplicate contact, permission denied), THEN THE Save_Contact_API SHALL return HTTP 502 with a JSON error body containing the Graph_API error message.

7. IF the Outlook account is not authenticated (no valid token), THEN THE Save_Contact_API SHALL return HTTP 401 with `{ "error": "NOT_AUTHENTICATED" }`.

8. THE Save_Contact_API SHALL require a valid JWT (via the existing `authenticate` middleware) before processing any request.

---

### Requirement 6: Contacts Directory — Unknown Name Display Fix

**User Story:** As a UniComm Pro user, I want the Contacts directory to clearly distinguish between contacts that have a proper name and those that only have an email address, so that I can identify and fix incomplete contact records.

#### Acceptance Criteria

1. WHEN the Contacts_Directory renders a contact card and the contact's `displayName` is empty or null, THE Dashboard SHALL render the contact's title as the email address AND display a secondary label "No name saved" in muted styling below the email.

2. WHEN the Contacts_Directory renders a contact card and the contact has a proper display name (different from the email address), THE Dashboard SHALL render the contact's title as the display name and the email address as the subtitle, with no additional label.

3. WHEN the Contacts_Directory renders a contact card classified as an Unknown_Sender, THE Dashboard SHALL display an "Add Name" button on that card.

4. WHEN the user clicks the "Add Name" button on a contact card in the Contacts_Directory, THE Dashboard SHALL open the Quick_Save_Modal pre-filled with that contact's email address.

5. WHEN a contact is successfully saved via the Quick_Save_Modal from the Contacts_Directory, THE Dashboard SHALL refresh the Contacts_Directory list to reflect the updated display name without requiring a full page reload.

---

### Requirement 7: Post-Save Contact Cache Refresh

**User Story:** As a UniComm Pro user, I want the dashboard to immediately reflect a newly saved contact name everywhere — in the mail list, compose view, and contacts directory — after I save an unknown sender, so that I do not see stale "unknown" indicators.

#### Acceptance Criteria

1. WHEN a contact is successfully saved via the Quick_Save_Modal, THE Dashboard SHALL re-fetch `GET /api/outlook/contacts` and rebuild the Contacts_Cache within 2 seconds of the successful save response.

2. WHEN the Contacts_Cache is rebuilt after a save, THE Dashboard SHALL re-render all currently visible mail list rows to update any unknown-sender indicators that now resolve to the newly saved contact name.

3. WHEN the Contacts_Cache is rebuilt after a save, THE Dashboard SHALL re-evaluate any open Compose_View "To" field hints and remove the unknown-sender hint if the entered address now resolves to a known contact.

4. THE Dashboard SHALL NOT require a full browser page reload for the updated contact name to appear in the Mail_List, Sent_List, Compose_View, or Contacts_Directory.

---

### Requirement 8: Sent Recipients Contact Coverage

**User Story:** As a UniComm Pro user, I want recipients of my sent emails to also be checked against Outlook Contacts, so that I can save people I've emailed but never formally added as contacts.

#### Acceptance Criteria

1. WHEN the Sent_List renders a sent message row, THE Dashboard SHALL evaluate each recipient email address in the To and CC fields of that message using `isUnknownSender()`.

2. WHEN any recipient in a sent message row is classified as an Unknown_Sender, THE Dashboard SHALL display the Unknown badge and Add Contact button for that recipient address in the sent message row.

3. WHEN the user opens a sent message detail view and the recipient is an Unknown_Sender, THE Dashboard SHALL display the same "Sender not in Outlook Contacts" banner (adapted to read "Recipient not in Outlook Contacts") with an Add Contact button pre-filled with that recipient's email address.

---

### Requirement 9: Unknown Contact Provider Categorization

**User Story:** As a UniComm Pro user, I want unknown email addresses to show a provider/category badge (e.g., "Gmail", "Edu", "Yahoo", "Work") so I can quickly identify what kind of contact they are even before saving them.

#### Acceptance Criteria

1. WHEN an email address is classified as an Unknown_Sender, THE Dashboard SHALL determine its Provider_Category based on the email domain using the following rules:
   - `@gmail.com`, `@googlemail.com` → Provider_Category: "Gmail" (blue badge)
   - `@yahoo.com`, `@yahoo.in`, `@yahoo.co.in`, `@ymail.com` → Provider_Category: "Yahoo" (purple badge)
   - `@outlook.com`, `@hotmail.com`, `@hotmail.in`, `@live.com`, `@live.in`, `@msn.com` → Provider_Category: "Outlook" (blue badge)
   - `@icloud.com`, `@me.com`, `@mac.com` → Provider_Category: "iCloud" (grey badge)
   - `@protonmail.com`, `@proton.me` → Provider_Category: "ProtonMail" (green badge)
   - `@zoho.com`, `@zohomail.com` → Provider_Category: "Zoho" (green badge)
   - `@rediffmail.com` → Provider_Category: "Rediff" (gold badge)
   - Any other domain (including institutional, corporate, edu) → Provider_Category: "Other" (grey badge)

2. WHEN an Unknown_Sender badge is displayed in the Mail_List or Sent_List, THE Dashboard SHALL show both the "Unknown" indicator and the Provider_Category badge side by side for that email address.

3. WHEN the Quick_Save_Modal is opened for a categorised Unknown_Sender, THE Dashboard SHALL pre-fill a read-only "Source" field in the modal showing the detected Provider_Category (e.g., "Gmail contact").

4. THE Provider_Category detection SHALL be case-insensitive on the domain part of the email address.

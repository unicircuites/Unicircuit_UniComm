# Design Document

## Feature: Outlook Unknown Sender Detection & Quick Contact Save

---

## Overview

This feature adds client-side unknown-sender detection to the Outlook section of `dashboard.html`, a new `POST /api/outlook/contacts` backend endpoint, and UI affordances (visual indicators, inline hints, a Quick Save modal) that let users save unknown senders as named Outlook contacts in one step.

Two additional capabilities are included:
- **Sent mail recipient scanning**: The Sent folder rows check `to`/`cc` recipient fields (not just the `from` field) against the Contacts_Cache, so users can save people they have emailed but never formally added as contacts.
- **Provider categorization**: Unknown email addresses are labelled with a provider badge ("Gmail", "Yahoo", "Edu", "Outlook Personal", "Other") derived from the email domain, giving users instant context before saving.

The design follows the existing patterns in the codebase:
- Backend: Express route in `backend/routes/outlook.js`, using `graph.graphPost` from `backend/services/msGraph.js`, protected by the `authenticate` middleware.
- Frontend: Vanilla JS inside `dashboard.html`, using the existing `notify()` toast helper, the existing modal pattern (`modal-overlay` / `modal`), and the existing `contactsCache` array that is already populated by `GET /api/outlook/contacts`.

---

## Architecture

### Component Map

```
dashboard.html
├── ContactResolver          (new — client-side module, ~80 lines)
│   ├── buildCache(contacts) → Map<normEmail, displayName>
│   ├── isUnknownSender(email) → boolean
│   └── getProviderCategory(email) → { label, badgeClass }
│
├── Mail List renderer       (modified — outlookRenderInbox / outlookRenderSent)
│   ├── Inbox rows: checks `from` field via renderSenderCell()
│   └── Sent rows:  checks `to`/`cc` fields via renderRecipientCell()
│       (unknown badge + provider badge + Add Contact button per unknown recipient)
│
├── Compose View             (modified — #compose-to input handler)
│   └── injects inline hint below To field
│
├── Reply View               (modified — reply panel render)
│   └── injects dismissible banner above reply editor
│
├── Sent Detail View         (modified — sent message detail render)
│   └── injects dismissible banner reading "Recipient not in Outlook Contacts"
│
├── Quick Save Modal         (new — #qs-modal)
│   ├── HTML markup (added to modal section of dashboard.html)
│   ├── Includes read-only "Source" field showing Provider_Category
│   └── JS: openQuickSaveModal(email), submitQuickSave()
│
└── Cache Refresh            (modified — existing outlookLoadContacts())
    └── calls ContactResolver.buildCache() after every contacts fetch

backend/routes/outlook.js
└── POST /api/outlook/contacts   (new route, ~40 lines)
    └── validates body → graph.graphPost('/me/contacts', …) → 201 response
```

---

## Detailed Design

### 1. ContactResolver (Client-Side)

A plain JavaScript object added to `dashboard.html` in the existing script block, near the top of the Outlook section JS.

```js
const ContactResolver = (() => {
  // Map<normalised-lowercase-email, displayName-string>
  let _cache = new Map();

  function _norm(email) {
    return String(email || '').trim().toLowerCase();
  }

  /** Call after every GET /api/outlook/contacts response. */
  function buildCache(contacts) {
    _cache = new Map();
    for (const c of (contacts || [])) {
      const addrs = (c.emailAddresses || []).map(e => e && e.address).filter(Boolean);
      const dn    = (c.displayName || '').trim();
      for (const addr of addrs) {
        const key = _norm(addr);
        if (key) _cache.set(key, dn);
      }
    }
  }

  /**
   * Returns true when:
   *   (a) email is absent from the cache, OR
   *   (b) email is present but displayName is empty/null
   */
  function isUnknownSender(email) {
    const key = _norm(email);
    if (!key) return true;
    if (!_cache.has(key)) return true;          // absent
    const dn = _cache.get(key);
    return !dn;                                  // present but no displayName
  }

  /**
   * Returns a provider category object { label, badgeClass } based on the
   * email domain. Domain matching is case-insensitive.
   *
   * Rules:
   *   @gmail.com              → { label: 'Gmail',            badgeClass: 'b-blue'   }
   *   @yahoo.com / @yahoo.in  → { label: 'Yahoo',            badgeClass: 'b-purple' }
   *   @outlook.com / @hotmail.com / @live.com
   *                           → { label: 'Outlook Personal', badgeClass: 'b-blue'   }
   *   *.edu / *.ac.in / *.edu.in
   *                           → { label: 'Edu',              badgeClass: 'b-green'  }
   *   anything else           → { label: 'Other',            badgeClass: 'b-gray'   }
   */
  function getProviderCategory(email) {
    const domain = _norm(email).split('@')[1] || '';
    if (domain === 'gmail.com' || domain === 'googlemail.com')
      return { label: 'Gmail', badgeClass: 'b-blue' };
    if (domain === 'yahoo.com' || domain === 'yahoo.in' || domain === 'yahoo.co.in' || domain === 'ymail.com')
      return { label: 'Yahoo', badgeClass: 'b-purple' };
    if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'hotmail.in' || domain === 'live.com' || domain === 'live.in' || domain === 'msn.com')
      return { label: 'Outlook', badgeClass: 'b-blue' };
    if (domain === 'icloud.com' || domain === 'me.com' || domain === 'mac.com')
      return { label: 'iCloud', badgeClass: 'b-gray' };
    if (domain === 'protonmail.com' || domain === 'proton.me')
      return { label: 'ProtonMail', badgeClass: 'b-green' };
    if (domain === 'zoho.com' || domain === 'zohomail.com')
      return { label: 'Zoho', badgeClass: 'b-green' };
    if (domain === 'rediffmail.com')
      return { label: 'Rediff', badgeClass: 'b-gold' };
    return { label: 'Other', badgeClass: 'b-gray' };
  }

  return { buildCache, isUnknownSender, getProviderCategory };
})();
```

**Integration point:** The existing `outlookLoadContacts()` function already fetches `GET /api/outlook/contacts` and stores the result in a `contactsCache` array. After that assignment, add:

```js
ContactResolver.buildCache(contactsCache);
```

---

### 2. POST /api/outlook/contacts — Backend Endpoint

Added to `backend/routes/outlook.js` after the existing `GET /contacts` route.

```js
// ── POST /api/outlook/contacts ────────────────────────────────────────────
router.post('/contacts', async (req, res) => {
  const { displayName, email, givenName, surname, mobilePhone, companyName } = req.body;

  if (!displayName || !email) {
    return res.status(400).json({ error: 'displayName and email are required' });
  }

  const body = {
    displayName,
    emailAddresses: [{ address: email, name: displayName }],
    ...(givenName    ? { givenName }    : {}),
    ...(surname      ? { surname }      : {}),
    ...(mobilePhone  ? { mobilePhone }  : {}),
    ...(companyName  ? { companyName }  : {}),
  };

  try {
    const created = await graph.graphPost('/me/contacts', body, MS_EMAIL);
    return res.status(201).json({
      id:             created.id,
      displayName:    created.displayName,
      emailAddresses: created.emailAddresses,
    });
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') {
      return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    }
    return res.status(502).json({ error: err.message });
  }
});
```

**Note:** The route is placed after `router.use(authenticate)` so JWT protection is inherited automatically — no extra middleware call needed.

---

### 3. Quick Save Modal — HTML

Added to the modal section of `dashboard.html` alongside the existing modals:

```html
<!-- Quick Save Contact Modal -->
<div class="modal-overlay" id="qs-modal-overlay">
  <div class="modal" style="max-width:420px;">
    <div class="modal-title">
      <span><i class="fa fa-user-plus" style="color:var(--gold);margin-right:8px;"></i>Add to Outlook Contacts</span>
      <span class="modal-close" onclick="closeQuickSaveModal()"><i class="fa fa-times"></i></span>
    </div>
    <div class="form-group">
      <label class="form-label">Email Address</label>
      <input id="qs-email" class="inp" type="email" readonly style="opacity:0.7;cursor:default;">
    </div>
    <!-- Source field: shown only for unknown senders; read-only provider category -->
    <div class="form-group" id="qs-source-group" style="display:none;">
      <label class="form-label">Source <span style="color:var(--muted);">(detected)</span></label>
      <input id="qs-source" class="inp" type="text" readonly style="opacity:0.6;cursor:default;">
    </div>
    <div class="form-group">
      <label class="form-label">Display Name <span style="color:var(--red2);">*</span></label>
      <input id="qs-displayname" class="inp" type="text" placeholder="e.g. Vibha Sharma" autocomplete="off">
      <div id="qs-dn-error" style="color:var(--red2);font-size:11.5px;margin-top:4px;display:none;">Display name is required</div>
    </div>
    <div class="form-row">
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label">First Name <span style="color:var(--muted);">(optional)</span></label>
        <input id="qs-firstname" class="inp" type="text" placeholder="Vibha">
      </div>
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label">Last Name <span style="color:var(--muted);">(optional)</span></label>
        <input id="qs-lastname" class="inp" type="text" placeholder="Sharma">
      </div>
    </div>
    <div id="qs-api-error" style="color:var(--red2);font-size:12px;margin-top:10px;display:none;"></div>
    <div style="display:flex;gap:10px;margin-top:18px;justify-content:flex-end;">
      <button class="btn btn-ghost" onclick="closeQuickSaveModal()">Cancel</button>
      <button class="btn btn-gold" id="qs-submit-btn" onclick="submitQuickSave()">
        <i class="fa fa-save"></i> Save Contact
      </button>
    </div>
  </div>
</div>
```

The `#qs-source-group` div is hidden by default and shown by `openQuickSaveModal()` only when the email is classified as an Unknown_Sender. The `#qs-source` input is populated with the provider category label (e.g., "Gmail contact").

---

### 4. Quick Save Modal — JavaScript

```js
function openQuickSaveModal(email) {
  document.getElementById('qs-email').value        = email || '';
  document.getElementById('qs-displayname').value  = '';
  document.getElementById('qs-firstname').value    = '';
  document.getElementById('qs-lastname').value     = '';
  document.getElementById('qs-dn-error').style.display  = 'none';
  document.getElementById('qs-api-error').style.display = 'none';
  document.getElementById('qs-submit-btn').disabled     = false;
  document.getElementById('qs-submit-btn').innerHTML    = '<i class="fa fa-save"></i> Save Contact';

  // Populate provider category Source field for unknown senders
  const sourceGroup = document.getElementById('qs-source-group');
  if (email && ContactResolver.isUnknownSender(email)) {
    const { label } = ContactResolver.getProviderCategory(email);
    document.getElementById('qs-source').value = label + ' contact';
    sourceGroup.style.display = 'block';
  } else {
    document.getElementById('qs-source').value = '';
    sourceGroup.style.display = 'none';
  }

  document.getElementById('qs-modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('qs-displayname').focus(), 80);
}

function closeQuickSaveModal() {
  document.getElementById('qs-modal-overlay').classList.remove('open');
}

async function submitQuickSave() {
  const email       = document.getElementById('qs-email').value.trim();
  const displayName = document.getElementById('qs-displayname').value.trim();
  const givenName   = document.getElementById('qs-firstname').value.trim();
  const surname     = document.getElementById('qs-lastname').value.trim();

  // Validate display name
  if (!displayName) {
    document.getElementById('qs-dn-error').style.display = 'block';
    document.getElementById('qs-displayname').focus();
    return;
  }
  document.getElementById('qs-dn-error').style.display = 'none';

  // Validate email format (RFC 5321 local-part@domain)
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    document.getElementById('qs-api-error').textContent = 'Enter a valid email address';
    document.getElementById('qs-api-error').style.display = 'block';
    return;
  }

  // Loading state
  const btn = document.getElementById('qs-submit-btn');
  btn.disabled   = true;
  btn.innerHTML  = '<span class="spin-loader"></span> Saving…';
  document.getElementById('qs-api-error').style.display = 'none';

  try {
    const payload = { displayName, email };
    if (givenName) payload.givenName = givenName;
    if (surname)   payload.surname   = surname;

    const res = await fetch('/api/outlook/contacts', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body:    JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    closeQuickSaveModal();
    notify('Contact saved to Outlook', 'success');

    // Refresh contacts cache so the new contact is immediately recognised
    await outlookLoadContacts();

  } catch (err) {
    btn.disabled  = false;
    btn.innerHTML = '<i class="fa fa-save"></i> Save Contact';
    document.getElementById('qs-api-error').textContent = err.message;
    document.getElementById('qs-api-error').style.display = 'block';
  }
}
```

**`getToken()`** — the existing dashboard already stores the JWT in `localStorage` or a module-level variable. Use the same accessor already used by other `fetch` calls in the Outlook section (e.g., the pattern used in `outlookSend()`).

---

### 5. Mail List — Unknown Sender / Recipient Badge

#### Inbox rows — check `from` field

In the existing `outlookRenderInbox()` function, the sender name cell is currently rendered as plain text. Modify to call `renderSenderCell()`:

```js
/**
 * Renders the sender cell for an INBOX row.
 * Checks the `from` email address against the Contacts_Cache.
 */
function renderSenderCell(email, displayName) {
  if (ContactResolver.isUnknownSender(email)) {
    const { label, badgeClass } = ContactResolver.getProviderCategory(email);
    return `
      <span style="color:var(--muted2);">${escHtml(email)}</span>
      <span class="badge b-gold" style="margin-left:6px;font-size:9.5px;">
        <i class="fa fa-user-question" style="font-size:9px;"></i> Unknown
      </span>
      <span class="badge ${badgeClass}" style="margin-left:4px;font-size:9.5px;">${escHtml(label)}</span>
      <button class="btn btn-xs btn-ghost" style="margin-left:6px;padding:2px 7px;"
              onclick="openQuickSaveModal('${escHtml(email)}')" title="Add to Contacts">
        <i class="fa fa-user-plus"></i>
      </button>`;
  }
  const name = displayName || email;
  return `<span>${escHtml(name)}</span>`;
}
```

#### Sent rows — check `to`/`cc` fields

In the existing `outlookRenderSent()` function, iterate over the recipients array instead of the `from` field. For each unknown recipient, render a badge + button. Known recipients are rendered as their display name.

```js
/**
 * Renders the recipient cell for a SENT row.
 * Checks each address in the `to` and `cc` arrays against the Contacts_Cache.
 * Returns HTML for all recipients, flagging unknown ones.
 */
function renderRecipientCell(toAddresses, ccAddresses) {
  const all = [...(toAddresses || []), ...(ccAddresses || [])];
  if (!all.length) return '<span style="color:var(--muted);">—</span>';

  return all.map(addr => {
    const email = (addr.emailAddress || addr).address || addr;
    const dn    = (addr.emailAddress || addr).name   || '';
    if (ContactResolver.isUnknownSender(email)) {
      const { label, badgeClass } = ContactResolver.getProviderCategory(email);
      return `
        <span style="color:var(--muted2);">${escHtml(email)}</span>
        <span class="badge b-gold" style="margin-left:4px;font-size:9.5px;">
          <i class="fa fa-user-question" style="font-size:9px;"></i> Unknown
        </span>
        <span class="badge ${badgeClass}" style="margin-left:4px;font-size:9.5px;">${escHtml(label)}</span>
        <button class="btn btn-xs btn-ghost" style="margin-left:4px;padding:2px 7px;"
                onclick="openQuickSaveModal('${escHtml(email)}')" title="Add to Contacts">
          <i class="fa fa-user-plus"></i>
        </button>`;
    }
    return `<span>${escHtml(dn || email)}</span>`;
  }).join('<span style="color:var(--muted);margin:0 4px;">·</span>');
}
```

Both buttons are inline and use `btn-xs btn-ghost` — the same size class used elsewhere in the mail list action buttons — so they do not alter row height.

---

### 6. Compose View — Inline Hint

In the `#compose-to` input's `input` event handler (or `blur` handler), add:

```js
document.getElementById('compose-to').addEventListener('input', function () {
  const email = this.value.trim();
  const hint  = document.getElementById('compose-unknown-hint');
  if (email && ContactResolver.isUnknownSender(email)) {
    hint.innerHTML = `Not in Outlook Contacts — <a href="#" onclick="openQuickSaveModal('${escHtml(email)}');return false;" style="color:var(--gold);">Add Contact</a>`;
    hint.style.display = 'block';
  } else {
    hint.style.display = 'none';
  }
});
```

The hint `<div id="compose-unknown-hint">` is added directly below the `#compose-to` input in the compose modal HTML, styled with `font-size:11.5px; color:var(--muted2); margin-top:4px; display:none;`.

---

### 7. Reply View — Dismissible Banner

When the reply panel is rendered for a message, after injecting the reply editor HTML, add:

```js
function injectReplyUnknownBanner(senderEmail, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const existing = container.querySelector('.reply-unknown-banner');
  if (existing) existing.remove();
  if (!ContactResolver.isUnknownSender(senderEmail)) return;

  const banner = document.createElement('div');
  banner.className = 'reply-unknown-banner';
  banner.style.cssText = 'background:rgba(245,166,35,0.08);border:1px solid rgba(245,166,35,0.2);border-radius:8px;padding:9px 14px;margin-bottom:10px;display:flex;align-items:center;gap:10px;font-size:12.5px;';
  banner.innerHTML = `
    <i class="fa fa-circle-exclamation" style="color:var(--gold);"></i>
    <span style="flex:1;color:var(--muted2);">Sender not in Outlook Contacts</span>
    <button class="btn btn-xs btn-gold" onclick="openQuickSaveModal('${escHtml(senderEmail)}')">
      <i class="fa fa-user-plus"></i> Add Contact
    </button>
    <button class="btn btn-xs btn-ghost" onclick="this.closest('.reply-unknown-banner').remove()" title="Dismiss">
      <i class="fa fa-times"></i>
    </button>`;
  container.prepend(banner);
}
```

**Sent message detail view**: When rendering the detail view for a sent message, use the same banner helper but adapt the text to read "Recipient not in Outlook Contacts" and pass the recipient email address instead of the sender email. The banner is injected above the message body or reply editor in the sent detail view.

---

### 8. Contacts Directory — "No Name Saved" Label

In the existing contact card render function, modify the title/subtitle logic:

```js
function renderContactCardTitle(contact) {
  const dn    = (contact.displayName || '').trim();
  const email = ((contact.emailAddresses || [])[0] || {}).address || '';

  if (!dn) {
    // No display name — show email as title + "No name saved" label
    return `
      <div style="font-weight:600;font-size:13px;color:var(--text);">${escHtml(email)}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:2px;">No name saved</div>
      <button class="btn btn-xs btn-gold" style="margin-top:6px;"
              onclick="openQuickSaveModal('${escHtml(email)}')">
        <i class="fa fa-user-plus"></i> Add Name
      </button>`;
  }

  return `
    <div style="font-weight:600;font-size:13px;color:var(--text);">${escHtml(dn)}</div>
    <div style="font-size:11px;color:var(--muted);margin-top:2px;">${escHtml(email)}</div>`;
}
```

---

### 9. Cache Refresh After Save

`outlookLoadContacts()` already re-fetches `GET /api/outlook/contacts` and repopulates `contactsCache`. After the save succeeds in `submitQuickSave()`, calling `await outlookLoadContacts()` is sufficient. That function must also:

1. Call `ContactResolver.buildCache(contactsCache)` — already covered in §1.
2. Re-render the currently visible mail list — add a call to `outlookRenderInbox()` or `outlookRenderSent()` (whichever tab is active) after the cache rebuild. Both functions now use `renderSenderCell()` / `renderRecipientCell()` which re-evaluate the updated cache.
3. Re-evaluate the compose hint — the `input` event handler re-checks on every keystroke, so no extra action needed; the hint will clear on the next input event or on the next time the compose modal opens.

---

## Data Flow

```
User clicks "Add Contact" (mail list / sent list / compose / reply / contacts directory)
  → openQuickSaveModal(email)
      → ContactResolver.isUnknownSender(email) → true
      → ContactResolver.getProviderCategory(email) → { label, badgeClass }
      → #qs-source populated with "<label> contact" (e.g. "Gmail contact")
  → User fills Display Name → clicks "Save Contact"
  → submitQuickSave()
      → POST /api/outlook/contacts  { displayName, email, … }
          → graph.graphPost('/me/contacts', body, MS_EMAIL)
          → Graph API returns 201 { id, displayName, emailAddresses }
      → 201 response received
      → closeQuickSaveModal()
      → notify('Contact saved to Outlook', 'success')
      → outlookLoadContacts()
          → GET /api/outlook/contacts
          → contactsCache = response
          → ContactResolver.buildCache(contactsCache)
          → re-render active mail list tab (inbox: renderSenderCell / sent: renderRecipientCell)

Sent folder row render:
  outlookRenderSent(messages)
    → for each message: renderRecipientCell(msg.toRecipients, msg.ccRecipients)
        → for each recipient address: ContactResolver.isUnknownSender(addr)
            → if unknown: show Unknown badge + getProviderCategory badge + Add Contact button
            → if known:   show display name
```

---

## Error Handling

| Scenario | Backend response | Frontend behaviour |
|---|---|---|
| Missing `displayName` or `email` | 400 `{ error: "displayName and email are required" }` | Inline validation before fetch; never reaches backend |
| Graph API error (duplicate, permission) | 502 `{ error: "<Graph message>" }` | Error shown inside modal; modal stays open |
| Not authenticated | 401 `{ error: "NOT_AUTHENTICATED" }` | Error shown inside modal |
| Empty display name (client) | — | Inline `qs-dn-error` shown; form not submitted |
| Invalid email format (client) | — | `qs-api-error` shown; form not submitted |

---

## Correctness Properties

### Property 1 — Cache lookup is case-insensitive (Invariant)

For any contact with email `E` and non-empty `displayName`, `isUnknownSender(E)`, `isUnknownSender(E.toUpperCase())`, and `isUnknownSender(E.toLowerCase())` must all return `false`.

```
∀ contact c with non-empty displayName, ∀ case-variant v of c.email:
  ContactResolver.buildCache([c])
  ContactResolver.isUnknownSender(v) === false
```

### Property 2 — Absent email is always unknown (Invariant)

For any email address not present in the contacts list passed to `buildCache`, `isUnknownSender` must return `true`.

```
∀ email E not in contacts:
  ContactResolver.buildCache(contacts)
  ContactResolver.isUnknownSender(E) === true
```

### Property 3 — Empty displayName → unknown (Invariant)

For any contact whose `displayName` is empty or null, `isUnknownSender` must return `true` for that contact's email.

```
∀ contact c where (c.displayName === '' || c.displayName == null):
  ContactResolver.buildCache([c])
  ContactResolver.isUnknownSender(c.emailAddresses[0].address) === true
```

### Property 4 — Non-empty displayName → known (Invariant / Round-trip)

For any contact with a non-empty `displayName` (regardless of its value), `isUnknownSender` must return `false`. This is the key correctness property that fixes the "Vibha" case.

```
∀ contact c where c.displayName.trim().length > 0:
  ContactResolver.buildCache([c])
  ContactResolver.isUnknownSender(c.emailAddresses[0].address) === false
```

### Property 5 — Cache rebuild is idempotent (Idempotence)

Calling `buildCache` twice with the same input produces the same `isUnknownSender` results as calling it once.

```
∀ contacts list L, ∀ email E:
  buildCache(L); result1 = isUnknownSender(E)
  buildCache(L); result2 = isUnknownSender(E)
  result1 === result2
```

### Property 6 — Save → refresh → known (Round-trip)

After saving a contact with a non-empty `displayName` and refreshing the cache, `isUnknownSender` must return `false` for that email.

```
∀ email E, displayName D (non-empty):
  POST /api/outlook/contacts { email: E, displayName: D } → 201
  outlookLoadContacts() → ContactResolver.buildCache(newCache)
  ContactResolver.isUnknownSender(E) === false
```

### Property 7 — Email format validation (Error Conditions)

For any string that does not match `local-part@domain.tld`, `submitQuickSave` must not call `POST /api/outlook/contacts` and must display the validation error.

```
∀ string S where S does not match /^[^\s@]+@[^\s@]+\.[^\s@]+$/:
  submitQuickSave() with email=S → no fetch call, qs-api-error visible
```

### Property 8 — Provider category is case-insensitive (Invariant)

For any email address, `getProviderCategory` must return the same label regardless of the case of the domain portion.

```
∀ email E:
  getProviderCategory(E).label === getProviderCategory(E.toUpperCase()).label
  getProviderCategory(E).label === getProviderCategory(E.toLowerCase()).label
```

### Property 9 — Every unknown email has a provider category (Invariant)

For any email address classified as an Unknown_Sender, `getProviderCategory` must return a non-empty label and a valid badge class.

```
∀ email E where isUnknownSender(E) === true:
  const { label, badgeClass } = getProviderCategory(E)
  label.length > 0
  ['b-blue', 'b-purple', 'b-green', 'b-gray'].includes(badgeClass)
```

### Property 10 — Sent recipient scanning covers all To and CC addresses (Invariant)

For any sent message with N recipients across To and CC, `renderRecipientCell` must evaluate exactly N addresses and produce N rendered segments.

```
∀ message M with toRecipients T and ccRecipients C:
  segments = renderRecipientCell(T, C).split('·').length
  segments === T.length + C.length
```

---

## Files to Modify

| File | Change |
|---|---|
| `backend/routes/outlook.js` | Add `POST /api/outlook/contacts` route (~40 lines) |
| `dashboard.html` | Add `ContactResolver` object (with `buildCache`, `isUnknownSender`, `getProviderCategory`), `openQuickSaveModal` / `closeQuickSaveModal` / `submitQuickSave` functions, Quick Save Modal HTML (with Source field), `renderSenderCell` helper (inbox — checks `from`), `renderRecipientCell` helper (sent — checks `to`/`cc`), compose hint HTML + handler, reply banner helper, sent detail banner, contacts directory card title update, `outlookLoadContacts` post-fetch hook |

No new files, no new npm dependencies, no schema changes.

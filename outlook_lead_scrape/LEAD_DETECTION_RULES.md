# Lead Detection Rules — Unicircuit Engineering Services LLP

Reference dictionary for the Base44 brain module. Company sells **biometric machines, CCTV, access control, attendance systems, and related engineering services** in India (Mumbai-based).

---

## High-Confidence Lead Sources

### IndiaMART / B2B Portals
- Sender domains: `@indiamart.com`, `@tradeindia.com`, `@exportersindia.com`, `@justdial.com`
- Subject patterns: `New Enquiry`, `Buyer Details`, `Requirement from`, `Lead Alert`
- Body often contains: buyer name, city, mobile, product name, quantity

### Direct Buyer Inquiries
- Keywords: `enquiry`, `inquiry`, `quotation`, `quote`, `rate`, `price`, `pricing`, `requirement`, `interested in`, `want to buy`, `need biometric`, `attendance machine`, `CCTV`, `access control`
- Hindi/Hinglish: `rate batao`, `quotation chahiye`, `machine chahiye`, `kitne ka hai`

### Tender / RFQ
- Keywords: `tender`, `RFQ`, `RFP`, `bid`, `procurement`, `PO`, `purchase order`

---

## NOT a Lead (Reject)

| Pattern | Reason |
|---|---|
| OTP, verification code, login alert | System mail |
| `noreply@`, `no-reply@` + no buyer context | Automated |
| Newsletter, unsubscribe, marketing blast | Not a sales lead |
| Internal mail `@unicircuites.com` / `@unicircuites.live` | Internal |
| Job application, resume, hiring | HR not sales |
| Payment receipt, invoice **from us to client** | Post-sale |
| Shipping/delivery notification only | Logistics |
| Social media notifications | Noise |
| "Your listing was viewed" without buyer contact | Low value |

---

## Field Extraction Rules

### `lead_name` (required)
Priority order:
1. Extracted buyer/contact person name from body (IndiaMART format: `Name: Rahul Sharma`)
2. `from_name` from email header
3. Company name from body + ` ji` suffix if Indian style (e.g. `Gupta ji — Biometric Machine`)
4. Fallback: `from_address` local-part formatted (last resort)

### `subject`
- Use email `subject` as-is (trimmed, max 300 chars)

### `contact_phone`
- Extract Indian mobiles: 10 digits starting 6–9
- Normalize: strip `+91`, spaces, dashes → store 10-digit string
- Prefer mobile labeled fields: `Mobile:`, `Phone:`, `Contact:`, `M:`
- If multiple numbers, pick the one in a "Contact" / "Mobile" label block

### `notes`
Structured summary (plain text, not JSON):
```
Source: outlook | Message: <graph_id>
From: <from_name> <<from_address>>
Product/Requirement: <extracted>
Location: <city if found>
Confidence: <high|medium|low> — <reason>
---
<body excerpt max 500 chars>
```

### `platform`
Always `'outlook'` for email-sourced leads.

### `lead_date` / `lead_time`
From `received_datetime` (IST-friendly; store as DATE + TIME in DB).

### `contact_tags`
Always include: `['outlook', 'auto-scrape']`
Add when applicable: `'indiamart'`, `'quotation'`, `'tender'`, `'repeat-buyer'`
Store source ref: `'msg:<message_id>'` (first 40 chars of id if long)

---

## Confidence Scoring

| Score | Criteria |
|---|---|
| **HIGH (≥ 0.85)** | Portal lead with name + phone + product OR direct buyer asking price/quote with contact |
| **MEDIUM (0.60–0.84)** | Clear product interest, missing phone OR missing name |
| **LOW (< 0.60)** | Weak keyword match only — **do not insert**, log for review |

**Insert threshold**: `confidence >= 0.75` OR (`confidence >= 0.60` AND sender is known portal domain).

---

## Deduplication

Skip insert if ANY of:
1. `outlook_lead_processed.message_id` already exists for this message
2. Existing lead with same `contact_phone` (via `phone_norm()`) AND similar `subject` (Levenshtein ≤ 3 or same first 30 chars) within 14 days
3. Same `from_address` + identical `subject` within 7 days

On duplicate with **new information** (e.g. phone added): UPDATE existing lead `notes` append-only, do not create second row.

---

## Product Keywords (Unicircuit Domain)

`biometric`, `attendance`, `fingerprint`, `face recognition`, `access control`, `CCTV`, `camera`, `DVR`, `NVR`, `time attendance`, `TA machine`, `eSSL`, `Matrix`, `Hikvision`, `turnstile`, `boom barrier`, `RFID`, `card reader`, `visitor management`

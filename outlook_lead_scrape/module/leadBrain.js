'use strict';

/**
 * leadBrain.js — UniComm Pro Outlook Lead Scrape: Classification & Extraction Brain
 * ----------------------------------------------------------------------------
 * Pure logic (no timers, no DB). Rules-first, AI-fallback (Groq via ollamaService).
 *
 * Exports:
 *   classifyLeadEmail(snapshot)              → { isLead, confidence, reason, tier, needsAi }
 *   extractLeadFields(snapshot, fullBody?)    → async → { isLead, confidence, reason, lead }
 *   classifyAndExtractRulesOnly(snapshot)    → sync fast path → { verdict, lead }
 *   extractIndianMobile(text)                → string|null
 *   stripHtml(html)                           → string
 */

// ─── Domain vocabularies ────────────────────────────────────────────────────
const PORTAL_DOMAINS = ['indiamart.com', 'tradeindia.com', 'exportersindia.com'];
const INTERNAL_DOMAINS = ['unicircuites.com', 'unicircuites.live'];
const SYSTEM_PREFIXES = ['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon'];

const PRODUCT_TERMS = [
  'biometric', 'cctv', 'attendance machine', 'time attendance', 'access control',
  'dvr', 'nvr', 'camera', 'voltage', 'stabilizer', 'ups', 'inverter', 'battery',
  'sensor', 'door lock', 'fingerprint', 'rfid', 'turnstile', 'boom barrier',
  'intercom', 'epabx', 'fire alarm', 'smoke detector', 'router', 'switch', 'server'
];

const LEAD_KEYWORDS = [
  'quotation', 'enquiry', 'inquiry', 'enquire', 'interested in', 'want to purchase',
  'want to buy', 'looking for', 'requirement', 'required', 'rate', 'price', 'pricing',
  'cost', 'estimate', 'need', 'purchase', 'order', 'dealer', 'supplier'
];

const HARD_REJECT_SUBJECT = [
  /\botp\b/i, /verification code/i, /password reset/i, /reset your password/i,
  /login alert/i, /security alert/i, /two.?factor/i, /sign.?in attempt/i,
  /newsletter/i, /unsubscribe/i, /your order has been shipped/i,
  /shipment status/i, /delivery confirmation/i
];

const BUYER_LABELS = ['name', 'buyer', 'contact person', 'contact name', 'customer name'];
const PHONE_LABELS = ['mobile', 'phone', 'contact no', 'contact number', 'mobile no', 'mobile number', 'phone no'];
const PRODUCT_LABELS = ['product', 'requirement', 'product name', 'requirement details', 'category'];
const LOCATION_LABELS = ['city', 'location'];

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Extract a normalized 10-digit Indian mobile number from free text.
 * Handles: +91-98765-43210, 91 9876543210, M:9876543210, 98200 12345, 9820012345
 * Returns null for landlines / non-mobile patterns.
 */
function extractIndianMobile(text) {
  if (!text) return null;
  // Core = 10 digits starting 6-9, optionally split by a single space/hyphen,
  // optionally prefixed by +91 / 00 91 / 0. Lookbehind/ahead prevent partial matches
  // inside longer digit runs.
  const re = /(?<!\d)(?:(?:\+|00)?91[\s\-]?)?(?:0)?([6-9]\d{4}[\s\-]?\d{5})(?!\d)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const digits = m[1].replace(/\D/g, '');
    if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) return digits;
  }
  return null;
}

/** Strip HTML to plain text with basic entity decoding. */
function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getDomain(fromAddress) {
  return (fromAddress || '').toLowerCase().split('@')[1] || '';
}

function isSystemSender(fromAddress) {
  const local = (fromAddress || '').toLowerCase().split('@')[0] || '';
  return SYSTEM_PREFIXES.some((p) => local.startsWith(p));
}

function isPersonName(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  if (PORTAL_DOMAINS.some((d) => n.includes(d.split('.')[0]))) return false;
  const brand = ['indiamart', 'tradeindia', 'exportersindia', 'sales', 'team', 'support',
    'noreply', 'notification', 'info', 'admin', 'marketing', 'donotreply'];
  if (brand.some((b) => n.includes(b))) return false;
  const words = name.trim().split(/\s+/);
  if (words.length < 1 || words.length > 5) return false;
  return words.every((w) => /^[A-Za-z][A-Za-z.'\-]*$/.test(w));
}

function cleanName(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(/[|,].*$/, '').trim().slice(0, 120);
}

function extractLabeled(body, labels, captureLen) {
  for (const label of labels) {
    const re = new RegExp(`\\b${label}\\s*[:\\-]\\s*([^\\n|]{1,${captureLen}})`, 'i');
    const m = body.match(re);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  return null;
}

function extractName(body, fromName) {
  const labeled = extractLabeled(body, BUYER_LABELS, 60);
  if (labeled) return cleanName(labeled);
  if (fromName && isPersonName(fromName)) return cleanName(fromName);
  return null;
}

function extractProduct(body, subject) {
  const labeled = extractLabeled(body, PRODUCT_LABELS, 80);
  if (labeled) return labeled;
  const lower = `${body} ${subject}`.toLowerCase();
  const found = PRODUCT_TERMS.filter((p) => lower.includes(p));
  return found.length ? found[0] : null;
}

function extractLocation(body) {
  return extractLabeled(body, LOCATION_LABELS, 40);
}

function confidenceLabel(c) {
  if (c >= 0.85) return 'high';
  if (c >= 0.7) return 'medium';
  return 'low';
}

// ─── AI fallback (optional, env-gated) ──────────────────────────────────────

function shouldUseAi() {
  const v = (process.env.LEAD_SCRAPE_USE_AI || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function loadOllama() {
  // Try a couple of likely relative paths; the integrator may adjust.
  const candidates = [
    '../../backend/services/ollamaService',
    '../../../backend/services/ollamaService',
    '../backend/services/ollamaService',
  ];
  for (const p of candidates) {
    try {
      const mod = require(p); // eslint-disable-line global-require
      if (mod && typeof mod.callOllamaService === 'function') return mod;
    } catch (e) { /* try next */ }
  }
  return null;
}

function safeJsonParse(s) {
  try {
    const m = String(s).match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) {
    return null;
  }
}

async function aiExtract(snapshot, bodyText) {
  const ollama = loadOllama();
  if (!ollama) return null;
  const prompt = `Extract sales lead fields from this email. Return ONLY valid JSON:
{"is_lead":true,"lead_name":"...","contact_phone":"10digits or null","product":"...","confidence":0.0-1.0,"reason":"..."}
If not a sales lead, return {"is_lead":false,"confidence":0.0,"reason":"..."}

Email:
From: ${snapshot.from_name || ''} <${snapshot.from_address || ''}>
Subject: ${snapshot.subject || ''}
Body: ${bodyText.slice(0, 2000)}`;
  try {
    const result = await ollama.callOllamaService(prompt, []);
    return typeof result === 'string' ? safeJsonParse(result) : result;
  } catch (e) {
    console.error('[OutlookLeadScrape] AI extraction failed:', e.message);
    return null;
  }
}

// ─── Classification ──────────────────────────────────────────────────────────

/**
 * Classify a mail snapshot. Pure, sync, no AI.
 * @returns { isLead, confidence, reason, tier, needsAi }
 */
function classifyLeadEmail(snapshot) {
  const subject = (snapshot.subject || '').trim();
  const fromAddr = (snapshot.from_address || '').toLowerCase();
  const body = stripHtml(snapshot.body_preview || '');
  const combined = `${subject}\n${body}`;
  const domain = getDomain(fromAddr);

  // Step 1 — Hard rejects
  if (snapshot.folder && snapshot.folder !== 'inbox') {
    return { isLead: false, confidence: 0, reason: `Folder not inbox (${snapshot.folder})`, tier: 'reject' };
  }

  const catStr = Array.isArray(snapshot.category) ? snapshot.category.join(' ').toLowerCase() : String(snapshot.category || '').toLowerCase();
  if (catStr.includes('lead')) {
    return { isLead: true, confidence: 0.95, reason: 'Tier-1: explicitly categorized as Lead in Outlook', tier: 'tier1' };
  }

  if (INTERNAL_DOMAINS.includes(domain)) {
    return { isLead: false, confidence: 0, reason: 'Internal sender domain', tier: 'reject' };
  }

  const hasBuyerBlock = BUYER_LABELS.some((l) => new RegExp(`\\b${l}:`, 'i').test(body));
  if (isSystemSender(fromAddr) && !hasBuyerBlock) {
    return { isLead: false, confidence: 0, reason: 'System/no-reply sender without buyer block', tier: 'reject' };
  }
  for (const re of HARD_REJECT_SUBJECT) {
    if (re.test(subject)) {
      return { isLead: false, confidence: 0, reason: `Hard reject: ${re.source}`, tier: 'reject' };
    }
  }
  if (/\botp\b/i.test(body) && /\b\d{4,8}\b/.test(body) && !hasBuyerBlock) {
    return { isLead: false, confidence: 0, reason: 'OTP/verification message', tier: 'reject' };
  }

  const phone = extractIndianMobile(combined);

  // Step 2 — Tier 1 (definite lead, confidence ≥ 0.90)
  const isPortal = PORTAL_DOMAINS.includes(domain);
  const isEnquirySubject = /new enquiry|buyer details|lead from indiamart|enquiry for|inquiry for/i.test(subject);
  if (isPortal || (isEnquirySubject && hasBuyerBlock) || (hasBuyerBlock && phone)) {
    return { isLead: true, confidence: 0.92, reason: 'Tier-1: portal / buyer block with contact', tier: 'tier1' };
  }

  // Tier 2 (probable lead, 0.70–0.89)
  const hasLeadKeyword = LEAD_KEYWORDS.some((k) => combined.toLowerCase().includes(k));
  const hasProduct = PRODUCT_TERMS.some((p) => combined.toLowerCase().includes(p));
  if (hasLeadKeyword && (hasProduct || phone)) {
    return { isLead: true, confidence: 0.78, reason: 'Tier-2: lead keyword + product/phone', tier: 'tier2' };
  }

  // Tier 3 (weak, 0.50–0.69) → AI candidate
  if (hasLeadKeyword || hasProduct) {
    return { isLead: true, confidence: 0.55, reason: 'Tier-3: weak signal, AI candidate', tier: 'tier3', needsAi: true };
  }

  return { isLead: false, confidence: 0.15, reason: 'No lead signals detected', tier: 'none', needsAi: true };
}

// ─── Field extraction (sync, rules-only) ────────────────────────────────────

function extractFieldsFromSnapshot(snapshot, verdict) {
  const body = stripHtml(snapshot.body_preview || '');
  const subject = (snapshot.subject || '').trim();
  const fromName = (snapshot.from_name || '').trim();
  const fromAddr = (snapshot.from_address || '').toLowerCase();

  const phone = extractIndianMobile(`${body}\n${subject}`);
  const name = extractName(body, fromName);
  const product = extractProduct(body, subject);
  const loc = extractLocation(body);

  const tags = ['outlook', 'auto-scrape'];
  const domain = getDomain(fromAddr);
  if (PORTAL_DOMAINS.includes(domain)) tags.push(domain.split('.')[0]);
  if (snapshot.id) tags.push(`msg:${snapshot.id}`);

  const conf = verdict.confidence;
  const header = [
    'Source: outlook',
    product ? `Product: ${product}` : null,
    name ? `Buyer: ${name}` : null,
    loc ? `Location: ${loc}` : null,
    `Confidence: ${confidenceLabel(conf)} — ${verdict.reason}`,
  ].filter(Boolean).join(' | ');
  const rawBody = snapshot.body_preview || '';
  let snippetToSave = body.slice(0, 800);
  
  if (rawBody.trim().toLowerCase().startsWith('<html') || rawBody.trim().toLowerCase().startsWith('<!doctype html>') || rawBody.trim().toLowerCase().startsWith('<div')) {
    snippetToSave = rawBody;
  }
  
  const notes = `${header}\n---\n${snippetToSave}`;

  let leadName = name || (product ? `${fromName || 'Buyer'} — ${product}` : fromName) || 'Outlook Lead';
  if (leadName.length > 200) leadName = leadName.slice(0, 200);

  const dt = snapshot.received_datetime ? new Date(snapshot.received_datetime) : new Date();
  const lead_date = dt.toISOString().slice(0, 10);
  const lead_time = dt.toTimeString().slice(0, 8);

  return {
    lead_name: leadName,
    subject: subject.slice(0, 300),
    notes,
    contact_phone: phone,
    contact_tags: tags,
    lead_date,
    lead_time,
    confidence: conf,
    reason: verdict.reason,
    product,
  };
}

/**
 * Sync fast path: classify + rules-only extraction in one call.
 */
function classifyAndExtractRulesOnly(snapshot) {
  const verdict = classifyLeadEmail(snapshot);
  if (!verdict.isLead && verdict.confidence === 0) {
    return { verdict, lead: null };
  }
  return { verdict, lead: extractFieldsFromSnapshot(snapshot, verdict) };
}

/**
 * Full extraction. Async because it may call AI fallback for ambiguous (tier-3) emails.
 * @returns { isLead, confidence, reason, lead }
 */
async function extractLeadFields(snapshot, fullBody) {
  const verdict = classifyLeadEmail(snapshot);

  // Hard reject — no lead, no AI.
  if (verdict.confidence === 0) {
    return { isLead: false, confidence: 0, reason: verdict.reason, lead: null };
  }

  // Use full body if provided (re-classify lightly with richer text for phone/product).
  const effectiveSnap = fullBody
    ? { ...snapshot, body_preview: fullBody }
    : snapshot;
  const lead = extractFieldsFromSnapshot(effectiveSnap, verdict);

  // AI fallback only for ambiguous tier-3 emails.
  if (verdict.needsAi && shouldUseAi() && lead.confidence < 0.75) {
    const ai = await aiExtract(snapshot, stripHtml(fullBody || snapshot.body_preview || ''));
    if (ai && ai.is_lead) {
      lead.contact_phone = lead.contact_phone || ai.contact_phone || null;
      lead.lead_name = lead.lead_name || ai.lead_name || null;
      lead.product = lead.product || ai.product || null;
      lead.confidence = Math.max(lead.confidence, Number(ai.confidence) || 0);
      lead.reason = `AI-assisted: ${ai.reason || verdict.reason}`;
    } else if (ai && ai.is_lead === false) {
      lead.confidence = Math.min(lead.confidence, Number(ai.confidence) || 0);
      lead.reason = `AI-rejected: ${ai.reason || verdict.reason}`;
    }
  }

  return { isLead: lead.confidence >= 0.5, confidence: lead.confidence, reason: lead.reason, lead };
}

module.exports = {
  classifyLeadEmail,
  extractLeadFields,
  classifyAndExtractRulesOnly,
  extractIndianMobile,
  stripHtml,
  // exposed for tests / service
  _internals: { extractName, extractProduct, extractLocation, isPersonName, PORTAL_DOMAINS },
};
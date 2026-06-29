/**
 * extractDeepFieldsWithAI.js
 * ------------------------------------------------------------------
 * Deep extraction backend: discovers ALL repeating record types and
 * preserves every field the AI finds (empty values kept as "").
 *
 * Response shape:
 * {
 *   page_title, source_url,
 *   navigation_links: [{ link_text, url }],
 *   record_types: [{ type_name, fields, records }]
 * }
 * ------------------------------------------------------------------
 */

const DEEP_SYSTEM_PROMPT = `You are a deep web data extraction agent. Parse raw HTML into structured data organized by every distinct repeating record type on the page.

Follow this internal pipeline before producing output. Do not output your reasoning — only the final JSON.

STEP 1 — SCHEMA DISCOVERY:
Scan the HTML and identify every distinct repeating DOM structure (e.g. team members, testimonials, services, products, contact cards, blog posts, pricing tiers, locations). Assign each a short snake_case type_name (e.g. "team_members", "testimonials", "services").

STEP 2 — FIELD DISCOVERY:
For each record type, list EVERY distinct data field visible in that structure: names, titles, emails, phones, URLs, addresses, dates, descriptions, image URLs, ratings, prices, tags, etc. Include ALL fields even when some rows lack a value. Use descriptive snake_case field names. Do not drop fields because they look like UI chrome inside the repeating block — capture what is there.

STEP 3 — NAVIGATION CAPTURE:
Collect links that are site navigation only (menus, breadcrumbs, pagination, footer sitemap, "load more", category links). These must NEVER appear inside record_types.

STEP 4 — ARRAY EXTRACTION:
For each record type, extract every instance found. Every record object must include every field declared in that type's fields array. Use an empty string "" for genuinely missing values — never omit a key. Do not fabricate data not present in the HTML.

If the page has B2B lead/contact data, include it as one or more record types (e.g. "leads", "contacts", "companies") with all contact attributes found.

OUTPUT FORMAT — respond with ONLY a single valid JSON object (no markdown fences, no commentary):

{
  "page_title": "string",
  "source_url": "string",
  "navigation_links": [
    { "link_text": "string", "url": "string" }
  ],
  "record_types": [
    {
      "type_name": "snake_case_name",
      "fields": ["field_a", "field_b"],
      "records": [
        { "field_a": "value", "field_b": "" }
      ]
    }
  ]
}

If no repeating data exists, return record_types as an empty array. If no navigation links exist, return an empty array for navigation_links.`;

const DISCOVER_VARIABLE_FIELDS_PROMPT = `You are a web page schema analyst. Your job is to discover REPEATING DATA PATTERNS and identify VARIABLE FIELDS — data attributes that appear across most repeated instances on the page.

Follow this internal pipeline. Do not output your reasoning — only the final JSON.

STEP 1 — REPEATING PATTERN DISCOVERY:
Scan the HTML and find every distinct repeating DOM structure (contact cards, table rows, list items, product tiles, team members, etc.). Assign each a snake_case type_name.

STEP 2 — VARIABLE FIELD IDENTIFICATION:
For each repeating pattern, identify which data fields are VARIABLE FIELDS — fields whose values repeat across multiple instances (e.g. name, email, phone in a contact list). Exclude one-off page chrome, navigation text, and button labels.
For each variable field provide:
  - field_name (snake_case)
  - repeat_score (0-100): how consistently this field appears across instances (100 = in every instance)
  - sample_value: one example value from the HTML (truncated to 80 chars)

STEP 3 — NAVIGATION CAPTURE:
Collect site navigation links separately (menus, pagination, breadcrumbs). Never include these as variable fields.

Do NOT extract full record arrays. Only discover schema and variable fields.

OUTPUT FORMAT — respond with ONLY a single valid JSON object:

{
  "page_title": "string",
  "source_url": "string",
  "navigation_links": [
    { "link_text": "string", "url": "string" }
  ],
  "record_types": [
    {
      "type_name": "snake_case_name",
      "estimated_record_count": 0,
      "variable_fields": [
        { "field_name": "name", "repeat_score": 95, "sample_value": "Jane Doe" }
      ]
    }
  ]
}`;

const EXTRACT_SELECTED_FIELDS_PROMPT = `You are a deep web data extraction agent. Extract structured records from HTML using ONLY the field lists provided per record type.

Rules:
- Extract every instance of each record type found in the HTML.
- Include ONLY the fields listed for that type. Do not add extra fields.
- Use empty string "" for missing values — never omit a key.
- Do not fabricate data not present in the HTML.
- Collect navigation links separately — never inside record_types.

OUTPUT FORMAT — respond with ONLY a single valid JSON object:

{
  "page_title": "string",
  "source_url": "string",
  "navigation_links": [{ "link_text": "string", "url": "string" }],
  "record_types": [
    {
      "type_name": "snake_case_name",
      "fields": ["field_a", "field_b"],
      "records": [{ "field_a": "value", "field_b": "" }]
    }
  ]
}`;

function extractJsonBlock(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    throw new Error('extractJsonBlock: LLM response was empty or not text');
  }

  let text = rawText.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('extractJsonBlock: no JSON object found in LLM response');
  }

  const jsonCandidate = text.slice(firstBrace, lastBrace + 1);
  let parsed;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch (err) {
    throw new Error(`extractJsonBlock: failed to parse JSON: ${err.message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('extractJsonBlock: parsed JSON is not a plain object');
  }

  return parsed;
}

function sanitizeNavigationLinks(rawLinks) {
  if (!Array.isArray(rawLinks)) return [];
  return rawLinks
    .filter(
      (link) =>
        link &&
        typeof link === 'object' &&
        typeof link.url === 'string' &&
        link.url.trim() !== ''
    )
    .map((link) => ({
      link_text: typeof link.link_text === 'string' ? link.link_text.trim() : '',
      url: link.url.trim(),
    }));
}

/**
 * Preserves ALL fields, even if values are empty (stored as "").
 */
function sanitizeRecord(rawRow, declaredFields) {
  if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) return null;

  const cleaned = {};
  (declaredFields || []).forEach((field) => {
    cleaned[field] = '';
  });

  for (const [key, value] of Object.entries(rawRow)) {
    if (value === null || value === undefined) {
      cleaned[key] = '';
    } else {
      cleaned[key] = String(value).trim();
    }
  }

  return cleaned;
}

/**
 * Preserves the AI's original field list per record type.
 */
function sanitizeRecordTypes(rawRecordTypes) {
  if (!Array.isArray(rawRecordTypes)) return [];

  return rawRecordTypes
    .map((rt) => {
      if (!rt || typeof rt !== 'object') return null;

      const typeName =
        typeof rt.type_name === 'string' && rt.type_name.trim() !== ''
          ? rt.type_name.trim()
          : null;
      if (!typeName) return null;

      const fields = Array.isArray(rt.fields)
        ? rt.fields.map((f) => String(f).trim()).filter((f) => f !== '')
        : [];

      let finalFields = fields;
      if (finalFields.length === 0) {
        const rawRecords = Array.isArray(rt.records) ? rt.records : [];
        const allKeys = new Set();
        rawRecords.forEach((record) => {
          if (record && typeof record === 'object') {
            Object.keys(record).forEach((k) => allKeys.add(k));
          }
        });
        finalFields = Array.from(allKeys);
      }

      const rawRecords = Array.isArray(rt.records) ? rt.records : [];
      const cleanedRecords = rawRecords
        .map((record) => sanitizeRecord(record, finalFields))
        .filter(Boolean);

      if (cleanedRecords.length === 0 && finalFields.length === 0) {
        return null;
      }

      const normalizedRecords = cleanedRecords.map((record) => {
        const normalized = { ...record };
        finalFields.forEach((field) => {
          if (!(field in normalized)) {
            normalized[field] = '';
          }
        });
        return normalized;
      });

      return {
        type_name: typeName,
        fields: finalFields,
        records: normalizedRecords.length > 0 ? normalizedRecords : [{}],
      };
    })
    .filter(Boolean);
}

function sanitizeVariableFields(rawFields) {
  if (!Array.isArray(rawFields)) return [];
  return rawFields
    .map((field) => {
      if (!field || typeof field !== 'object') return null;
      const fieldName =
        typeof field.field_name === 'string'
          ? field.field_name.trim()
          : typeof field.name === 'string'
            ? field.name.trim()
            : '';
      if (!fieldName) return null;
      const repeatScore = Number(field.repeat_score);
      return {
        field_name: fieldName,
        repeat_score: Number.isFinite(repeatScore)
          ? Math.max(0, Math.min(100, Math.round(repeatScore)))
          : 50,
        sample_value:
          typeof field.sample_value === 'string'
            ? field.sample_value.trim().slice(0, 80)
            : '',
      };
    })
    .filter(Boolean);
}

function sanitizeDiscoveryRecordTypes(rawRecordTypes) {
  if (!Array.isArray(rawRecordTypes)) return [];

  return rawRecordTypes
    .map((rt) => {
      if (!rt || typeof rt !== 'object') return null;
      const typeName =
        typeof rt.type_name === 'string' && rt.type_name.trim() !== ''
          ? rt.type_name.trim()
          : null;
      if (!typeName) return null;

      let variableFields = sanitizeVariableFields(rt.variable_fields);
      if (variableFields.length === 0 && Array.isArray(rt.fields)) {
        variableFields = rt.fields.map((f) => ({
          field_name: String(f).trim(),
          repeat_score: 80,
          sample_value: '',
        })).filter((f) => f.field_name);
      }

      const estimatedCount = Number(rt.estimated_record_count);
      return {
        type_name: typeName,
        estimated_record_count: Number.isFinite(estimatedCount) ? Math.max(0, estimatedCount) : 0,
        variable_fields: variableFields,
      };
    })
    .filter((rt) => rt && rt.variable_fields.length > 0);
}

function discoveryToSelectableRecordTypes(discoveryTypes) {
  return (discoveryTypes || []).map((rt) => ({
    type_name: rt.type_name,
    fields: rt.variable_fields.map((f) => f.field_name),
    records: [],
    variable_fields: rt.variable_fields,
    estimated_record_count: rt.estimated_record_count,
  }));
}

function filterRecordTypesBySelectedFields(recordTypes, selectedFieldsByType) {
  if (!selectedFieldsByType || typeof selectedFieldsByType !== 'object') {
    return recordTypes;
  }

  return (recordTypes || [])
    .map((rt) => {
      const selected = selectedFieldsByType[rt.type_name];
      if (!Array.isArray(selected) || selected.length === 0) return null;
      const selectedSet = new Set(selected.map((f) => String(f).trim()).filter(Boolean));
      const fields = rt.fields.filter((f) => selectedSet.has(f));
      if (fields.length === 0) return null;
      const records = rt.records.map((record) => {
        const row = {};
        fields.forEach((field) => {
          row[field] = record[field] != null ? record[field] : '';
        });
        return row;
      });
      return { type_name: rt.type_name, fields, records };
    })
    .filter(Boolean);
}

function buildSelectedFieldsPrompt(selectedFieldsByType) {
  const lines = Object.entries(selectedFieldsByType || {})
    .filter(([, fields]) => Array.isArray(fields) && fields.length > 0)
    .map(([typeName, fields]) => `- ${typeName}: ${fields.join(', ')}`);
  return lines.length > 0
    ? `Extract ONLY these fields per record type:\n${lines.join('\n')}`
    : '';
}

function stripHtmlForAI(html) {
  try {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    doc.querySelectorAll('script, style, svg, noscript, path').forEach((el) => el.remove());
    return doc.body ? doc.body.innerHTML : doc.documentElement.innerHTML;
  } catch (_) {
    return html;
  }
}

const LEAD_TYPE_NAMES = new Set([
  'leads',
  'lead',
  'contacts',
  'contact',
  'people',
  'team_members',
  'team',
  'companies',
  'company',
  'clients',
]);

function pickPrimaryRecordType(recordTypes) {
  if (!Array.isArray(recordTypes) || recordTypes.length === 0) return null;

  const leadType = recordTypes.find((rt) => LEAD_TYPE_NAMES.has(rt.type_name.toLowerCase()));
  if (leadType && leadType.records.length > 0) return leadType;

  return recordTypes.reduce((best, rt) => {
    if (!best) return rt;
    return rt.records.length > best.records.length ? rt : best;
  }, null);
}

function flattenPrimaryRecords(recordTypes) {
  const primary = pickPrimaryRecordType(recordTypes);
  if (!primary) return [];
  return primary.records.map((record) => {
    const row = {};
    primary.fields.forEach((field) => {
      row[field] = record[field] != null ? record[field] : '';
    });
    return row;
  });
}

async function callExtractionLLM(systemPrompt, userContent, options = {}) {
  const apiKey = options.apiKey || process.env.AI_API_KEY;
  if (!apiKey) {
    throw new Error('AI_API_KEY is not configured');
  }

  const host = options.host || process.env.AI_API_HOST || 'https://api.groq.com/openai/v1';
  const model =
    options.model ||
    process.env.AI_FAST_MODEL ||
    process.env.AI_API_MODEL ||
    'llama-3.1-8b-instant';

  const response = await fetch(`${host}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a professional web data extraction assistant.' },
        { role: 'user', content: `${systemPrompt}\n\n${userContent}` },
      ],
      temperature: 0.2,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`LLM API request failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Run deep AI extraction against HTML.
 *
 * @param {string} html
 * @param {object} options
 * @param {string} [options.sourceUrl]
 * @param {number} [options.maxHtmlChars]
 * @returns {Promise<object>}
 */
async function extractDeepFieldsWithAI(html, options = {}) {
  const sourceUrl = options.sourceUrl || '';
  const maxHtmlChars = options.maxHtmlChars ?? 22000;
  const selectedFieldsByType = options.selectedFieldsByType || null;

  if (!html || typeof html !== 'string') {
    throw new Error('extractDeepFieldsWithAI: html must be a non-empty string');
  }

  const cleanHtml = stripHtmlForAI(html);
  const truncatedHtml =
    cleanHtml.length > maxHtmlChars ? cleanHtml.slice(0, maxHtmlChars) : cleanHtml;

  const fieldsConstraint = buildSelectedFieldsPrompt(selectedFieldsByType);
  const systemPrompt = fieldsConstraint
    ? `${EXTRACT_SELECTED_FIELDS_PROMPT}\n\n${fieldsConstraint}`
    : DEEP_SYSTEM_PROMPT;

  const userContent =
    `Source URL: ${sourceUrl || '(not provided)'}\n\n` +
    '---HTML START---\n' +
    truncatedHtml +
    '\n---HTML END---';

  const aiResponse = await callExtractionLLM(systemPrompt, userContent, options);
  const parsed = extractJsonBlock(aiResponse);

  const pageTitle = typeof parsed.page_title === 'string' ? parsed.page_title.trim() : '';
  const parsedSourceUrl =
    typeof parsed.source_url === 'string' && parsed.source_url.trim() !== ''
      ? parsed.source_url.trim()
      : sourceUrl;
  const navigationLinks = sanitizeNavigationLinks(parsed.navigation_links);
  let recordTypes = sanitizeRecordTypes(parsed.record_types);

  if (selectedFieldsByType) {
    recordTypes = filterRecordTypesBySelectedFields(recordTypes, selectedFieldsByType);
  }

  return {
    page_title: pageTitle,
    source_url: parsedSourceUrl,
    navigation_links: navigationLinks,
    record_types: recordTypes,
  };
}

/**
 * Discover variable fields (repeating data patterns) without full extraction.
 */
async function discoverVariableFieldsFromHTML(html, options = {}) {
  const sourceUrl = options.sourceUrl || '';
  const maxHtmlChars = options.maxHtmlChars ?? 22000;

  if (!html || typeof html !== 'string') {
    throw new Error('discoverVariableFieldsFromHTML: html must be a non-empty string');
  }

  const cleanHtml = stripHtmlForAI(html);
  const truncatedHtml =
    cleanHtml.length > maxHtmlChars ? cleanHtml.slice(0, maxHtmlChars) : cleanHtml;

  const userContent =
    `Source URL: ${sourceUrl || '(not provided)'}\n\n` +
    '---HTML START---\n' +
    truncatedHtml +
    '\n---HTML END---';

  const aiResponse = await callExtractionLLM(DISCOVER_VARIABLE_FIELDS_PROMPT, userContent, options);
  const parsed = extractJsonBlock(aiResponse);

  const pageTitle = typeof parsed.page_title === 'string' ? parsed.page_title.trim() : '';
  const parsedSourceUrl =
    typeof parsed.source_url === 'string' && parsed.source_url.trim() !== ''
      ? parsed.source_url.trim()
      : sourceUrl;
  const navigationLinks = sanitizeNavigationLinks(parsed.navigation_links);
  const recordTypes = sanitizeDiscoveryRecordTypes(parsed.record_types);

  return {
    page_title: pageTitle,
    source_url: parsedSourceUrl,
    navigation_links: navigationLinks,
    record_types: recordTypes,
  };
}

async function resolvePageHtml({ sourceType, url, html, fetchPageHtml }) {
  const normalizedSourceType = sourceType === 'url' ? 'url' : 'manual_html';
  const targetUrl =
    normalizedSourceType === 'manual_html'
      ? (url || 'manual://pasted-html')
      : String(url || '').trim();

  if (normalizedSourceType === 'url' && !targetUrl) {
    throw new Error('Please enter a target URL.');
  }

  let pageHtml = String(html || '').trim();
  let chromeRendered = false;

  if (normalizedSourceType === 'url') {
    if (typeof fetchPageHtml !== 'function') {
      throw new Error('fetchPageHtml is required for URL extraction.');
    }
    const fetched = await fetchPageHtml(targetUrl);
    pageHtml = fetched.html;
    chromeRendered = !!fetched.chromeRendered;
  } else if (!pageHtml) {
    throw new Error('Paste HTML content before extracting.');
  }

  return { pageHtml, targetUrl, chromeRendered, normalizedSourceType };
}

function buildExtractionResponse({
  deepResult,
  targetUrl,
  normalizedSourceType,
  pageHtml,
  chromeRendered,
  aiUsed,
  mode = 'extract',
}) {
  const recordTypes = deepResult.record_types || [];
  const primary = pickPrimaryRecordType(recordTypes);
  const extractedFields = flattenPrimaryRecords(recordTypes);
  const totalRecords = recordTypes.reduce((sum, rt) => sum + (rt.records?.length || 0), 0);

  return {
    mode,
    url: targetUrl,
    source_type: normalizedSourceType,
    source_url: deepResult.source_url || targetUrl,
    page_title: deepResult.page_title || 'Extracted Page',
    navigation_links: deepResult.navigation_links || [],
    record_types: recordTypes,
    extracted_fields: extractedFields,
    field_count: primary ? primary.fields.length : 0,
    record_count: totalRecords,
    primary_type_name: primary ? primary.type_name : null,
    raw_content_preview: pageHtml.substring(0, 500),
    chrome_rendered: chromeRendered,
    ai_used: aiUsed,
  };
}

/**
 * Step 1: discover variable fields only (no record data).
 */
async function runFieldDiscovery({
  sourceType = 'manual_html',
  url = '',
  html = '',
  fetchPageHtml,
  heuristicDiscoverFallback,
} = {}) {
  const { pageHtml, targetUrl, chromeRendered, normalizedSourceType } = await resolvePageHtml({
    sourceType,
    url,
    html,
    fetchPageHtml,
  });

  let discoveryResult;
  let aiUsed = false;

  try {
    discoveryResult = await discoverVariableFieldsFromHTML(pageHtml, { sourceUrl: targetUrl });
    aiUsed = true;
  } catch (err) {
    if (typeof heuristicDiscoverFallback !== 'function') {
      throw err;
    }
    console.warn('[SCRAPER] Variable field discovery failed, using heuristic fallback:', err.message);
    discoveryResult = heuristicDiscoverFallback(pageHtml, targetUrl);
    aiUsed = false;
  }

  if (!discoveryResult.record_types?.length && typeof heuristicDiscoverFallback === 'function') {
    const fallback = heuristicDiscoverFallback(pageHtml, targetUrl);
    if (fallback.record_types?.length) {
      discoveryResult = fallback;
    }
  }

  return {
    ...buildExtractionResponse({
      deepResult: {
        ...discoveryResult,
        record_types: discoveryToSelectableRecordTypes(discoveryResult.record_types),
      },
      targetUrl,
      normalizedSourceType,
      pageHtml,
      chromeRendered,
      aiUsed,
      mode: 'discover',
    }),
    discovery_record_types: discoveryResult.record_types,
  };
}

/**
 * Step 2: extract records using only user-selected variable fields.
 */
async function runDeepExtraction({
  sourceType = 'manual_html',
  url = '',
  html = '',
  fetchPageHtml,
  heuristicFallback,
  selectedFieldsByType = null,
} = {}) {
  const { pageHtml, targetUrl, chromeRendered, normalizedSourceType } = await resolvePageHtml({
    sourceType,
    url,
    html,
    fetchPageHtml,
  });

  if (!selectedFieldsByType || Object.keys(selectedFieldsByType).length === 0) {
    throw new Error('Select at least one variable field before scraping data.');
  }

  let deepResult;
  let aiUsed = false;

  try {
    deepResult = await extractDeepFieldsWithAI(pageHtml, {
      sourceUrl: targetUrl,
      selectedFieldsByType,
    });
    aiUsed = true;
  } catch (err) {
    if (typeof heuristicFallback !== 'function') {
      throw err;
    }
    console.warn('[SCRAPER] Deep AI extraction failed, using heuristic fallback:', err.message);
    deepResult = heuristicFallback(pageHtml, targetUrl);
    deepResult.record_types = filterRecordTypesBySelectedFields(
      deepResult.record_types || [],
      selectedFieldsByType
    );
    aiUsed = false;
  }

  if (!deepResult.record_types?.length && typeof heuristicFallback === 'function') {
    const fallback = heuristicFallback(pageHtml, targetUrl);
    const filtered = filterRecordTypesBySelectedFields(
      fallback.record_types || [],
      selectedFieldsByType
    );
    if (filtered.length) {
      deepResult = { ...fallback, record_types: filtered };
    }
  }

  return buildExtractionResponse({
    deepResult,
    targetUrl,
    normalizedSourceType,
    pageHtml,
    chromeRendered,
    aiUsed,
    mode: 'extract',
  });
}

function heuristicToRecordTypes(heuristicResult) {
  const rows = heuristicResult.extracted_fields || [];
  if (!rows.length) {
    return {
      page_title: heuristicResult.page_title || 'Extracted Page',
      source_url: heuristicResult.source_url || '',
      navigation_links: heuristicResult.navigation_links || [],
      record_types: [],
    };
  }

  const fieldSet = new Set();
  rows.forEach((row) => {
    if (row && typeof row === 'object') {
      Object.keys(row).forEach((k) => fieldSet.add(k));
    }
  });
  const fields = Array.from(fieldSet);

  return {
    page_title: heuristicResult.page_title || 'Extracted Page',
    source_url: heuristicResult.source_url || '',
    navigation_links: heuristicResult.navigation_links || [],
    record_types: sanitizeRecordTypes([
      {
        type_name: 'leads',
        fields,
        records: rows,
      },
    ]),
  };
}

function heuristicDiscoverFromHeuristic(heuristicResult) {
  const rows = heuristicResult.extracted_fields || [];
  if (!rows.length) {
    return {
      page_title: heuristicResult.page_title || 'Extracted Page',
      source_url: heuristicResult.source_url || '',
      navigation_links: heuristicResult.navigation_links || [],
      record_types: [],
    };
  }

  const fieldCounts = new Map();
  rows.forEach((row) => {
    if (!row || typeof row !== 'object') return;
    Object.entries(row).forEach(([key, value]) => {
      if (String(value || '').trim()) {
        fieldCounts.set(key, (fieldCounts.get(key) || 0) + 1);
      }
    });
  });

  const totalRows = rows.length;
  const variableFields = Array.from(fieldCounts.entries()).map(([fieldName, count]) => ({
    field_name: fieldName,
    repeat_score: Math.round((count / totalRows) * 100),
    sample_value: String(rows.find((r) => r[fieldName])?.[fieldName] || '').slice(0, 80),
  }));

  return {
    page_title: heuristicResult.page_title || 'Extracted Page',
    source_url: heuristicResult.source_url || '',
    navigation_links: heuristicResult.navigation_links || [],
    record_types: sanitizeDiscoveryRecordTypes([
      {
        type_name: 'leads',
        estimated_record_count: totalRows,
        variable_fields: variableFields,
      },
    ]),
  };
}

module.exports = {
  DEEP_SYSTEM_PROMPT,
  DISCOVER_VARIABLE_FIELDS_PROMPT,
  EXTRACT_SELECTED_FIELDS_PROMPT,
  extractDeepFieldsWithAI,
  discoverVariableFieldsFromHTML,
  runFieldDiscovery,
  runDeepExtraction,
  extractJsonBlock,
  sanitizeNavigationLinks,
  sanitizeRecord,
  sanitizeRecordTypes,
  sanitizeDiscoveryRecordTypes,
  discoveryToSelectableRecordTypes,
  filterRecordTypesBySelectedFields,
  pickPrimaryRecordType,
  flattenPrimaryRecords,
  heuristicToRecordTypes,
  heuristicDiscoverFromHeuristic,
  stripHtmlForAI,
};

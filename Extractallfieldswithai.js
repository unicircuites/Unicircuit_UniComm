/**
 * extractAllFieldsWithAI.js
 * ------------------------------------------------------------------
 * Backend module for a Node.js B2B lead scraper.
 *
 * Implements a strict 4-step agentic extraction pipeline:
 *   1. Schema Discovery   - detect repeating lead structures
 *   2. Capture Navigation - pull out menus/pagination/category links
 *   3. CRM Filtering      - keep only CRM-relevant lead fields
 *   4. Array Extraction   - extract values for every lead found
 *
 * Requires Node 18+ (built-in global fetch). If you're on an older
 * Node version, `npm install node-fetch` and uncomment the import.
 * ------------------------------------------------------------------
 */

// const fetch = require('node-fetch'); // only needed on Node < 18

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * The system prompt that enforces the 4-step pipeline INTERNALLY,
 * before the model is allowed to output anything. The model is told
 * to keep its reasoning private and only emit the final JSON object.
 */
const SYSTEM_PROMPT = `You are a data extraction agent specialized in parsing raw HTML into structured B2B CRM lead data. You must follow this exact 4-step internal reasoning pipeline before producing any output. Do not skip steps, and do not output your reasoning -- only the final JSON.

STEP 1 - SCHEMA DISCOVERY:
Scan the provided HTML and identify all repeating DOM structures (e.g. repeated <div>, <li>, <tr>, <article> blocks) that represent multiple, similar entities such as people, companies, or contact cards. Determine whether the page contains a single entity, a list/directory of multiple entities, or no relevant entities at all. This determines the shape of extracted_data below.

STEP 2 - CAPTURE NAVIGATION:
Identify any links that exist purely for site navigation rather than as lead data. This includes: mega menu items, category/sub-category links, breadcrumbs, "next page" / "previous page" / numbered pagination links, "load more" controls, footer sitemap links, and the site's own social/legal links (as opposed to a lead's social links). Collect these separately. They must NEVER appear inside extracted_data.

STEP 3 - CRM FIELD FILTERING:
From the remaining repeating structures identified in Step 1, discard any fields that are pure UI chrome, decorative text, button labels, ratings/reviews, ads, or boilerplate (e.g. "Read more", "Share", "Login", star ratings). Keep ONLY fields useful for a B2B CRM lead profile, which may include (only if actually present in the HTML): full_name, job_title, company_name, email, phone, website, address, city, state, country, industry, linkedin_url, twitter_url, company_size, and any other clearly identifiable professional contact attribute. Do not invent fields that have no corresponding HTML content, and do not include navigation or chrome fields here.

STEP 4 - ARRAY EXTRACTION:
Using only the fields confirmed relevant in Step 3, extract the actual values for every lead instance found in Step 1. Every lead object in the output array must use the same set of keys (use an empty string "" for any field genuinely absent for a particular lead -- never omit the key entirely). Do not fabricate data that is not present in the HTML.

OUTPUT FORMAT:
Respond with ONLY a single valid JSON object -- no markdown code fences, no commentary, no explanation of your steps -- matching exactly this shape:

{
  "page_title": "string, the page's title or main heading",
  "navigation_links": [
    { "link_text": "string", "url": "string" }
  ],
  "extracted_data": [
    { "field_name": "value", "...": "..." }
  ]
}

If no leads are found, return an empty array for extracted_data. If no navigation links are found, return an empty array for navigation_links. Never return anything outside this single JSON object.`;

/**
 * Securely pulls a JSON object out of raw LLM text output.
 * Strips markdown code fences if the model added them anyway,
 * then locates the outermost { ... } block and parses it with
 * JSON.parse (never eval). Throws descriptive errors on failure.
 *
 * @param {string} rawText
 * @returns {object}
 */
function extractJsonBlock(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    throw new Error('extractJsonBlock: LLM response was empty or not text');
  }

  let text = rawText.trim();

  // Strip ```json ... ``` or ``` ... ``` fences if present
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
    throw new Error(`extractJsonBlock: failed to parse JSON from LLM response: ${err.message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('extractJsonBlock: parsed JSON is not a plain object');
  }

  return parsed;
}

/**
 * Cleans the navigation_links array: keeps only entries that have
 * a usable url, trims strings, drops anything malformed.
 */
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
 * Cleans the extracted_data array:
 *  - drops null/undefined/empty-string field values per row
 *  - drops rows that end up with zero remaining fields
 *  - coerces remaining values to trimmed strings
 */
function sanitizeExtractedData(rawArray) {
  if (!Array.isArray(rawArray)) return [];

  return rawArray
    .map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;

      const cleaned = {};
      for (const [key, value] of Object.entries(row)) {
        if (value === null || value === undefined) continue;
        const strVal = String(value).trim();
        if (strVal === '') continue; // filter out empty fields
        cleaned[key] = strVal;
      }
      return cleaned;
    })
    .filter((row) => row && Object.keys(row).length > 0); // filter out empty rows
}

/**
 * Calls the LLM to run the 4-step extraction pipeline against raw HTML,
 * then securely parses and sanitizes the result.
 *
 * @param {string} html - raw HTML of the page to extract leads from
 * @param {object} options
 * @param {string} options.apiKey - Anthropic API key
 * @param {string} [options.model] - model id, defaults to claude-sonnet-4-6
 * @param {number} [options.maxHtmlChars] - truncate very large HTML payloads
 * @returns {Promise<{page_title: string, navigation_links: Array, extracted_data: Array}>}
 */
async function extractAllFieldsWithAI(html, options = {}) {
  const { apiKey, model = 'claude-sonnet-4-6', maxHtmlChars = 150000 } = options;

  if (!apiKey) {
    throw new Error('extractAllFieldsWithAI: missing required options.apiKey');
  }
  if (!html || typeof html !== 'string') {
    throw new Error('extractAllFieldsWithAI: html must be a non-empty string');
  }

  const trimmedHtml = html.length > maxHtmlChars ? html.slice(0, maxHtmlChars) : html;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content:
            'Here is the raw HTML of a web page. Run your full 4-step pipeline internally ' +
            'and return ONLY the final JSON object described in your instructions.\n\n' +
            '---HTML START---\n' +
            trimmedHtml +
            '\n---HTML END---',
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`extractAllFieldsWithAI: LLM API request failed (${response.status}): ${errText}`);
  }

  const data = await response.json();

  const rawText = (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  const parsed = extractJsonBlock(rawText);

  const pageTitle = typeof parsed.page_title === 'string' ? parsed.page_title.trim() : '';
  const navigationLinks = sanitizeNavigationLinks(parsed.navigation_links);
  const extractedData = sanitizeExtractedData(parsed.extracted_data);

  return {
    page_title: pageTitle,
    navigation_links: navigationLinks,
    extracted_data: extractedData,
  };
}

module.exports = {
  SYSTEM_PROMPT,
  extractAllFieldsWithAI,
  // exported for unit testing
  extractJsonBlock,
  sanitizeNavigationLinks,
  sanitizeExtractedData,
};
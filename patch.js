const fs = require('fs');
const file = 'backend/services/scraperService.js';
let content = fs.readFileSync(file, 'utf8');

const helpers = `
function extractJsonBlock(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    throw new Error('extractJsonBlock: LLM response was empty or not text');
  }
  let text = rawText.trim();
  const fenceMatch = text.match(/\\\`\\\`\\\`(?:json)?\\s*([\\s\\S]*?)\\\`\\\`\\\`/i);
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
    throw new Error('extractJsonBlock: failed to parse JSON from LLM response: ' + err.message);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('extractJsonBlock: parsed JSON is not a plain object');
  }
  return parsed;
}

function sanitizeNavigationLinks(rawLinks) {
  if (!Array.isArray(rawLinks)) return [];
  return rawLinks
    .filter(link => link && typeof link === 'object' && typeof link.url === 'string' && link.url.trim() !== '')
    .map(link => ({
      link_text: typeof link.link_text === 'string' ? link.link_text.trim() : '',
      url: link.url.trim(),
    }));
}

function sanitizeExtractedData(rawArray) {
  if (!Array.isArray(rawArray)) return [];
  return rawArray
    .map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      const cleaned = {};
      for (const [key, value] of Object.entries(row)) {
        if (value === null || value === undefined) continue;
        const strVal = String(value).trim();
        if (strVal === '') continue;
        cleaned[key] = strVal;
      }
      return cleaned;
    })
    .filter(row => row && Object.keys(row).length > 0);
}
`;

// Remove the old extractJsonBlock
content = content.replace(/function extractJsonBlock[\s\S]*?catch \(_\) \{\s*return null;\s*\}\s*\}/g, '');

const aiFuncStart = content.indexOf('async function extractAllFieldsWithAI');
const aiFuncEnd = content.indexOf('async function analyzeURL');

const oldAiFunc = content.slice(aiFuncStart, aiFuncEnd);

const newAiFunc = `async function extractAllFieldsWithAI({ sourceType = 'manual_html', url = '', html = '' }) {
  const normalizedSourceType = sourceType === 'url' ? 'url' : 'manual_html';
  const targetUrl = normalizedSourceType === 'manual_html' ? (url || 'manual://pasted-html') : url;
  const pageHtml = normalizedSourceType === 'manual_html' ? String(html || '').trim() : await fetchPublicPageHtml(url);

  if (!pageHtml) {
    throw new Error(normalizedSourceType === 'manual_html' ? 'Paste HTML content before extracting.' : 'No page content could be retrieved from the URL.');
  }

  const heuristic = heuristicExtractAllFields(pageHtml, targetUrl);
  const truncatedHtml = pageHtml.length > 150000 ? pageHtml.slice(0, 150000) : pageHtml;

  const SYSTEM_PROMPT = \`You are a data extraction agent specialized in parsing raw HTML into structured B2B CRM lead data. You must follow this exact 4-step internal reasoning pipeline before producing any output. Do not skip steps, and do not output your reasoning -- only the final JSON.

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

If no leads are found, return an empty array for extracted_data. If no navigation links are found, return an empty array for navigation_links. Never return anything outside this single JSON object.

Source URL: \${targetUrl}

HTML/content to analyze:
\${truncatedHtml}\`;

  let extracted = heuristic.extractedData ? [heuristic.extractedData] : [];
  let pageTitle = heuristic.pageTitle;
  let navigationLinks = [];
  let aiUsed = false;

  try {
    const aiResponse = await ollamaService.callOllamaService(SYSTEM_PROMPT, []);
    const parsed = extractJsonBlock(aiResponse);
    if (parsed) {
      if (Array.isArray(parsed.extracted_data)) {
        extracted = sanitizeExtractedData(parsed.extracted_data);
      }
      if (Array.isArray(parsed.navigation_links)) {
        navigationLinks = sanitizeNavigationLinks(parsed.navigation_links);
      }
      pageTitle = typeof parsed.page_title === 'string' ? parsed.page_title.trim() : (heuristic.pageTitle || 'Untitled Page');
      aiUsed = true;
    }
  } catch (err) {
    console.warn('[SCRAPER] AI extraction fallback to heuristics:', err.message);
  }

  return {
    url: targetUrl,
    source_type: normalizedSourceType,
    page_title: pageTitle || 'Untitled Page',
    extracted_fields: extracted,
    navigation_links: navigationLinks,
    field_count: extracted.length > 0 ? Object.keys(extracted[0]).length : 0,
    raw_content_preview: heuristic.rawContentPreview,
    ai_used: aiUsed
  };
}
`;

content = content.replace(oldAiFunc, helpers + '\n' + newAiFunc + '\n');
fs.writeFileSync(file, content);
console.log('Successfully patched scraperService.js');

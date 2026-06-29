/**
 * applyStructuredExtractionResult.js
 * ------------------------------------------------------------------
 * Vanilla JS frontend logic for the new structured extraction
 * response shape:
 *
 * {
 *   page_title: "...",
 *   navigation_links: [{ link_text, url }, ...],
 *   extracted_data: [{ field: "value", ... }, ...]
 * }
 *
 * Responsibilities:
 *  - Derive the unique set of lead fields actually present across
 *    extracted_data and write them into the "Fields to Extract"
 *    text input as a comma-separated list.
 *  - Render extracted_data into a data table.
 *  - (Bonus) Render navigation_links into a simple list, since the
 *    backend now separates them from lead data.
 *
 * Expected DOM elements (adjust the ids below to match your markup):
 *   #fieldsToExtract          <input type="text">
 *   #leadsTableContainer      <div> to hold the rendered <table>
 *   #navigationLinksContainer <div> to hold the rendered nav links
 *   #pageTitleDisplay         optional element to show page_title
 * ------------------------------------------------------------------
 */

/**
 * Collects the ordered, de-duplicated list of keys that appear
 * across all lead rows in extracted_data.
 *
 * @param {Array<Object>} extractedData
 * @returns {string[]}
 */
function getUniqueFieldKeys(extractedData) {
  const seen = new Set();
  const orderedKeys = [];

  (extractedData || []).forEach((row) => {
    if (!row || typeof row !== 'object') return;
    Object.keys(row).forEach((key) => {
      if (!seen.has(key)) {
        seen.add(key);
        orderedKeys.push(key);
      }
    });
  });

  return orderedKeys;
}

/**
 * Minimal HTML-escaping helper so lead data can never break out
 * of the table markup or inject scripts.
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders the extracted_data array into a <table> inside the given
 * container element, using fieldKeys as the column order.
 */
function renderLeadsTable(extractedData, fieldKeys, tableContainer) {
  if (!tableContainer) return;

  if (!extractedData || extractedData.length === 0) {
    tableContainer.innerHTML = '<p class="empty-state">No leads were extracted from this page.</p>';
    return;
  }

  const theadHtml =
    '<thead><tr>' +
    fieldKeys.map((key) => `<th>${escapeHtml(key)}</th>`).join('') +
    '</tr></thead>';

  const tbodyHtml =
    '<tbody>' +
    extractedData
      .map((row) => {
        const cells = fieldKeys
          .map((key) => `<td>${escapeHtml(row[key] != null ? row[key] : '')}</td>`)
          .join('');
        return `<tr>${cells}</tr>`;
      })
      .join('') +
    '</tbody>';

  tableContainer.innerHTML = `<table class="leads-table">${theadHtml}${tbodyHtml}</table>`;
}

/**
 * Renders the navigation_links array as a simple link list inside
 * the given container element. Safe to call with an empty array.
 */
function renderNavigationLinks(navigationLinks, navContainer) {
  if (!navContainer) return;

  if (!navigationLinks || navigationLinks.length === 0) {
    navContainer.innerHTML = '';
    return;
  }

  const itemsHtml = navigationLinks
    .map((link) => {
      const label = link.link_text && link.link_text.trim() !== '' ? link.link_text : link.url;
      return `<li><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        label
      )}</a></li>`;
    })
    .join('');

  navContainer.innerHTML = `<ul class="nav-links-list">${itemsHtml}</ul>`;
}

/**
 * Main entry point: takes the structured extraction result returned
 * by the backend and applies it to the page.
 *
 * @param {{page_title?: string, navigation_links?: Array, extracted_data?: Array}} result
 */
function applyStructuredExtractionResult(result) {
  if (!result || typeof result !== 'object') {
    console.error('applyStructuredExtractionResult: invalid result payload', result);
    return;
  }

  const page_title = typeof result.page_title === 'string' ? result.page_title : '';
  const navigation_links = Array.isArray(result.navigation_links) ? result.navigation_links : [];
  const extracted_data = Array.isArray(result.extracted_data) ? result.extracted_data : (Array.isArray(result.extracted_fields) ? result.extracted_fields : []);

  const fieldsInput = document.getElementById('fieldsToExtract');
  const tableContainer = document.getElementById('leadsTableContainer');
  const navContainer = document.getElementById('navigationLinksContainer');
  const pageTitleEl = document.getElementById('pageTitleDisplay');

  const fieldKeys = getUniqueFieldKeys(extracted_data);

  // Populate the comma-separated "Fields to Extract" input
  if (fieldsInput) {
    fieldsInput.value = fieldKeys.join(', ');
  }

  if (pageTitleEl) {
    pageTitleEl.textContent = page_title;
  }

  renderLeadsTable(extracted_data, fieldKeys, tableContainer);
  renderNavigationLinks(navigation_links, navContainer);
}

// Expose globally for non-module <script> usage; remove if you're
// using ES modules / bundlers and prefer explicit exports instead.
if (typeof window !== 'undefined') {
  window.applyStructuredExtractionResult = applyStructuredExtractionResult;
  window.getUniqueFieldKeys = getUniqueFieldKeys;
}

// CommonJS / bundler export (also works fine under most bundlers
// alongside the window assignment above)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    applyStructuredExtractionResult,
    getUniqueFieldKeys,
    renderLeadsTable,
    renderNavigationLinks,
    escapeHtml,
  };
}
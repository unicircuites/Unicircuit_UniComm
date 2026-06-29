/**
 * applyDeepExtractionResult.js
 * ------------------------------------------------------------------
 * Vanilla JS frontend logic for the generalized deep-extraction
 * response shape:
 *
 * {
 *   page_title: "...",
 *   source_url: "...",
 *   navigation_links: [{ link_text, url }, ...],
 *   record_types: [
 *     { type_name: "testimonials", fields: [...], records: [{...}] },
 *     { type_name: "services", fields: [...], records: [{...}] },
 *     ...
 *   ]
 * }
 *
 * The backend now captures EVERY field it finds rather than guessing
 * relevance, so this UI puts that choice in your hands instead:
 *
 *   - Every field starts checked (visible) -- since the backend
 *     erred toward including everything, you start seeing all of it.
 *   - Uncheck a field's checkbox to hide that column (keep = checked).
 *   - Type a name into "Add field..." to add a brand new column to
 *     that record type -- it starts empty on every row.
 *   - Table cells are editable (click and type) so you can fill in
 *     values for an added field, or fix anything the AI got wrong.
 *
 * Call window.getVisibleRecordTypesData() at any point (e.g. from
 * your own "Save" button) to get back only the fields currently kept
 * checked, with any edits/additions you've made included.
 *
 * Expected DOM elements (adjust ids to match your markup):
 *   #pageTitleDisplay          optional element to show page_title
 *   #sourceUrlDisplay          optional element to show source_url
 *   #navigationLinksContainer  <div> to hold the rendered nav links
 *   #recordTypesContainer      <div> to hold one section per record type
 * ------------------------------------------------------------------
 */

// type_name -> Set of currently-visible field keys
const visibilityState = new Map();

// The record_types currently on screen (same object references the
// table mutates directly when you edit a cell or add a field), kept
// around so getVisibleRecordTypesData() can read the live state.
let currentRecordTypes = [];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function humanizeTypeName(typeName) {
  return String(typeName)
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getOrInitVisibleFields(recordType) {
  if (!visibilityState.has(recordType.type_name)) {
    visibilityState.set(recordType.type_name, new Set(recordType.fields));
  }
  return visibilityState.get(recordType.type_name);
}

/**
 * Builds the checkbox row (one per known field, "keep" = checked)
 * plus the "Add field..." control for a single record type.
 * `onChange` is called after any check/uncheck/add so the caller can
 * re-render the table to match.
 */
function buildFieldPicker(recordType, onChange) {
  const visibleFields = getOrInitVisibleFields(recordType);

  const wrapper = document.createElement('div');
  wrapper.className = 'field-picker';

  recordType.fields.forEach((field) => {
    const label = document.createElement('label');
    label.className = 'field-picker-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = visibleFields.has(field);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        visibleFields.add(field);
      } else {
        visibleFields.delete(field);
      }
      onChange();
    });

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(' ' + field));
    wrapper.appendChild(label);
  });

  const addForm = document.createElement('span');
  addForm.className = 'add-field-form';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Add field…';
  input.className = 'add-field-input';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addButton.click();
    }
  });

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'add-field-button';
  addButton.textContent = '+ Add field';
  addButton.addEventListener('click', () => {
    const newField = input.value.trim();
    if (!newField) return;
    if (!recordType.fields.includes(newField)) {
      recordType.fields.push(newField);
      recordType.records.forEach((record) => {
        if (!(newField in record)) record[newField] = '';
      });
      visibleFields.add(newField);
    }
    input.value = '';
    onChange();
  });

  addForm.appendChild(input);
  addForm.appendChild(addButton);
  wrapper.appendChild(addForm);

  return wrapper;
}

/**
 * Builds the data table for a record type, showing only fields the
 * user currently has checked. Cells are contenteditable so values
 * can be filled in or corrected by hand.
 */
function buildTable(recordType) {
  const visibleFields = getOrInitVisibleFields(recordType);
  const fieldKeys = recordType.fields.filter((f) => visibleFields.has(f));

  const table = document.createElement('table');
  table.className = 'record-type-table';

  if (fieldKeys.length === 0) {
    table.innerHTML =
      '<tbody><tr><td class="empty-state">No fields selected — check at least one field above.</td></tr></tbody>';
    return table;
  }

  const theadHtml =
    '<thead><tr>' + fieldKeys.map((key) => `<th>${escapeHtml(key)}</th>`).join('') + '</tr></thead>';

  const tbodyHtml =
    '<tbody>' +
    recordType.records
      .map((record, rowIndex) => {
        const cells = fieldKeys
          .map((key) => {
            const value = record[key] != null ? record[key] : '';
            return `<td contenteditable="true" data-row="${rowIndex}" data-field="${escapeHtml(
              key
            )}">${escapeHtml(value)}</td>`;
          })
          .join('');
        return `<tr>${cells}</tr>`;
      })
      .join('') +
    '</tbody>';

  table.innerHTML = theadHtml + tbodyHtml;

  table.querySelectorAll('td[contenteditable="true"]').forEach((cell) => {
    cell.addEventListener('blur', () => {
      const rowIndex = Number(cell.dataset.row);
      const field = cell.dataset.field;
      recordType.records[rowIndex][field] = cell.textContent.trim();
    });
  });

  return table;
}

/**
 * Builds a full <section> (heading + field picker + table) for one
 * record type, and wires up re-rendering when fields are toggled or
 * added.
 */
function buildRecordTypeSection(recordType) {
  const section = document.createElement('section');
  section.className = 'record-type-section';
  section.dataset.typeName = recordType.type_name;

  const heading = document.createElement('h3');
  heading.className = 'record-type-heading';
  heading.textContent = `${humanizeTypeName(recordType.type_name)} (${recordType.records.length})`;
  section.appendChild(heading);

  const pickerContainer = document.createElement('div');
  pickerContainer.className = 'field-picker-container';
  section.appendChild(pickerContainer);

  const tableContainer = document.createElement('div');
  tableContainer.className = 'record-type-table-container';
  section.appendChild(tableContainer);

  const rerender = () => {
    pickerContainer.innerHTML = '';
    pickerContainer.appendChild(buildFieldPicker(recordType, rerender));

    tableContainer.innerHTML = '';
    tableContainer.appendChild(buildTable(recordType));
  };

  rerender();

  return section;
}

function renderRecordTypes(recordTypes, container) {
  if (!container) return;

  container.innerHTML = '';

  if (!recordTypes || recordTypes.length === 0) {
    container.innerHTML = '<p class="empty-state">No repeating data records were found on this page.</p>';
    return;
  }

  recordTypes.forEach((recordType) => {
    container.appendChild(buildRecordTypeSection(recordType));
  });
}

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
 * Returns the current state of every record type, filtered to only
 * the fields the user still has checked, including any manual edits
 * or added fields. Call this from your own "Save"/"Export" action.
 */
function getVisibleRecordTypesData() {
  return currentRecordTypes.map((recordType) => {
    const visibleFields = getOrInitVisibleFields(recordType);
    const fields = recordType.fields.filter((f) => visibleFields.has(f));
    const records = recordType.records.map((record) => {
      const filtered = {};
      fields.forEach((f) => {
        filtered[f] = record[f] != null ? record[f] : '';
      });
      return filtered;
    });
    return { type_name: recordType.type_name, fields, records };
  });
}

/**
 * Main entry point: takes a fresh deep-extraction result and applies
 * it to the page, resetting field-picker state for the new data.
 *
 * @param {{page_title?: string, source_url?: string, navigation_links?: Array, record_types?: Array}} result
 */
function applyDeepExtractionResult(result) {
  if (!result || typeof result !== 'object') {
    console.error('applyDeepExtractionResult: invalid result payload', result);
    return;
  }

  const page_title = typeof result.page_title === 'string' ? result.page_title : '';
  const source_url = typeof result.source_url === 'string' ? result.source_url : '';
  const navigation_links = Array.isArray(result.navigation_links) ? result.navigation_links : [];
  const record_types = Array.isArray(result.record_types) ? result.record_types : [];

  // Fresh result -> reset picker state and start every field checked.
  visibilityState.clear();
  currentRecordTypes = record_types;

  const pageTitleEl = document.getElementById('pageTitleDisplay');
  const sourceUrlEl = document.getElementById('sourceUrlDisplay');
  const navContainer = document.getElementById('navigationLinksContainer');
  const recordTypesContainer = document.getElementById('recordTypesContainer');

  if (pageTitleEl) pageTitleEl.textContent = page_title;
  if (sourceUrlEl) sourceUrlEl.textContent = source_url;

  renderNavigationLinks(navigation_links, navContainer);
  renderRecordTypes(record_types, recordTypesContainer);
}

if (typeof window !== 'undefined') {
  window.applyDeepExtractionResult = applyDeepExtractionResult;
  window.getVisibleRecordTypesData = getVisibleRecordTypesData;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    applyDeepExtractionResult,
    getVisibleRecordTypesData,
    renderRecordTypes,
    renderNavigationLinks,
    humanizeTypeName,
    escapeHtml,
  };
}

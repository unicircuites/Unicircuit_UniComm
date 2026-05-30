/**
 * Email template placeholder extraction and substitution.
 * Supports {{key}} placeholders in subject/body HTML.
 */

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function extractPlaceholders(...texts) {
  const keys = new Set();
  for (const text of texts) {
    const src = String(text || '');
    let m;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((m = PLACEHOLDER_RE.exec(src))) {
      keys.add(m[1].toLowerCase());
    }
  }
  return [...keys];
}

function normalizeFieldDefs(variableFields) {
  if (!Array.isArray(variableFields)) return [];
  return variableFields
    .map((f) => {
      if (!f || typeof f !== 'object') return null;
      const key = String(f.key || '').trim().toLowerCase();
      if (!key) return null;
      return {
        key,
        label: f.label || key,
        required: !!f.required,
        value: f.value != null ? String(f.value) : '',
        example: f.example != null ? String(f.example) : '',
        source: f.source === 'recipient' ? 'recipient' : 'static',
        options: Array.isArray(f.options) ? f.options.map(String) : [],
      };
    })
    .filter(Boolean);
}

function buildRecipientMap(recipient, fieldDefs) {
  const email = typeof recipient === 'string' ? recipient : (recipient && recipient.email) || '';
  const name = typeof recipient === 'object'
    ? (recipient.name || '').trim()
    : '';
  const company = typeof recipient === 'object'
    ? (recipient.company || '').trim()
    : '';
  const displayName = name || (email ? email.split('@')[0] : '');
  const domain = email && email.includes('@') ? email.split('@')[1] : '';

  const map = {
    name: displayName,
    company: company || domain,
    recipient_name: displayName,
    email,
  };

  for (const field of fieldDefs) {
    const key = field.key;
    if (field.source === 'recipient') {
      if (key === 'recipient_name' || key === 'name') {
        map[key] = displayName;
      } else if (key === 'company') {
        map[key] = map.company;
      } else if (key === 'email') {
        map[key] = email;
      } else {
        map[key] = displayName || field.value || field.example || '';
      }
    } else {
      const val = String(field.value || '').trim();
      map[key] = val || field.example || '';
    }
  }

  return map;
}

function substitute(text, varMap) {
  return String(text || '').replace(PLACEHOLDER_RE, (full, key) => {
    const k = String(key || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(varMap, k)) {
      const v = varMap[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
    }
    return full;
  });
}

function assessMapping(placeholders, fieldDefs) {
  const fieldsByKey = new Map(fieldDefs.map((f) => [f.key, f]));
  const rows = placeholders.map((key) => {
    const field = fieldsByKey.get(key);
    if (!field) {
      return { key, status: 'unmapped', label: 'Not defined', resolved: '' };
    }
    const resolved = field.source === 'recipient'
      ? '(from recipient)'
      : (String(field.value || '').trim() || field.example || '');
    const ok = field.source === 'recipient' || String(resolved).trim() !== '';
    return {
      key,
      status: ok ? 'mapped' : 'unmapped',
      label: ok ? 'Mapped' : 'Missing value',
      resolved,
      field,
    };
  });

  for (const field of fieldDefs) {
    if (!placeholders.includes(field.key)) {
      rows.push({
        key: field.key,
        status: 'unused',
        label: 'Not in template',
        resolved: field.value || field.example || '',
        field,
      });
    }
  }

  return rows;
}

module.exports = {
  extractPlaceholders,
  normalizeFieldDefs,
  buildRecipientMap,
  substitute,
  assessMapping,
};

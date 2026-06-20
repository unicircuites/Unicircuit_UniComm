/**
 * Input Validation Middleware
 * Prevents command injection, path traversal, and other injection attacks
 */

/**
 * Dangerous patterns that could indicate command injection attempts
 */
const DANGEROUS_PATTERNS = [
  /[;&`$(){}[\]<>]/,             // Shell metacharacters (removed | pipe - used in markdown tables)
  /\.\.\//,                      // Path traversal
  /\.\.\\/,                      // Path traversal (Windows)
  /\x00/,                        // Null byte injection
  /<script[^>]*>.*?<\/script>/i, // XSS script tags
  /javascript:/i,                // JavaScript protocol
  /<[^>]+?\bon\w+\s*=/i,         // Event handlers inside tags (onclick, onerror, etc.)
];

/**
 * SQL injection patterns (additional layer beyond parameterized queries)
 */
const SQL_INJECTION_PATTERNS = [
  /(\bUNION\b.*\bSELECT\b)/i,
  /(\bDROP\b.*\bTABLE\b)/i,
  /(\bINSERT\b.*\bINTO\b.*\bVALUES\b)/i,
  /(\bDELETE\b.*\bFROM\b)/i,
  /(\bUPDATE\b.*\bSET\b)/i,
  /(--|\#|\/\*|\*\/)/,           // SQL comments
];

/**
 * Fields that should be exempt from strict validation (content fields)
 * These fields can contain markdown, HTML, or rich text
 */
const CONTENT_FIELDS = [
  'content',
  'body',
  'message',
  'description',
  'notes',
  'text',
  'html',
  'template',
  'subject',
  'messagesHtml',
  'talking_points',
  'summary',
  'analysis',
  // Fields that may contain large base64 blobs or attachment metadata
  'attachments',
  'contentbytes',
  'content_bytes',
  'contentid',
  'filename',
];

/**
 * Check if a field name is a content field
 */
function isContentField(fieldPath) {
  if (!fieldPath) return false;
  const parts = fieldPath.split('.');
  const lastPart = parts[parts.length - 1];

  // Check if last part matches content field names
  // If the path explicitly includes an attachments container, treat it as content
  const lowerPath = fieldPath.toLowerCase();
  if (lowerPath.includes('attachments') || lowerPath.includes('files')) return true;

  return CONTENT_FIELDS.some(cf => lastPart.toLowerCase().includes(cf.toLowerCase()));
}

/**
 * Check if a string contains dangerous patterns
 */
function containsDangerousPattern(str, isContent = false) {
  if (typeof str !== 'string') return false;

  // For content fields, only check for XSS and script injection
  if (isContent) {
    return /<script[^>]*>.*?<\/script>/i.test(str) ||
      /javascript:/i.test(str) ||
      /<[^>]+?\bon\w+\s*=/i.test(str);
  }

  // For non-content fields, check all patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(str)) return true;
  }

  for (const pattern of SQL_INJECTION_PATTERNS) {
    if (pattern.test(str)) return true;
  }

  return false;
}

/**
 * Recursively scan an object for dangerous patterns
 */
function scanObject(obj, path = '') {
  if (obj === null || obj === undefined) return null;

  if (typeof obj === 'string') {
    const isContent = isContentField(path);
    if (containsDangerousPattern(obj, isContent)) {
      return path || 'input';
    }
    return null;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const result = scanObject(obj[i], `${path}[${i}]`);
      if (result) return result;
    }
    return null;
  }

  if (typeof obj === 'object') {
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        const newPath = path ? `${path}.${key}` : key;
        const result = scanObject(obj[key], newPath);
        if (result) return result;
      }
    }
    return null;
  }

  return null;
}

/**
 * Middleware to validate request inputs
 */
function validateInput(req, res, next) {
  try {
    // Skip validation for certain routes that handle rich content
    const skipRoutes = [
      '/mail-tasks',
      '/api/mail-tasks',
      '/templates',
      '/api/templates',
      '/broadcast',
      '/api/broadcast',
      '/outlook/send',
      '/api/outlook/send',
      '/wa/send',
      '/api/wa/send',
      '/wa/send-media',
      '/api/wa/send-media',
      '/wa/broadcast',
      '/api/wa/broadcast',
      '/recordings',
      '/api/calls/recordings',
      '/api/pbx/db-recordings',
      '/api/pbx/db-folders',
      '/ai/chat',
      '/api/system/ai/chat',
      '/auth/callback',
      '/crm/scraper',
      '/api/crm/scraper',
    ];

    if (skipRoutes.some(route => req.path.startsWith(route))) {
      return next();
    }

    // Check query parameters
    const queryViolation = scanObject(req.query, 'query');
    if (queryViolation) {
      console.warn(`[Security] Dangerous pattern detected in ${queryViolation}:`, req.query);
      return res.status(400).json({
        error: 'Invalid input detected',
        field: queryViolation,
        message: 'Input contains potentially dangerous characters'
      });
    }

    // Check body parameters
    const bodyViolation = scanObject(req.body, 'body');
    if (bodyViolation) {
      console.warn(`[Security] Dangerous pattern detected in ${bodyViolation}:`, req.body);
      return res.status(400).json({
        error: 'Invalid input detected',
        field: bodyViolation,
        message: 'Input contains potentially dangerous characters'
      });
    }

    // Check URL parameters
    const paramsViolation = scanObject(req.params, 'params');
    if (paramsViolation) {
      console.warn(`[Security] Dangerous pattern detected in ${paramsViolation}:`, req.params);
      return res.status(400).json({
        error: 'Invalid input detected',
        field: paramsViolation,
        message: 'Input contains potentially dangerous characters'
      });
    }

    next();
  } catch (err) {
    console.error('[Security] Input validation error:', err.message);
    next(); // Don't block on validation errors
  }
}

/**
 * Sanitize a string by removing dangerous characters
 */
function sanitizeString(str) {
  if (typeof str !== 'string') return str;

  // Remove shell metacharacters
  return str.replace(/[;&|`$(){}[\]<>]/g, '')
    .replace(/\.\.\//g, '')
    .replace(/\.\.\\/g, '')
    .replace(/\x00/g, '')
    .replace(/\r\n|\r|\n/g, ' ');
}

/**
 * Validate file path to prevent path traversal
 */
function isValidPath(filePath) {
  if (typeof filePath !== 'string') return false;

  // Check for path traversal
  if (filePath.includes('..')) return false;

  // Check for absolute paths (should be relative)
  if (filePath.startsWith('/') || /^[a-zA-Z]:/.test(filePath)) return false;

  // Check for null bytes
  if (filePath.includes('\x00')) return false;

  return true;
}

module.exports = {
  validateInput,
  sanitizeString,
  isValidPath,
  containsDangerousPattern,
};

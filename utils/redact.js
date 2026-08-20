// utils/redact.js — safe logging redaction.
//
// Redacts sensitive values (tokens, secrets, credentials, emails) from any
// string/object before it is written to logs, so access/refresh/Google/stream
// tokens, provider credentials, and passwords never leak into log output.
//
// Consistent with the request-ID observability policy: we log requestId and
// non-sensitive context, but NEVER secrets.

'use strict';

// Patterns for common sensitive values. Values are replaced with '[REDACTED]'.
const SENSITIVE_PATTERNS = [

  // JSON-ish patterns: "token": "value" / "password": "value" / "secret": "value"
  /("?(?:access[_-]?token|refresh[_-]?token|password|passwd|secret|api[_-]?key|client[_-]?secret|authorization|id[_-]?token|stream[_-]?token|google[_-]?token)"?\s*[:=]\s*["']?)([^"',\s}]+)/gi,

  // Bearer tokens: Authorization: Bearer <jwt>
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,

  // Google / generic JWT (header.payload.signature)
  /(eyJ[A-Za-z0-9_-]{10,})\.([A-Za-z0-9_-]{10,})\.([A-Za-z0-9_-]{10,})/g,

  // Stream HMAC tokens (hex, typically 32+ chars) after 'token='
  /(token=)[A-Fa-f0-9]{16,}/g,

  // Emails (avoid logging unnecessarily)
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
];

// Exact sensitive keys in an object (case-insensitive) that we will never log.
const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'password_hash', 'token', 'access_token', 'accessToken',
  'refresh_token', 'refreshToken', 'secret', 'client_secret', 'api_key', 'apiKey',
  'authorization', 'id_token', 'idToken', 'google_token', 'stream_token', 'streamToken',
]);

/**
 * Redact a string in place (replace sensitive substrings).
 * @param {string} str
 * @returns {string}
 */
function redactString(str) {
  if (typeof str !== 'string') return str;
  let out = str;
  for (const pattern of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, (_m, prefix) => `${prefix || ''}[REDACTED]`);
  }
  return out;
}

/**
 * Deep-redact an object/array (only the values of SENSITIVE_KEYS + any nested
 * strings). Rebuilds a new object; does not mutate the input.
 * @param {*} value
 * @returns {*}
 */
function redactObject(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactObject);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      const lower = key.toLowerCase();
      // Skip sensitive keys entirely.
      if (SENSITIVE_KEYS.has(lower)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = redactObject(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Redact a log message (string) or object/array before logging.
 * @param {string|object|Array} input
 * @returns {string|object|Array}
 */
function redact(input) {
  if (typeof input === 'string') return redactString(input);
  return redactObject(input);
}

module.exports = { redact, redactString, redactObject, SENSITIVE_PATTERNS, SENSITIVE_KEYS };
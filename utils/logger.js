// =============================================================
//  utils/logger.js — Centralized Structured Logger
//
//  Features:
//    • Structured JSON output (single-line) in production
//    • Pretty-printed logs in development (NODE_ENV=development)
//    • Configurable log level via LOG_LEVEL env var
//    • Automatic redaction of sensitive fields
//    • Category-specific helpers: stream, database, auth
//    • Lightweight — no external dependencies
// =============================================================

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.INFO;
const IS_DEV = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'dev';

// ── Sensitive field redaction ─────────────────────────────────
const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'token',
  'jwt',
  'authorization',
  'bearer',
  'id_token',
  'access_token',
  'refresh_token',
  'secret',
  'api_key',
  'api_secret',
  'google_id',
  'google_token',
  'cookie',
  'session',
  'db_password',
  'db_user',
]);

const SENSITIVE_PATTERNS = [
  /bearer\s+[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+/gi,
  /google_id_token\s*=\s*["'][^"']+["']/gi,
  /password\s*[=:]\s*["'][^"']+["']/gi,
  /secret\s*[=:]\s*["'][^"']+["']/gi,
];

/**
 * Recursively redact sensitive values from an object.
 * Returns a new object — never mutates the original.
 */
function redact(obj, depth = 0) {
  if (depth > 5) return '[MaxDepth]';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    let safe = obj;
    for (const pattern of SENSITIVE_PATTERNS) {
      safe = safe.replace(pattern, '[REDACTED]');
    }
    return safe;
  }
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => redact(item, depth + 1));
  if (obj instanceof Error) return redactError(obj);

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const keyLower = key.toLowerCase();
    if (SENSITIVE_KEYS.has(keyLower)) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      // Check if any sensitive key pattern matches in the key
      const hasSensitiveInKey = Array.from(SENSITIVE_KEYS).some(sk =>
        keyLower.includes(sk)
      );
      if (hasSensitiveInKey) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redact(value, depth + 1);
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Safely extract fields from an Error object without losing stack trace.
 */
function redactError(err) {
  return {
    message: err.message,
    stack: err.stack,
    code: err.code,
    status: err.status || err.statusCode,
    ...(err.providerContext ? { providerContext: err.providerContext } : {}),
  };
}

// ── Core logging function ────────────────────────────────────

/**
 * Write a structured log entry.
 *
 * @param {string} level — 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
 * @param {string} category — Logical grouping (e.g. 'stream', 'database', 'auth')
 * @param {string} message — Human-readable summary
 * @param {object} [meta={}] — Structured metadata (will be redacted)
 */
function log(level, category, message, meta = {}) {
  if (LOG_LEVELS[level] === undefined) level = 'INFO';
  if (LOG_LEVELS[level] < CURRENT_LEVEL) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    ...redact(meta),
  };

  // Use appropriate output stream based on level
  const output = IS_DEV ? JSON.stringify(entry, null, 2) : JSON.stringify(entry);

  if (level === 'ERROR') {
    console.error(output);
  } else if (level === 'WARN') {
    console.warn(output);
  } else {
    console.log(output);
  }
}

// ── Public API ───────────────────────────────────────────────

const logger = {
  debug(message, meta = {}) {
    log('DEBUG', 'general', message, meta);
  },

  info(message, meta = {}) {
    log('INFO', 'general', message, meta);
  },

  warn(message, meta = {}) {
    log('WARN', 'general', message, meta);
  },

  error(message, meta = {}) {
    log('ERROR', 'general', message, meta);
  },

  /**
   * Log a streaming/provider event.
   *
   * Expected meta fields:
   *   provider   — Provider name (e.g. "AnimeKai")
   *   attempt    — Retry attempt number
   *   duration   — Response time in ms
   *   status     — HTTP status code
   *   error      — Error message (if failed)
   *   fallback   — Whether this was a fallback result
   *   proxy      — Proxy URL (will be redacted if contains auth)
   *   cacheHit   — Whether result came from cache
   *   sources    — Number of sources returned
   */
  stream(meta = {}) {
    const level = meta.error ? 'ERROR' : meta.fallback ? 'WARN' : 'INFO';
    const provider = meta.provider || 'unknown';
    const prefix = meta.error ? '❌' : meta.fallback ? '⚠️' : '✅';
    const duration = meta.duration ? ` (${meta.duration}ms)` : '';
    const message = meta.error
      ? `${prefix} ${provider} failed${duration}: ${meta.error}`
      : meta.fallback
        ? `${prefix} ${provider} fallback${duration}`
        : `${prefix} ${provider} resolved${duration}`;

    log(level, 'stream', message, meta);
  },

  /**
   * Log a database operation.
   *
   * Expected meta fields:
   *   table      — Table name
   *   operation  — Query type (SELECT, INSERT, UPDATE, DELETE)
   *   duration   — Execution time in ms
   *   rows       — Number of rows affected / returned
   *   label      — Query label (for dashboard queries etc.)
   *   error      — Error message (if failed)
   *
   * NEVER log SQL parameters containing passwords or tokens.
   */
  database(meta = {}) {
    const level = meta.error ? 'ERROR' : 'INFO';
    const table = meta.table || 'unknown';
    const op = meta.operation || 'QUERY';
    const duration = meta.duration ? ` (${meta.duration}ms)` : '';
    const message = meta.error
      ? `❌ DB ${op} on ${table} failed${duration}: ${meta.error}`
      : `✅ DB ${op} on ${table}${duration}`;

    log(level, 'database', message, meta);
  },

  /**
   * Log an authentication event.
   *
   * Expected meta fields:
   *   type       — Login method (email, google, token)
   *   email      — User email (safe to log domain+username)
   *   role       — User role (admin, user, premium)
   *   result     — Success, failure, or reason
   *   ip         — IP address
   *   userAgent  — User-Agent header
   *
   * NEVER log tokens, passwords, or JWT values.
   */
  auth(meta = {}) {
    const level = meta.error ? 'ERROR' : meta.result === 'failure' ? 'WARN' : 'INFO';
    const type = meta.type || 'unknown';
    const result = meta.result || 'unknown';
    const message = meta.error
      ? `🔐 ${type} auth failed: ${meta.error}`
      : `🔐 ${type} auth ${result}`;

    log(level, 'auth', message, meta);
  },
};

module.exports = logger;


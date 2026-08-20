// middleware/requestId.js — assign a unique request ID to every HTTP request.
//
// Sets req.requestId (e.g. 'req_abc123') and echoes it in the response header
// 'X-Request-Id' so clients can correlate their logs with backend logs. The
// request ID is also included in every error response body by middleware/errorHandler.
//
// SAFE ACCEPTANCE POLICY:
// An incoming `X-Request-Id` header is ONLY trusted if it is already a
// well-formed request ID matching `req_[A-Za-z0-9_-]{6,96}`. Anything else
// (arbitrary text, giant strings, header-injection payloads) is ignored and a
// fresh server-generated ID is used instead. This prevents clients from
// spoofing/overriding our ID format or injecting log content.

'use strict';

const crypto = require('crypto');

// A request ID must start with 'req_' and contain only safe chars.
const INCOMING_ID_PATTERN = /^req_[A-Za-z0-9_-]{6,96}$/;

/**
 * Generate a fresh server-side request ID.
 * @returns {string} e.g. 'req_4f2a9b3c'
 */
function generateRequestId() {
  return 'req_' + crypto.randomBytes(8).toString('hex');
}

/**
 * Validate an incoming X-Request-Id header value.
 * Only accepts a well-formed request ID, never arbitrary/unsafe strings.
 * @param {string} value
 * @returns {string|null} sanitized ID or null if not trusted
 */
function sanitizeIncomingId(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length > 100) return null;      // guard against giant/forced values
  if (!INCOMING_ID_PATTERN.test(trimmed)) return null;  // reject non-standard IDs
  return trimmed;
}

/**
 * Express middleware that assigns a unique request ID.
 * - Accepts a well-formed incoming X-Request-Id (safe policy), else generates.
 * - Attaches to req.requestId for controllers/services.
 * - Echoes as X-Request-Id response header.
 */
function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  const id = sanitizeIncomingId(incoming) || generateRequestId();

  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

module.exports = requestId;
module.exports.generateRequestId = generateRequestId;
module.exports.sanitizeIncomingId = sanitizeIncomingId;
// utils/apiError.js — centralized API error contract.
//
// Every API error MUST be an instance of ApiError with:
//   - status   : HTTP status code
//   - code     : machine-readable error code (e.g. 'EPISODE_NOT_FOUND')
//   - message  : human-readable message
//   - details  : optional structured details (validation, premium tier info)
//
// This ensures independent Web / Mobile / Desktop / Admin clients can rely on
// a consistent error format:
//   { success:false, error: { code, message, details, requestId } }

'use strict';

/**
 * Centralized mapping: HTTP status → default machine-readable error code.
 * Used when a controller throws a plain Error (no code) so we can still emit
 * a stable code, and when the error handler needs a default.
 */
const STATUS_CODES = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

class ApiError extends Error {
  /**
   * @param {number} status  HTTP status code
   * @param {string} [code]  machine-readable code (defaults via STATUS_CODES)
   * @param {string} [message] human-readable message
   * @param {object} [details] optional structured details
   */
  constructor(status, code, message, details) {
    const numericStatus = Number(status) || 500;
    const resolvedCode = code || STATUS_CODES[numericStatus] || 'INTERNAL_ERROR';
    const resolvedMessage = message || resolvedCode.toLowerCase().replace(/_/g, ' ');
    super(resolvedMessage);
    this.name = 'ApiError';
    this.status = numericStatus;
    this.code = resolvedCode;
    this.details = details || {};
    this.isApiError = true;
  }
}

// ── Factory helpers for common statuses ──────────────────────
function badRequest(code, message, details) { return new ApiError(400, code, message, details); }
function unauthorized(code, message, details) { return new ApiError(401, code, message, details); }
function forbidden(code, message, details) { return new ApiError(403, code, message, details); }
function notFound(code, message, details) { return new ApiError(404, code, message, details); }
function conflict(code, message, details) { return new ApiError(409, code, message, details); }
function validation(code, message, details) { return new ApiError(422, code, message, details); }
function rateLimited(code, message, details) { return new ApiError(429, code, message, details); }
function internal(code, message, details) { return new ApiError(500, code, message, details); }
function badGateway(code, message, details) { return new ApiError(502, code, message, details); }
function serviceUnavailable(code, message, details) { return new ApiError(503, code, message, details); }
function gatewayTimeout(code, message, details) { return new ApiError(504, code, message, details); }

/**
 * Build the standard error response body for a given request + error.
 * Never exposes stack traces / internal paths to the client.
 * @param {ApiError|Error} err
 * @param {object} req
 * @param {object} [options] { exposeDetails }
 */
function buildErrorBody(err, req, options) {
  const isApiError = !!(err && err.isApiError);
  const status = (err && (err.status || err.statusCode)) || 500;

  // In production, never leak internal messages for non-ApiError (unexpected)
  // errors — those are unexpected server faults. Apis_errors always have a
  // safe message.
  const safeMessage = isApiError
    ? (err.message || STATUS_CODES[status] || 'Internal error')
    : STATUS_CODES[status] === 'INTERNAL_ERROR'
      ? 'Internal server error.'
      : (err.message || STATUS_CODES[status] || 'Internal error');

  // Always present: requestId from req (set by requestId middleware).
  const requestId = (req && req.requestId) || null;

  return {
    success: false,
    error: {
      code: (err && err.code) || STATUS_CODES[status] || 'INTERNAL_ERROR',
      message: safeMessage,
      details: isApiError ? (err.details || {}) : {},
      requestId,
    },
  };
}

module.exports = {
  ApiError,
  STATUS_CODES,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  validation,
  rateLimited,
  internal,
  badGateway,
  serviceUnavailable,
  gatewayTimeout,
  buildErrorBody,
};
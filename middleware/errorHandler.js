// middleware/errorHandler.js — centralized Express error handler.
//
// Catches any error thrown from a route/controller and renders a consistent
// API error:
//   { success:false, error: { code, message, details, requestId } }
//
// - ApiError instances (utils/apiError.js) are rendered with their code/message/details.
// - Plain Error/unknown throws are rendered as a generic 500 ('INTERNAL_ERROR')
//   WITHOUT leaking stack traces, provider credentials, DB errors, or internal paths.
// - HTTP status is preserved (e.g. a route that throws ApiError(404, ...) → 404).
// - Logs the internal detail (including stack) server-side for debugging.

'use strict';

const { ApiError, STATUS_CODES, buildErrorBody } = require('../utils/apiError');
const { redact } = require('../utils/redact');

/**
 * Express error handler (must be registered with 4 args after routes).
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Determine status + whether it's a known ApiError.
  const status = (err && (err.status || err.statusCode)) || 500;

  // Always log internally (including details we intentionally hide from clients).
  // REDACTED to never leak access/refresh/Google/stream tokens, passwords, or
  // provider credentials that may appear inside error messages/stack traces.
  const logDetail = {
    requestId: req.requestId || null,
    method: req.method,
    url: req.originalUrl || req.url,
    status,
    code: (err && err.code) || STATUS_CODES[status] || 'INTERNAL_ERROR',
    isApiError: !!(err && err.isApiError),
  };
  if (err && err.stack) logDetail.stack = err.stack;

  if (process.env.NODE_ENV !== 'test') {
    console.error('[ErrorHandler]', JSON.stringify(redact(logDetail)));
  }

  // Build a safe response body. Plain (unexpected) errors → generic 500 with no
  // internal message in production. ApiError → its safe message + details.
  const body = buildErrorBody(err, req, { exposeDetails: true });
  if (res.headersSent) {
    // If headers already sent (e.g. streaming), delegate to Express default.
    return next(err);
  }
  return res.status(status).json(body);
}

module.exports = errorHandler;
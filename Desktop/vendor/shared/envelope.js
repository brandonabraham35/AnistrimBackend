// shared/client-contract/envelope.js
// ONE unwrap() implementation for the backend response contract:
//   Success: { success:true, data:{...}, meta:{...} }
//   Error:   { success:false, error:{ code, message, status, requestId } }
// ES5-safe IIFE for use in all clients (mobile, web, desktop, admin).
//
// Usage:
//   <script src="/shared/client-contract/envelope.js"></script>
//   var result = AniStrimEnvelope.unwrap(body);

/* eslint-disable no-undef */
(function (root) {
  'use strict';

  /**
   * Unwrap a backend response body into a consistent shape.
   * Returns:
   *   { ok:true,  data: <inner data>, meta: <meta or {}> }
   *   { ok:false, error: { code, message, status, requestId } }
   *
   * Handles:
   *   - Standard envelope: { success:true, data, meta }
   *   - Standard error:    { success:false, error:{...} }
   *   - Legacy raw body:   plain object/array (passes through as data)
   *   - Paginated lists:   { success:true, data:[...], meta:{pagination} }
   */
  function unwrap(body) {
    if (!body || typeof body !== 'object') {
      return { ok: false, error: { code: 'INVALID_RESPONSE', message: 'Invalid response body', status: 0 } };
    }

    // Standard error envelope
    if (body.success === false && body.error) {
      return {
        ok: false,
        error: {
          code: body.error.code || 'UNKNOWN_ERROR',
          message: body.error.message || 'Request failed',
          status: body.error.status || 0,
          requestId: body.error.requestId || null,
        },
      };
    }

    // Standard success envelope
    if (body.success === true && Object.prototype.hasOwnProperty.call(body, 'data')) {
      return {
        ok: true,
        data: body.data,
        meta: body.meta || {},
      };
    }

    // Legacy raw body — pass through as data
    return {
      ok: true,
      data: body,
      meta: {},
    };
  }

  /**
   * Convenience: unwrap and throw if not ok.
   * Returns the data payload on success.
   */
  function unwrapOrThrow(body) {
    var result = unwrap(body);
    if (!result.ok) {
      var err = new Error(result.error.message || 'Request failed');
      err.code = result.error.code;
      err.status = result.error.status;
      err.requestId = result.error.requestId;
      throw err;
    }
    return result.data;
  }

  // Export for browser (IIFE) and CommonJS (tests)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { unwrap: unwrap, unwrapOrThrow: unwrapOrThrow };
  } else {
    root.AniStrimEnvelope = { unwrap: unwrap, unwrapOrThrow: unwrapOrThrow };
  }
})(typeof window !== 'undefined' ? window : this);
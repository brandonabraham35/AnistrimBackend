// utils/response.js — centralized SUCCESS response contract.
//
// Mirrors utils/apiError.js (the ERROR contract). Every successful API response
// uses the same envelope so independent Web / Mobile / Desktop / Admin clients
// can rely on a consistent shape:
//
//   Single resource:  { success:true, data:{ ... }, meta?:{ ... } }
//   List resource:    { success:true, data:[ ... ], meta:{ pagination:{ ... } } }
//
// Controllers should ALWAYS use these helpers instead of hand-building
// res.json() bodies. NEVER call res.json() directly for API success responses —
// that is how divergent shapes ([], {}, { token, user }, { success, ... })
// crept in.
//
// Auth responses preserve all the fields clients require (token,
// refreshToken, sessionId, user) but nest them under `data` so the envelope is
// uniform:
//   { success:true, data:{ token, refreshToken, sessionId, user }, meta? }

'use strict';

/**
 * Send a single-resource (or action-confirmation) success response.
 * @param {object} res - Express response
 * @param {*} data - Payload. Must be a single object, array, or primitive.
 * @param {object} [meta] - Optional non-pagination metadata (e.g. { emailSent }).
 * @param {number} [status=200] - HTTP status code.
 */
function sendSuccess(res, data, meta, status) {
  const body = {
    success: true,
    data: data === undefined ? null : data,
  };
  if (meta !== undefined && meta !== null) body.meta = meta;
  return res.status(status || 200).json(body);
}

/**
 * Send an authentication success response (token-based).
 * Preserves token / refreshToken / sessionId / user on `data`.
 * @param {object} res - Express response
 * @param {object} auth - { token, refreshToken, sessionId, user }
 * @param {object} [meta] - Optional extra metadata (e.g. { message, emailSent }).
 * @param {number} [status=200] - HTTP status code.
 */
function sendAuth(res, auth, meta, status) {
  const body = {
    success: true,
    data: {
      token: auth.token,
      refreshToken: auth.refreshToken,
      sessionId: auth.sessionId,
      user: auth.user,
      // Include any extra auth payload fields (e.g. message) directly on data.
      ...auth.extra,
    },
  };
  if (meta !== undefined && meta !== null) body.meta = meta;
  return res.status(status || 200).json(body);
}

/**
 * Build the pagination metadata object for list responses.
 * @param {number} page - 1-based current page.
 * @param {number} perPage - Items per page.
 * @param {number} totalItems - Total available items across all pages.
 */
function buildPaginationMeta(page, perPage, totalItems) {
  const p = Number(page) || 1;
  const pp = Number(perPage) || 1;
  const total = Number(totalItems) || 0;
  const totalPages = Math.max(1, Math.ceil(total / pp));
  return {
    pagination: {
      page: p,
      perPage: pp,
      totalItems: total,
      totalPages,
      hasNext: p < totalPages,
      hasPrev: p > 1,
    },
  };
}

/**
 * Send a paginated list success response.
 * @param {object} res - Express response
 * @param {Array} data - The page's items (array).
 * @param {object} pagination - { page, perPage, totalItems } (totalItems REQUIRED).
 * @param {object} [meta] - Optional extra metadata merged alongside pagination.
 */
function sendPaginated(res, data, pagination, meta) {
  const paginationMeta = buildPaginationMeta(
    pagination && pagination.page,
    pagination && pagination.perPage,
    pagination && pagination.totalItems
  );
  const body = { success: true, data: Array.isArray(data) ? data : [] };
  body.meta = Object.assign({}, meta, paginationMeta);
  return res.status(200).json(body);
}

module.exports = { sendSuccess, sendPaginated, buildPaginationMeta, sendAuth };
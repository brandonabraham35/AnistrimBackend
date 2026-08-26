// middleware/clientPlatform.js — normalize X-Client header into req.clientPlatform.
//
// The X-Client header is already sent by all AniStrim clients:
//   Web     → 'web'
//   Mobile  → 'mobile'
//   Desktop → 'desktop'
//   Admin   → 'admin'
//
// This middleware extracts and normalizes the value so every controller
// can reliably read req.clientPlatform without re-parsing headers.
// Backward-compatible: missing or unrecognized headers default to 'unknown'.

'use strict';

const VALID_PLATFORMS = new Set(['web', 'mobile', 'desktop', 'admin']);

function normalizePlatform(raw) {
  if (!raw) return 'unknown';
  const lower = String(raw).toLowerCase().trim();
  // Map common variants
  if (lower === 'frontend' || lower === 'android' || lower === 'ios') return 'mobile';
  if (lower === 'web' || lower === 'browser') return 'web';
  if (lower === 'desktop' || lower === 'electron') return 'desktop';
  if (lower === 'admin') return 'admin';
  return VALID_PLATFORMS.has(lower) ? lower : 'unknown';
}

module.exports = function clientPlatform(req, res, next) {
  req.clientPlatform = normalizePlatform(req.headers['x-client']);
  next();
};

module.exports.normalizePlatform = normalizePlatform;

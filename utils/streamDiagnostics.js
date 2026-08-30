// =============================================================
//  utils/streamDiagnostics.js — READ-ONLY Stream Lifetime Diagnostics
//
//  PURPOSE:
//    Centralised, safe diagnostic helpers for observing the streaming
//    pipeline's URL lifetimes, context lifetimes, cache-probe accuracy,
//    and playback success/failure. NEVER modifies behaviour, NEVER
//    changes TTLs, NEVER changes headers or proxy behaviour.
//
//  DESIGN:
//    • All diagnostic methods are pure logging — no side effects.
//    • URL fingerprints are SAFE: hostname, path-pattern, param-names,
//      URL hash (crypto truncated), URL length. NEVER full URLs.
//    • Cookies, tokens, secrets are NEVER logged.
//    • All output is structured JSON with the [STREAM_DIAG] tag for
//      easy grep:  grep 'STREAM_DIAG' server.log
//    • Gated by STREAM_DIAGNOSTIC env var (default OFF). Set to '1'
//      or 'true' to enable. This prevents production log flood.
// =============================================================
'use strict';

const crypto = require('crypto');
const logger = require('./logger');

// ── Gate ────────────────────────────────────────────────────
const DIAG_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  (process.env.STREAM_DIAGNOSTIC || '').toLowerCase()
);

const TAG = '[STREAM_DIAG]';
// ── Safe URL Fingerprinting ─────────────────────────────────
// Returns diagnostic-safe fields: NEVER returns the full URL.

/**
 * Extract a safe fingerprint from a URL string.
 * @param {string} urlStr - A URL (may be raw CDN or proxy path)
 * @returns {object|null} { host, path, params, hash, length } or null on parse failure
 */
function fingerprintUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    const abs = urlStr.startsWith('http') ? urlStr : `https://placeholder${urlStr}`;
    const u = new URL(abs);
    const params = [...u.searchParams.keys()].sort();
    const shortHash = crypto
      .createHash('sha256')
      .update(urlStr)
      .digest('hex')
      .substring(0, 12);
    return {
      host: u.hostname || null,
      path: u.pathname || null,
      params: params.length > 0 ? params.join(',') : null,
      hash: shortHash,
      length: urlStr.length,
    };
  } catch {
    return null;
  }
}

/**
 * Build a diagnostic event log entry.
 * Only emitted when STREAM_DIAGNOSTIC is enabled.
 * @param {string} event - Event type
 * @param {object} data  - Event-specific fields (must be safe — no secrets)
 */
function diagLog(event, data = {}) {
  if (!DIAG_ENABLED) return;
  logger.info(`${TAG} ${event}`, data);
}

module.exports = {
  DIAG_ENABLED,
  TAG,
  fingerprintUrl,
  diagLog,
};
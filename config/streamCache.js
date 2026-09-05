// ============================================================
//  config/streamCache.js — Persistent Stream Cache Configuration
//
//  Centralised, environment-driven configuration for the persistent
//  MySQL AnimeHeaven stream cache. All values are read from env vars
//  with safe defaults; nothing is hard-coded across the codebase.
//
//  Env vars:
//    STREAM_CACHE_ENABLED     — master switch (true/false)
//    STREAM_CACHE_TTL_MINUTES — performance/reference TTL for cached streams
//    STREAM_CACHE_PROVIDER    — the provider tag this cache serves
// ============================================================
'use strict';

// The persistent stream cache holds AnimeHeaven PRE-PROXY source data. That
// data can only play back while the underlying AnimeHeaven CDN playback
// context (cookies/mirrors) is still valid when the source requires it.
//
//  PERSISTENT-UNTIL-PROVEN-DEAD (current policy):
//    • A saved source is retained indefinitely. An elapsed `ttlMinutes` /
//      `expires_at` is a PERFORMANCE/reference TTL, NOT proof the source died.
//    • A source only becomes non-reusable when the source itself is proven
//      dead (evidence-based invalidation) or when a REAL upstream expiry
//      (detected_expires_at) is known and passes.
//    • `detected_expires_at` is preserved — real upstream expiration is still
//      respected; the distinction is:
//
//          AniStrim cache age  ≠  actual provider URL expiration
//
//    • Redis TTL is a performance-cache TTL; Redis expiry does NOT invalidate
//      the MySQL source of truth.
//
//  History note:
//    Before this policy the cache used the CONFIGURED TTL as the source-validity
//    window and per-source URL expiry detection could shorten entries. The
//    configured TTL is retained for compatibility/housekeeping and as an upper
//    bound for the performance caches, but it is no longer the authority on
//    whether a saved source is usable.

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function parsePositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

// The configured performance/reference cache window in minutes. Default 360
// minutes (6 hours). Parseable as a configuration knob; used for the
// in-memory TTL exposure and `expires_at` housekeeping. It is NOT treated as
// proof that a source is dead when it elapses.
const configuredTtlMinutes = parsePositiveInt(process.env.STREAM_CACHE_TTL_MINUTES, 360);

module.exports = {
  // Master switch for the persistent stream cache.
  enabled: parseBool(process.env.STREAM_CACHE_ENABLED, true),

  // The provider this cache stores. AnimeHeaven is the only streaming
  // provider in the current engine.
  provider: process.env.STREAM_CACHE_PROVIDER || 'animeheaven',

  // Source persistence policy flag — exposed for observability/diagnostics.
  // true = saved sources are kept until proven dead (age is never expiration).
  persistentUntilProvenDead: true,

  // Performance/reference TTL in minutes. Per-source REAL upstream expiry
  // detection (detected_expires_at) can shorten individual entries below this
  // value; this is the maximum permitted performance-cache window.
  ttlMinutes: configuredTtlMinutes,

  // TTL in milliseconds (convenience for expiry math).
  get ttlMs() {
    return this.ttlMinutes * 60 * 1000;
  },

  // Verification interval for UNKNOWN state sources (in minutes).
  // Sources with no known upstream expiry but stale verification will be
  // verified after this interval. Default: 30 minutes.
  verificationIntervalMinutes: parsePositiveInt(process.env.STREAM_VERIFICATION_INTERVAL_MINUTES, 30),
};

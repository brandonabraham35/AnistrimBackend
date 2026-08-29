// ============================================================
//  config/streamCache.js — Persistent Stream Cache Configuration
//
//  Centralised, environment-driven configuration for the persistent
//  MySQL AnimeHeaven stream cache. All values are read from env vars
//  with safe defaults; nothing is hard-coded across the codebase.
//
//  Env vars:
//    STREAM_CACHE_ENABLED     — master switch (true/false)
//    STREAM_CACHE_TTL_MINUTES — how long a cached stream is valid
//    STREAM_CACHE_PROVIDER    — the provider tag this cache serves
// ============================================================
'use strict';

// The persistent stream cache holds AnimeHeaven PRE-PROXY source data. That
// data can only play back while the underlying AnimeHeaven CDN playback
// context (cookies/mirrors) is still valid when the source requires it.
//
// Instead of universally clamping the TTL to the cookie lifetime, the cache
// now uses the CONFIGURED TTL as the upper bound and lets per-source URL
// expiry detection (detected_expires_at) determine the actual per-entry
// expiry in streamCacheService.saveStream().  This means a stable,
// non-tokenized source URL can stay cached for the full configured window,
// while a source with detectable expiration parameters gets a shorter
// per-entry expiry.
//
// The 8-minute cookie lifetime is no longer a universal clamp, because the
// final CDN URL often needs no cookies at all (the unsafe context is the
// gate/mirror page, not the media CDN).  Per-source detection is safer:
// if an expiration parameter is found in the CDN URL's query string, it
// becomes the per-entry expires_at; otherwise the configured TTL is used.

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function parsePositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

// The configured cache validity window in minutes. Default 360 minutes (6
// hours). Parseable as a configuration knob; used for the in-memory TTL
// exposure.
const configuredTtlMinutes = parsePositiveInt(process.env.STREAM_CACHE_TTL_MINUTES, 360);

module.exports = {
  // Master switch for the persistent stream cache.
  enabled: parseBool(process.env.STREAM_CACHE_ENABLED, true),

  // The provider this cache stores. AnimeHeaven is the only streaming
  // provider in the current engine.
  provider: process.env.STREAM_CACHE_PROVIDER || 'animeheaven',

  // Cache TTL in minutes.  Per-source expiry detection
  // (detected_expires_at) can shorten individual entries below this
  // value; this is the maximum permitted window.
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

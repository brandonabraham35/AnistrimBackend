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
// context (cookies/mirrors) is still valid. The provider's COOKIE_TTL_MS is
// the SHORTEST relevant validity period that must bound the cache, so we
// import it here (single source of truth — no duplicated magic numbers).
// This does NOT create a circular dependency: animeHeavenProvider does not
// require config/streamCache.
const { COOKIE_TTL_MS } = require('../services/animeHeavenProvider');

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
// exposure and honored by the effective-TTL clamp below.
const configuredTtlMinutes = parsePositiveInt(process.env.STREAM_CACHE_TTL_MINUTES, 360);

// The provider's known CDN playback-context lifetime in minutes (cookie TTL).
// If the provider ever exposes a reliable per-stream expiry we could use that
// instead; for now this is the conservative provider-level bound.
const providerSafeTtlMinutes = Math.max(1, Math.floor((Number(COOKIE_TTL_MS) || 8 * 60 * 1000) / 60000));

// Effective cache TTL: never longer than the provider's safe playback-context
// lifetime. If the configured global TTL is lower, that lower value wins. This
// guarantees the persistent cache CANNOT outlive the AnimeHeaven CDN cookie
// lifetime, preventing "cached stream → expired CDN context → CDN 403".
const effectiveTtlMinutes = Math.min(configuredTtlMinutes, providerSafeTtlMinutes);

module.exports = {
  // Master switch for the persistent stream cache.
  enabled: parseBool(process.env.STREAM_CACHE_ENABLED, true),

  // Configured cache validity window in minutes (kept for backward
  // compatibility / external visibility). The actual expiry uses
  // `safeTtlMinutes` below so it never exceeds the provider's cookie TTL.
  ttlMinutes: configuredTtlMinutes,

  // The provider this cache stores. AnimeHeaven is the only streaming
  // provider in the current engine.
  provider: process.env.STREAM_CACHE_PROVIDER || 'animeheaven',

  // Effective, clamped cache TTL in minutes. This is what streamCacheService
  // uses for cache expiry. It is always <= ttlMinutes.
  safeTtlMinutes: effectiveTtlMinutes,

  // TTL in milliseconds (convenience for expiry math).
  get ttlMs() {
    return this.ttlMinutes * 60 * 1000;
  },

  // Safe TTL in milliseconds (convenience for expiry math).
  get safeTtlMs() {
    return this.safeTtlMinutes * 60 * 1000;
  },
};

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

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function parsePositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

module.exports = {
  // Master switch for the persistent stream cache.
  enabled: parseBool(process.env.STREAM_CACHE_ENABLED, true),

  // Cache validity window in minutes. Default 360 minutes (6 hours).
  ttlMinutes: parsePositiveInt(process.env.STREAM_CACHE_TTL_MINUTES, 360),

  // The provider this cache stores. AnimeHeaven is the only streaming
  // provider in the current engine.
  provider: process.env.STREAM_CACHE_PROVIDER || 'animeheaven',

  // TTL in milliseconds (convenience for expiry math).
  get ttlMs() {
    return this.ttlMinutes * 60 * 1000;
  },
};

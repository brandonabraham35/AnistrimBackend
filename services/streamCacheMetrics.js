// services/streamCacheMetrics.js — In-memory stream cache metrics collector.
//
// PURPOSE:
//   Track internal metrics for the stream cache pipeline so administrators
//   can observe cache health, resolver usage, and verification status.
//
// SECURITY:
//   • Never exposes provider credentials or raw upstream URLs.
//   • Only exposes aggregate counts and anonymized distributions.
//
// METRICS TRACKED:
//   1. tier1Hits       — streamingService Tier-1 cache hits
//   2. redisHits       — Redis cache hits (persistent stream-cache paths)
//   3. inMemoryHits    — In-flight resolver memory-cache hits
//   4. mysqlHits       — MySQL cache hits (persistent path)
//   5. resolverCalls   — Total resolver invocations (any provider)
//   6. animeHeavenCalls — AnimeHeaven resolver calls
//   7. consumetCalls   — Consumet resolver calls
//   8. thordataCalls   — Thordata/proxy-backed resolver calls
//   9. cacheMisses     — All tiers missed → resolver invoked
//  10. expiredSources  — Sources found expired during resolution
//  11. invalidSources  — Sources marked invalid during resolution
//  12. verificationSuccesses — Monitor verification successes
//  13. verificationFailures  — Monitor verification failures
//  14. playbackReportedFailures — Client-reported playback failures
//  15. sourceLifetimes  — Array of observed source lifetimes (ms) for avg calc
//  16. activeCachedSources    — DB snapshot: currently active sources
//  17. knownExpirySources       — DB snapshot: sources with detected_expires_at
//  18. unknownExpirySources     — DB snapshot: sources without detected_expires_at
//
// USAGE:
//   const metrics = require('./services/streamCacheMetrics');
//   metrics.increment('redisHits');
//   metrics.recordSourceLifetime(3600000);
//   const snapshot = metrics.getSnapshot(dbPool);

'use strict';

const db = require('../config/db');
const logger = require('../utils/logger');

// ── In-memory counters ────────────────────────────────────

const counters = {
  tier1Hits: 0,
  redisHits: 0,
  mysqlHits: 0,
  resolverCalls: 0,
  animeHeavenCalls: 0,
  consumetCalls: 0,
  thordataCalls: 0,
  cacheMisses: 0,
  inMemoryHits: 0,
  expiredSources: 0,
  invalidSources: 0,
  verificationSuccesses: 0,
  verificationFailures: 0,
  playbackReportedFailures: 0,
};

// Source lifetime samples (ms from resolved_at to now for sources that have been
// successfully verified or that resolved without error). Capped to last 500.
const sourceLifetimes = [];
const MAX_LIFETIME_SAMPLES = 500;

// ── Increment helpers ─────────────────────────────────────

/**
 * Increment a named counter.
 * @param {string} name — one of the counter keys above
 */
function increment(name) {
  if (name in counters) {
    counters[name]++;
  }
}

/**
 * Record a source lifetime sample in milliseconds.
 * @param {number} lifetimeMs
 */
function recordSourceLifetime(lifetimeMs) {
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) return;
  sourceLifetimes.push(lifetimeMs);
  if (sourceLifetimes.length > MAX_LIFETIME_SAMPLES) {
    sourceLifetimes.shift();
  }
}

// ── Snapshot ──────────────────────────────────────────────

/**
 * Build a complete metrics snapshot.
 * Combines in-memory counters with live DB queries for source counts.
 *
 * @param {object} dbPool — MySQL pool (passed in to allow test injection)
 * @returns {Promise<object>} snapshot
 */
async function getSnapshot(dbPool) {
  const pool = dbPool || db;

  // Default DB counts (used if query fails).
  let activeCachedSources = 0;
  let knownExpirySources = 0;
  let unknownExpirySources = 0;

  try {
    const [rows] = await pool.query(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN verification_status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN detected_expires_at IS NOT NULL THEN 1 ELSE 0 END) AS known_expiry,
        SUM(CASE WHEN detected_expires_at IS NULL THEN 1 ELSE 0 END) AS unknown_expiry
       FROM episode_stream_cache
       WHERE expires_at > NOW()`
    );
    const row = rows[0];
    activeCachedSources = row?.active || 0;
    knownExpirySources = row?.known_expiry || 0;
    unknownExpirySources = row?.unknown_expiry || 0;
  } catch (err) {
    logger.warn('[StreamCacheMetrics] DB snapshot failed', { error: err.message });
  }

  // Average observed source lifetime.
  const avgLifetimeMs = sourceLifetimes.length > 0
    ? sourceLifetimes.reduce((a, b) => a + b, 0) / sourceLifetimes.length
    : 0;

  return {
    // Cache tier hits
    tier1Hits: counters.tier1Hits,
    redisHits: counters.redisHits,
    inMemoryHits: counters.inMemoryHits,
    mysqlHits: counters.mysqlHits,
    cacheMisses: counters.cacheMisses,

    // Resolver calls by provider (never exposes credentials or URLs)
    resolverCalls: counters.resolverCalls,
    animeHeavenCalls: counters.animeHeavenCalls,
    consumetCalls: counters.consumetCalls,
    thordataCalls: counters.thordataCalls,

    // Source health
    expiredSources: counters.expiredSources,
    invalidSources: counters.invalidSources,

    // Verification
    verificationSuccesses: counters.verificationSuccesses,
    verificationFailures: counters.verificationFailures,

    // Client-reported
    playbackReportedFailures: counters.playbackReportedFailures,

    // Lifetime
    averageSourceLifetimeMs: Math.round(avgLifetimeMs),
    sourceLifetimeSamples: sourceLifetimes.length,

    // DB source counts (live query on episode_stream_cache)
    activeCachedSources,
    knownExpirySources,
    unknownExpirySources,
  };
}

// ── Reset (for tests) ─────────────────────────────────────

function reset() {
  for (const key of Object.keys(counters)) {
    counters[key] = 0;
  }
  sourceLifetimes.length = 0;
}

module.exports = {
  increment,
  recordSourceLifetime,
  getSnapshot,
  reset,
  // Expose raw counters for direct instrumentation (testing + internal use).
  counters,
  sourceLifetimes,
};

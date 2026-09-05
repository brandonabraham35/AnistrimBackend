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
//   6. animeHeavenCalls — AnimeHeaven resolver calls (any reason)
//   7. consumetCalls   — Consumet resolver calls
//   8. thordataCalls   — Thordata/proxy-backed resolver calls
//   9. cacheMisses     — All tiers missed → resolver invoked
//  10. expiredSources  — Sources found expired during resolution
//  11. invalidSources  — Sources marked invalid during resolution
//  12. verificationSuccesses — Monitor verification successes
//  13. verificationFailures  — Monitor verification failures
//  14. playbackReportedFailures — Client-reported playback failures
//  15. sourceLifetimes  — Array of observed source lifetimes (ms) for avg calc
//  16. activeCachedSources    — DB snapshot: verified-active sources
//  17. knownExpirySources       — DB snapshot: sources with detected_expires_at
//  18. unknownExpirySources     — DB snapshot: sources without detected_expires_at
//
//  PERSISTENT-UNTIL-PROVEN-DEAD OBSERVABILITY (added with the stream-source
//  lifetime change):
//  19. animeHeavenUserCalls    — user-driven AnimeHeaven resolutions
//  20. animeHeavenPrefetchCalls — prefetch-driven AnimeHeaven resolutions
//  21. animeHeavenRepairCalls   — repair/self-heal driven resolutions
//  22. animeHeavenRetryCalls    — retries inside a user-driven resolution loop
//  23. invalidationConfirmed403/404/OtherConfirmedDead — evidence-based
//      source-death reasons (NEVER recorded for timeouts/5xx/429 etc.)
//
// USAGE:
//   const metrics = require('./services/streamCacheMetrics');
//   metrics.increment('redisHits');
//   metrics.recordSourceLifetime(3600000);
//   metrics.recordProviderCall('prefetch');
//   metrics.recordInvalidation('confirmed_403');
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

  // Provider-call categories — every executeAnimeHeaven() call reports a
  // structured reason (see recordProviderCall). These let the dashboard answer
  // "how many times did we actually contact AnimeHeaven, and why?".
  animeHeavenUserCalls: 0,
  animeHeavenPrefetchCalls: 0,
  animeHeavenRepairCalls: 0,
  animeHeavenRetryCalls: 0,

  // Confirmed invalidation reasons. Only ever incremented when there is
  // concrete evidence the source itself is dead (403/404 or an explicit
  // permanent-death outcome). Timeouts/429/5xx/network errors NEVER reach
  // these counters.
  invalidationConfirmed403: 0,
  invalidationConfirmed404: 0,
  invalidationOtherConfirmedDead: 0,
};

// Structured provider-call reasons → dashboard category.
const PROVIDER_CALL_CATEGORIES = {
  user_fresh_resolution: 'user',
  cache_miss: 'user',
  cache_invalid: 'user',
  cache_expired: 'user',
  explicit_provider_resolution: 'user',
  retry: 'retry',
  prefetch: 'prefetch',
  self_heal: 'repair',
  liveness_failure: 'repair',
  cache_repair: 'repair',
};

// Process-lifetime timestamps of the last resolution of each kind. These are
// observability only — they reset on process restart (dashboard labels them
// "process lifetime", never historical totals).
const lastTimestamps = {
  lastAnimeHeavenResolutionAt: null,
  lastUserResolutionAt: null,
  lastPrefetchResolutionAt: null,
  lastRepairResolutionAt: null,
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

// ── Provider-call reason observability ─────────────────────

/**
 * Record a genuine AnimeHeaven provider call with its structured reason.
 *
 * Every real contact with the provider must be attributable. This increments
 * the existing `animeHeavenCalls` total (dashboard-compatible) AND the
 * category counter for the reason so the dashboard can distinguish:
 *
 *   user-driven calls   → animeHeavenUserCalls
 *   prefetch calls      → animeHeavenPrefetchCalls
 *   repair/self-heal    → animeHeavenRepairCalls
 *   retries            → animeHeavenRetryCalls
 *
 * @param {string} [reason] — one of PROVIDER_CALL_CATEGORIES keys
 * @returns {string} normalized reason
 */
function recordProviderCall(reason) {
  const normalized = reason && reasoningLabel(reason) ? reason : 'user_fresh_resolution';
  const category = PROVIDER_CALL_CATEGORIES[normalized] || 'user';
  const nowIso = new Date().toISOString();

  counters.animeHeavenCalls += 1;
  lastTimestamps.lastAnimeHeavenResolutionAt = nowIso;

  if (category === 'prefetch') {
    counters.animeHeavenPrefetchCalls += 1;
    lastTimestamps.lastPrefetchResolutionAt = nowIso;
  } else if (category === 'repair') {
    counters.animeHeavenRepairCalls += 1;
    lastTimestamps.lastRepairResolutionAt = nowIso;
  } else if (category === 'retry') {
    counters.animeHeavenRetryCalls += 1;
    counters.animeHeavenUserCalls += 1;
    lastTimestamps.lastUserResolutionAt = nowIso;
  } else {
    counters.animeHeavenUserCalls += 1;
    lastTimestamps.lastUserResolutionAt = nowIso;
  }

  return normalized;
}

function reasoningLabel(reason) {
  return Object.prototype.hasOwnProperty.call(PROVIDER_CALL_CATEGORIES, reason);
}

/**
 * Record evidence-based source invalidation. Only called when the source is
 * conclusively dead (403/404 or an explicit permanent-death outcome).
 *
 * @param {'confirmed_403'|'confirmed_404'|'other_confirmed_dead'} kind
 */
function recordInvalidation(kind) {
  if (kind === 'confirmed_403') {
    counters.invalidationConfirmed403 += 1;
  } else if (kind === 'confirmed_404') {
    counters.invalidationConfirmed404 += 1;
  } else {
    counters.invalidationOtherConfirmedDead += 1;
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
  const dbCounts = {
    total: 0, active: 0, unknown: 0, invalid: 0,
    known_expiry: 0, unknown_expiry: 0, known_expired: 0,
    verified_5m: 0, verified_1h: 0, verified_24h: 0,
    oldest_age_sec: 0, avg_age_sec: 0,
    older_1d: 0, older_7d: 0, older_30d: 0,
  };
  let medianAgeSec = null;

  try {
    const [rows] = await pool.query(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN verification_status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN verification_status = 'unknown' THEN 1 ELSE 0 END) AS unknown,
        SUM(CASE WHEN verification_status = 'invalid' THEN 1 ELSE 0 END) AS invalid,
        SUM(CASE WHEN detected_expires_at IS NOT NULL THEN 1 ELSE 0 END) AS known_expiry,
        SUM(CASE WHEN detected_expires_at IS NULL THEN 1 ELSE 0 END) AS unknown_expiry,
        SUM(CASE WHEN detected_expires_at IS NOT NULL AND detected_expires_at <= NOW() THEN 1 ELSE 0 END) AS known_expired,
        SUM(CASE WHEN last_verified_at IS NOT NULL AND last_verified_at >= NOW() - INTERVAL 5 MINUTE THEN 1 ELSE 0 END) AS verified_5m,
        SUM(CASE WHEN last_verified_at IS NOT NULL AND last_verified_at >= NOW() - INTERVAL 1 HOUR THEN 1 ELSE 0 END) AS verified_1h,
        SUM(CASE WHEN last_verified_at IS NOT NULL AND last_verified_at >= NOW() - INTERVAL 24 HOUR THEN 1 ELSE 0 END) AS verified_24h,
        MAX(TIMESTAMPDIFF(SECOND, COALESCE(resolved_at, created_at), NOW())) AS oldest_age_sec,
        AVG(TIMESTAMPDIFF(SECOND, COALESCE(resolved_at, created_at), NOW())) AS avg_age_sec,
        SUM(CASE WHEN COALESCE(resolved_at, created_at) < NOW() - INTERVAL 1 DAY THEN 1 ELSE 0 END) AS older_1d,
        SUM(CASE WHEN COALESCE(resolved_at, created_at) < NOW() - INTERVAL 7 DAY THEN 1 ELSE 0 END) AS older_7d,
        SUM(CASE WHEN COALESCE(resolved_at, created_at) < NOW() - INTERVAL 30 DAY THEN 1 ELSE 0 END) AS older_30d
       FROM episode_stream_cache`
    );
    const row = rows[0] || {};
    for (const key of Object.keys(dbCounts)) {
      const v = row[key];
      dbCounts[key] = v == null ? 0 : Number(v);
    }

    // Median age — cheap two-query approximation; capped so an absurdly large
    // table can never make the dashboard expensive.
    if (dbCounts.total > 0 && dbCounts.total <= 100000) {
      const offset = Math.floor((dbCounts.total - 1) / 2);
      const [medianRows] = await pool.query(
        `SELECT age_sec FROM (
           SELECT TIMESTAMPDIFF(SECOND, COALESCE(resolved_at, created_at), NOW()) AS age_sec
           FROM episode_stream_cache
         ) ageq
         ORDER BY age_sec
         LIMIT 1 OFFSET ?`,
        [offset]
      );
      const med = medianRows && medianRows[0] ? medianRows[0].age_sec : null;
      medianAgeSec = med == null ? null : Number(med);
    }
  } catch (err) {
    logger.warn('[StreamCacheMetrics] DB snapshot failed', { error: err.message });
  }

  // Average observed source lifetime.
  const avgLifetimeMs = sourceLifetimes.length > 0
    ? sourceLifetimes.reduce((a, b) => a + b, 0) / sourceLifetimes.length
    : 0;

  // Cache efficiency — derived from observable counters only.
  const cacheHits = counters.tier1Hits + counters.redisHits + counters.inMemoryHits + counters.mysqlHits;
  const cacheLookups = cacheHits + counters.cacheMisses;

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

    // Provider-call categories (persistent-until-proven-dead observability)
    animeHeavenUserCalls: counters.animeHeavenUserCalls,
    animeHeavenPrefetchCalls: counters.animeHeavenPrefetchCalls,
    animeHeavenRepairCalls: counters.animeHeavenRepairCalls,
    animeHeavenRetryCalls: counters.animeHeavenRetryCalls,

    // Evidence-based invalidation reasons (403/404/other confirmed dead only)
    invalidationReasons: {
      confirmed_403: counters.invalidationConfirmed403,
      confirmed_404: counters.invalidationConfirmed404,
      known_upstream_expiry: dbCounts.known_expired,
      other_confirmed_dead: counters.invalidationOtherConfirmedDead,
    },

    // Process-lifetime last-resolution timestamps (reset on restart)
    lastAnimeHeavenResolutionAt: lastTimestamps.lastAnimeHeavenResolutionAt,
    lastUserResolutionAt: lastTimestamps.lastUserResolutionAt,
    lastPrefetchResolutionAt: lastTimestamps.lastPrefetchResolutionAt,
    lastRepairResolutionAt: lastTimestamps.lastRepairResolutionAt,

    // Lifetime
    averageSourceLifetimeMs: Math.round(avgLifetimeMs),
    sourceLifetimeSamples: sourceLifetimes.length,

    // Cache efficiency (derived, observable counters only)
    cacheHitRate: cacheLookups > 0 ? Math.round((cacheHits / cacheLookups) * 10000) / 100 : null,
    providerCallsAvoided: cacheHits,

    // DB source counts (live query on episode_stream_cache, ALL rows — the age
    // of `expires_at` is never treated as source death)
    persistentSources: dbCounts.total,
    activeCachedSources: dbCounts.active,
    reusableSources: dbCounts.active + dbCounts.unknown,
    invalidSourcesCount: dbCounts.invalid,
    knownExpirySources: dbCounts.known_expiry,
    unknownExpirySources: dbCounts.unknown_expiry,
    knownExpiredSources: dbCounts.known_expired,

    // Recently verified buckets
    recentlyVerifiedSources: {
      within5m: dbCounts.verified_5m,
      within1h: dbCounts.verified_1h,
      within24h: dbCounts.verified_24h,
    },

    // Source age (observability only — an old source is NOT expired)
    oldestSourceAgeMs: dbCounts.oldest_age_sec ? dbCounts.oldest_age_sec * 1000 : null,
    averageSourceAgeMs: dbCounts.avg_age_sec ? Math.round(dbCounts.avg_age_sec * 1000) : null,
    medianSourceAgeMs: medianAgeSec != null ? medianAgeSec * 1000 : null,
    sourceAgeBuckets: {
      older1d: dbCounts.older_1d,
      older7d: dbCounts.older_7d,
      older30d: dbCounts.older_30d,
    },
  };
}

// ── Reset (for tests) ─────────────────────────────────────

function reset() {
  for (const key of Object.keys(counters)) {
    counters[key] = 0;
  }
  for (const key of Object.keys(lastTimestamps)) {
    lastTimestamps[key] = null;
  }
  sourceLifetimes.length = 0;
}

module.exports = {
  increment,
  recordSourceLifetime,
  recordProviderCall,
  recordInvalidation,
  getSnapshot,
  reset,
  // Expose raw counters for direct instrumentation (testing + internal use).
  counters,
  sourceLifetimes,
};

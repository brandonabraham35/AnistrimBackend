// ============================================================
//  services/inFlightResolverManager.js — True Single-Flight Resolver
//
//  PURPOSE:
//    Guarantee that for a given (provider, episodeId) key there is AT MOST
//    ONE in-flight resolver at any time. Concurrent requests for the same
//    key attach to the existing resolver and receive its eventual result.
//
//  KEY PROPERTIES (fixes the timeout/lock bug):
//    • The resolver is NEVER cancelled.
//    • The lock is NEVER released on timeout — it stays alive until the
//      resolver settles (success OR failure).
//    • A late success is NEVER discarded — it is cached (memory + persistent)
//      and delivered to all waiters.
//    • Waiting requests attach to the existing resolver — NO duplicate
//      AnimeHeaven executions.
//
//  API:
//    register(key, resolver)  — start a resolver (or attach to existing)
//    wait(key)                — await the in-flight resolver's result
//    complete(key, result)    — mark a resolver successful (internal)
//    fail(key, error)         — mark a resolver failed (internal)
//    cleanup(key)             — remove a settled entry
//    getMetrics()             — observability counters
// ============================================================
'use strict';

const logger = require('../utils/logger');

// ── Observability metrics ──────────────────────────────────
const metrics = {
  resolverStarted: 0,
  resolverWaiting: 0,
  resolverCompleted: 0,
  resolverTimedOut: 0,
  resolverLateSuccess: 0,
  duplicateRequestsPrevented: 0,
  resolverFailed: 0,
};

// ── In-flight registry ─────────────────────────────────────
// Map<key, { promise, startedAt, timedOut, settled, waiters }>
const inflight = new Map();

// ── Memory cache ───────────────────────────────────────────
// A short-lived in-memory cache of successfully-resolved results so that a
// late success is available to subsequent requests IMMEDIATELY (before the
// persistent DB cache is reached on the next request). Keyed by the same
// canonical key. Entries expire after MEMORY_CACHE_TTL_MS.
const MEMORY_CACHE_TTL_MS = Number(process.env.STREAM_CACHE_MEMORY_TTL_MS || 5 * 60 * 1000);
const memoryCache = new Map(); // key -> { result, expiresAt }

// ── Timeout configuration ──────────────────────────────────
// This is a SOFT timeout: it only marks the resolver as "timed out" for
// observability and to let the FIRST waiter return early if it chooses.
// The resolver itself is NEVER cancelled and the lock is NEVER released.
const RESOLVER_TIMEOUT_MS = Number(process.env.STREAM_CACHE_RESOLVER_TIMEOUT_MS || 20000);

/**
 * Build the canonical key for a (provider, episodeId) pair.
 * @param {string} provider
 * @param {number|string} episodeId
 * @returns {string}
 */
function keyFor(provider, episodeId) {
  return `${String(provider).toLowerCase()}:${episodeId}`;
}

/**
 * Register a resolver for a key. If a resolver is already in-flight for this
 * key, the caller attaches to it (returns the existing promise) and does NOT
 * start a new one. This is the core single-flight guarantee.
 *
 * @param {string} key — canonical key (provider:episodeId)
 * @param {() => Promise<object|null>} resolver — the resolver function
 * @returns {{ promise: Promise<object|null>, isNew: boolean }}
 */
function register(key, resolver) {
  const existing = inflight.get(key);
  if (existing) {
    // Attach to the existing in-flight resolver — NO duplicate execution.
    metrics.duplicateRequestsPrevented += 1;
    metrics.resolverWaiting += 1;
    logger.debug('[InFlightResolver] Attaching to existing resolver', { key, waiters: existing.waiters });
    return { promise: existing.promise, isNew: false };
  }

  // Start a NEW resolver.
  metrics.resolverStarted += 1;
  logger.info('[InFlightResolver] Starting resolver', { key, timeoutMs: RESOLVER_TIMEOUT_MS });

  let timedOut = false;
  let settled = false;
  let waiters = 0;

  const entry = {
    key,
    startedAt: Date.now(),
    timedOut: false,
    settled: false,
    waiters: 0,
    promise: null,
  };

  // The resolver promise. It NEVER rejects — it always resolves to a result
  // object (or null on failure). We wrap it so a rejection is converted to a
  // null result (the caller treats null as "no stream found").
  const resolverPromise = Promise.resolve()
    .then(() => resolver())
    .then((result) => {
      settled = true;
      entry.settled = true;
      metrics.resolverCompleted += 1;
      if (timedOut) {
        metrics.resolverLateSuccess += 1;
        logger.info('[InFlightResolver] Late success — result cached, not discarded', { key });
      }
      // Cache a successful result in memory so subsequent requests (even
      // before the persistent DB cache is reached) get it immediately.
      if (result && result.sources && result.sources.length > 0) {
        setCached(key, result);
      }
      return result;
    })
    .catch((err) => {
      settled = true;
      entry.settled = true;
      metrics.resolverFailed += 1;
      logger.warn('[InFlightResolver] Resolver failed', { key, error: err.message });
      return null;
    });

  entry.promise = resolverPromise;

  // Soft timeout: mark the entry as timed out (observability) but DO NOT
  // cancel the resolver and DO NOT release the lock. The resolver continues
  // and its late result is delivered to all waiters + cached.
  const timer = setTimeout(() => {
    if (!settled) {
      timedOut = true;
      entry.timedOut = true;
      metrics.resolverTimedOut += 1;
      logger.warn('[InFlightResolver] Soft timeout — resolver continues, lock held', {
        key,
        timeoutMs: RESOLVER_TIMEOUT_MS,
      });
    }
  }, RESOLVER_TIMEOUT_MS);
  if (timer.unref) timer.unref();

  // When the resolver settles, clear the timer and (optionally) clean up.
  resolverPromise.finally(() => {
    clearTimeout(timer);
  });

  inflight.set(key, entry);
  return { promise: resolverPromise, isNew: true };
}

/**
 * Wait for the in-flight resolver for a key to settle.
 * If no resolver is in-flight, returns null immediately (caller should
 * register one first).
 *
 * @param {string} key
 * @returns {Promise<object|null>} the resolver result (or null)
 */
async function wait(key) {
  const entry = inflight.get(key);
  if (!entry) return null;
  entry.waiters += 1;
  metrics.resolverWaiting += 1;
  try {
    return await entry.promise;
  } finally {
    entry.waiters = Math.max(0, entry.waiters - 1);
  }
}

/**
 * Mark a resolver as complete (used internally / for tests).
 * @param {string} key
 * @param {object|null} result
 */
function complete(key, result) {
  const entry = inflight.get(key);
  if (!entry) return;
  entry.settled = true;
  metrics.resolverCompleted += 1;
  // The promise is already resolved by the resolver; this is a no-op for
  // the promise but records the completion.
  logger.debug('[InFlightResolver] complete', { key, hasResult: !!result });
}

/**
 * Mark a resolver as failed (used internally / for tests).
 * @param {string} key
 * @param {Error} error
 */
function fail(key, error) {
  const entry = inflight.get(key);
  if (!entry) return;
  entry.settled = true;
  metrics.resolverFailed += 1;
  logger.warn('[InFlightResolver] fail', { key, error: error && error.message });
}

/**
 * Remove a settled entry from the registry. Safe to call after the resolver
 * has settled. If the entry is still in-flight, this is a no-op (the lock
 * must stay alive until the resolver settles).
 *
 * @param {string} key
 */
function cleanup(key) {
  const entry = inflight.get(key);
  if (!entry) return;
  if (!entry.settled) {
    logger.debug('[InFlightResolver] cleanup skipped — resolver still in-flight', { key });
    return;
  }
  inflight.delete(key);
  logger.debug('[InFlightResolver] cleanup', { key });
}

/**
 * Check whether a resolver is currently in-flight for a key.
 * @param {string} key
 * @returns {boolean}
 */
function isInFlight(key) {
  const entry = inflight.get(key);
  return !!entry && !entry.settled;
}

/**
 * Get the current observability metrics.
 * @returns {object}
 */
function getMetrics() {
  return {
    ...metrics,
    activeResolvers: inflight.size,
    inFlightKeys: [...inflight.keys()],
  };
}

/**
 * Store a successful resolver result in the in-memory cache.
 * @param {string} key
 * @param {object} result
 */
function setCached(key, result) {
  if (!key || !result) return;
  memoryCache.set(key, { result, expiresAt: Date.now() + MEMORY_CACHE_TTL_MS });
  logger.debug('[InFlightResolver] Memory cache set', { key, ttlMs: MEMORY_CACHE_TTL_MS });
}

/**
 * Retrieve a cached result from the in-memory cache (if not expired).
 * @param {string} key
 * @returns {object|null}
 */
function getCached(key) {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return hit.result;
}

/**
 * Reset metrics + registry (for tests).
 */
function reset() {
  inflight.clear();
  memoryCache.clear();
  metrics.resolverStarted = 0;
  metrics.resolverWaiting = 0;
  metrics.resolverCompleted = 0;
  metrics.resolverTimedOut = 0;
  metrics.resolverLateSuccess = 0;
  metrics.duplicateRequestsPrevented = 0;
  metrics.resolverFailed = 0;
}

module.exports = {
  register,
  wait,
  complete,
  fail,
  cleanup,
  isInFlight,
  getMetrics,
  reset,
  keyFor,
  setCached,
  getCached,
  RESOLVER_TIMEOUT_MS,
};

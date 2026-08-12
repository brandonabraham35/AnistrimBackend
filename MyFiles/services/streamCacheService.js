// ============================================================
//  services/streamCacheService.js — Persistent AnimeHeaven Stream Cache
//
//  PURPOSE:
//    Persist successfully-resolved AnimeHeaven stream sources in MySQL so
//    subsequent plays of the same episode reuse the cached source instead of
//    re-contacting AnimeHeaven (while the entry remains valid).
//
//  THIS IS PLAYBACK INFRASTRUCTURE ONLY.
//    • It does NOT touch the Admin CMS, anime/episode CRUD, video_url, auth,
//      premium, watch history, catalogue, or the proxy system.
//    • It is completely transparent to the Admin Dashboard.
//
//  WHAT IS STORED:
//    The cache stores the PRE-PROXY AnimeHeaven source (targetUrl +
//    referer/origin/cookies + quality + subtitle metadata). It does NOT store
//    the ephemeral /api/stream-proxy/:streamId URL. On a cache hit the caller
//    reconstructs the provider result and feeds it through the EXISTING
//    streamProxy.rewriteResultToProxy() so a fresh ephemeral proxy URL is
//    generated — preserving the existing proxy/security architecture.
//
//  CONCURRENCY (single-flight):
//    An in-process lock keyed by `provider:episodeId` ensures only ONE
//    AnimeHeaven resolution happens for concurrent first plays. Waiters
//    re-check the DB cache after acquiring the lock (double-check) to avoid
//    duplicate upstream resolutions. The lock is in-memory only; the actual
//    cache is MySQL-backed and survives server restarts.
//
//  FAILURE SAFETY:
//    Every DB operation is wrapped so a cache failure never breaks playback.
//    On any cache error the caller falls through to normal AnimeHeaven
//    resolution.
//
//  SECURITY / PRIVACY:
//    • No user-specific data (JWT, user IDs, premium status, auth headers)
//      is ever stored.
//    • Raw stream URLs/cookies are never logged.
// ============================================================
'use strict';

const db = require('../config/db');
const logger = require('../utils/logger');
const config = require('../config/streamCache');
const { request } = require('../utils/providerHttp');
const inFlightResolverManager = require('./inFlightResolverManager');

// ── Cache-source liveness probe ────────────────────────────
// A lightweight, FAIL-OPEN HEAD probe used to make cache-token freshness
// decisions robust WITHOUT coupling the proxy layer to the DB. It only ever
// returns `false` (dead) on an EXPLICIT, authoritative rejection: HTTP 403/404
// from the AnimeHeaven CDN. On any other outcome (network error, timeout,
// 2xx/5xx, redirect, or any unexpected result) it returns `true` so playback
// is NEVER broken by the probe itself. This lets the resolver detect an
// expired/revoked CDN token on a persistent-cache hit and fall back to a fresh
// AnimeHeaven resolution (gate.php → new token).
const SOURCE_PROBE_TIMEOUT_MS = Number(process.env.STREAM_CACHE_SOURCE_PROBE_TIMEOUT_MS || 4000);

/**
 * Probe a single cached source URL for aliveness. FAIL-OPEN.
 *
 * @param {string} url - the raw (pre-proxy) AnimeHeaven CDN source URL
 * @param {object} [context] - { referer, origin } used when probing
 * @returns {Promise<boolean>} `true` = likely alive / unknown (serve the cache);
 *   `false` = explicitly dead (403/404) — caller should invalidate & re-resolve.
 */
async function isCachedSourceAlive(url, context = {}) {
  if (!url) return true; // fail-open: nothing to probe
  const extraHeaders = {};
  if (context.referer) extraHeaders.Referer = String(context.referer);
  if (context.origin) extraHeaders.Origin = String(context.origin);

  try {
    // axios (via providerHttp.request) rejects on non-2xx. A HEAD that
    // resolves means 2xx/3xx → alive. Catch handles explicit 403/404 below.
    await request(
      { method: 'head', url, maxRedirects: 3 },
      {
        providerName: config.provider,
        streaming: true,
        skipProxy: true,
        dontTrackHealth: true,
        extraHeaders,
        timeout: SOURCE_PROBE_TIMEOUT_MS,
      }
    );
    return true; // 2xx/3xx (or a resolved HEAD) → source is alive
  } catch (err) {
    const status = Number(err?.response?.status || 0);
    // Only explicit 403/404 mean the token/context is rejected/dead.
    if (status === 403 || status === 404) return false;
    // Network error / timeout / 5xx / 429 / redirect-loop etc. — cannot
    // conclude it is dead. Fail-open: keep the cached source (playback must
    // not break).
    return true;
  }
}

/**
 * Check whether a cached row is still valid (not expired).
 * @param {object} row - DB row
 * @param {number} now - Date.now()
 * @returns {boolean}
 */
function isExpired(row, now = Date.now()) {
  if (!row || !row.expires_at) return true;
  const expiry = new Date(row.expires_at).getTime();
  return !Number.isFinite(expiry) || expiry <= now;
}

/**
 * Reconstruct a provider-result-shaped object from a cached stream_data row.
 * This mirrors the shape returned by streamingService.normalizeProviderResult
 * so the caller can feed it through the same tier filtering + proxy pipeline.
 *
 * @param {object} row - DB row with a parsed `stream_data` object
 * @returns {object|null} { provider, streamUrl, sources, subtitles } or null
 */
function reconstructProviderResult(row) {
  if (!row || !row.stream_data) return null;
  const data = row.stream_data;
  const sources = Array.isArray(data.sources) ? data.sources : [];
  if (sources.length === 0) return null;

  return {
    provider: data.provider || row.provider || config.provider,
    streamUrl: data.streamUrl || (sources[0].url || null),
    sources,
    subtitles: Array.isArray(data.subtitles) ? data.subtitles : [],
  };
}

/**
 * Find a valid (non-expired) cached stream for an episode+provider.
 * Returns re-constructed provider-result data, or null if missing/expired.
 *
 * On any DB error this logs and returns null so the caller resolves normally.
 *
 * @param {number|string} episodeId
 * @param {string} provider
 * @returns {Promise<{row: object|null, result: object|null}>}
 */
async function findCachedStream(episodeId, provider) {
  if (!episodeId) return { row: null, result: null };
  try {
    const [rows] = await db.query(
      'SELECT id, episode_id, provider, stream_type, stream_data, expires_at, last_used_at ' +
      'FROM episode_stream_cache WHERE episode_id = ? AND provider = ? LIMIT 1',
      [episodeId, provider]
    );
    const row = rows && rows[0] ? rows[0] : null;
    if (!row) return { row: null, result: null };

    // Parse stream_data (mysql2 returns JSON columns as parsed objects).
    let data = row.stream_data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (_) { data = null; }
    }
    if (!data || !Array.isArray(data.sources) || data.sources.length === 0) {
      // Malformed/empty cache — treat as a miss.
      return { row, result: null };
    }
    row.stream_data = data;

    if (isExpired(row)) {
      logger.info('[STREAM_CACHE] EXPIRED', { episodeId, provider });
      return { row, result: null };
    }

// Refresh last_used_at opportunistically (best-effort, non-fatal).
    markUsed(row.id).catch(() => {});

    logger.info('[STREAM_CACHE] HIT', { episodeId, provider });
    return { row, result: reconstructProviderResult(row) };
  } catch (err) {
    logger.warn('[STREAM_CACHE] FAILURE (find)', { episodeId, provider, error: err.message });
    return { row: null, result: null };
  }
}

/**
 * Save (or upsert) a successfully-resolved provider result into the cache.
 * Uses INSERT ... ON DUPLICATE KEY UPDATE so a single row per (episode,provider)
 * is maintained — no duplicate rows on repeated playback.
 *
 * @param {number|string} episodeId
 * @param {string} provider
 * @param {object} providerResult - { provider, streamUrl, sources, subtitles }
 * @param {number} [ttlMin] - optional override TTL in minutes
 * @returns {Promise<boolean>} success
 */
async function saveStream(episodeId, provider, providerResult, ttlMin) {
  if (!episodeId || !providerResult) return false;
  // Effective TTL: an explicit override wins, otherwise the clamped safe TTL
  // (config.safeTtlMinutes) is used so the cache never outlives the AnimeHeaven
  // CDN playback-context lifetime.
  const ttl = ttlMin || config.safeTtlMinutes;
  const now = new Date();
  const expires = new Date(now.getTime() + ttl * 60 * 1000);

  // Infer stream type from the source URL (HLS manifest vs direct media).
  const firstSourceUrl = providerResult.sources?.[0]?.url || providerResult.streamUrl || '';
  const streamType = /\.m3u8(\?|$)/i.test(firstSourceUrl) ? 'hls' : 'direct';

  const payload = {
    provider: providerResult.provider || provider,
    streamUrl: providerResult.streamUrl || (providerResult.sources?.[0]?.url || null),
    sources: providerResult.sources || [],
    subtitles: Array.isArray(providerResult.subtitles) ? providerResult.subtitles : [],
  };

  try {
    await db.query(
      `INSERT INTO episode_stream_cache
         (episode_id, provider, stream_type, stream_data, resolved_at, expires_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         stream_type = VALUES(stream_type),
         stream_data = VALUES(stream_data),
         resolved_at = VALUES(resolved_at),
         expires_at = VALUES(expires_at),
         last_used_at = VALUES(last_used_at)`,
      [episodeId, provider, streamType, JSON.stringify(payload), now, expires, now]
    );
    logger.info('[STREAM_CACHE] SAVE', { episodeId, provider, ttlMin: ttl, streamType });
    return true;
  } catch (err) {
    // Migration not applied / table missing / other DB error — never break playback.
    logger.warn('[STREAM_CACHE] FAILURE (save)', { episodeId, provider, error: err.message });
    return false;
  }
}

/**
 * Delete an invalid/expired cache row (best-effort).
 * @param {number|string} episodeId
 * @param {string} provider
 * @returns {Promise<boolean>}
 */
async function deleteInvalidCache(episodeId, provider) {
  if (!episodeId) return false;
  try {
    await db.query('DELETE FROM episode_stream_cache WHERE episode_id = ? AND provider = ?', [episodeId, provider]);
    logger.info('[STREAM_CACHE] DELETE', { episodeId, provider });
    return true;
  } catch (err) {
    logger.warn('[STREAM_CACHE] FAILURE (delete)', { episodeId, provider, error: err.message });
    return false;
  }
}

/**
 * Best-effort, non-fatal: mark a cache row as last-used.
 * @param {number} id - cache row id
 */
async function markUsed(id) {
  if (!id) return;
  try {
    await db.query('UPDATE episode_stream_cache SET last_used_at = ? WHERE id = ?', [new Date(), id]);
  } catch (_) {
    // non-fatal
  }
}

/**
 * Single-flight resolution wrapper using the InFlightResolverManager.
 *
 * TRUE SINGLE-FLIGHT guarantees:
 *   • Only ONE resolver runs per (provider, episodeId) at any time.
 *   • On timeout the lock is NOT released — the resolver continues and the
 *     entry stays registered until it settles (success or failure).
 *   • A late success is NEVER discarded — it is cached (memory + persistent)
 *     and delivered to all waiters.
 *   • Waiting requests attach to the existing resolver — NO duplicate
 *     AnimeHeaven executions.
 *
 * Flow:
 *   1. Check the in-flight manager's memory cache (recently-resolved result).
 *   2. DB cache check — if a concurrent request persisted it, use it.
 *   3. Register with the InFlightResolverManager (starts OR attaches).
 *   4. Await the shared resolver promise — all waiters get the same result.
 *
 * @param {number|string} episodeId
 * @param {string} provider
 * @param {() => Promise<object|null>} resolver - returns provider result
 * @returns {Promise<object|null>} provider result (cached or fresh)
 */
async function getOrResolve(episodeId, provider, resolver) {
  if (!episodeId) return resolver();
  const key = inFlightResolverManager.keyFor(provider, episodeId);

  // 1. Fast-path: in-memory cache (a recently-successful result, before it
  //    reaches the DB cache on the next request).
  const memCached = inFlightResolverManager.getCached(key);
  if (memCached && memCached.sources && memCached.sources.length > 0) {
    logger.info('[STREAM_CACHE] MEMORY_HIT', { episodeId, provider });
    return memCached;
  }

  // 2. DB cache check — a concurrent request may have persisted a result.
  const second = await findCachedStream(episodeId, provider);
  if (second.result) {
    logger.info('[STREAM_CACHE] LOCK_HIT', { episodeId, provider });
    return second.result;
  }

  // 3. Register with the single-flight manager. If a resolver is already
  //    in-flight for this key, this ATTACHES to it (no duplicate execution).
  //    If a settled entry is still present (within grace), it returns the
  //    cached result. Otherwise it starts ONE resolver.
  const { promise } = inFlightResolverManager.register(key, async () => {
    // Run the resolver ONCE. Normalize the output to a provider result.
    const fresh = await resolver();
    const providerResult =
      fresh &&
      !Array.isArray(fresh.sources) &&
      Array.isArray(fresh.result && fresh.result.sources)
        ? fresh.result
        : fresh;

    // Persist a successful result to the persistent cache — a late success
    // is NEVER discarded. The manager also caches it in memory.
    if (providerResult && Array.isArray(providerResult.sources) && providerResult.sources.length > 0) {
      await saveStream(episodeId, provider, providerResult);
    }
    return providerResult;
  });

  // 4. Await the SHARED resolver promise. There is NO per-caller timeout that
  //    abandons the result — the resolver runs to completion and all waiters
  //    receive the same eventual result. (The manager's soft timeout only
  //    records observability; it never cancels the resolver or releases the lock.)
  return await promise;
}

// ── Optional background expiry sweeper ────────────────────
// Lightweight, best-effort cleanup of expired cache rows using the existing
// `expires_at` index. It is deliberately NON-blocking for playback:
//   • Runs on a low-frequency interval (default 30 min), NOT per-request.
//   • Any failure is swallowed — it can never affect playback.
//   • The interval is unref'd so it does not prevent a clean process shutdown.
//   • Only rows whose expires_at has passed are deleted (never valid rows).
const SWEEP_INTERVAL_MS = Number(process.env.STREAM_CACHE_SWEEP_INTERVAL_MS || 30 * 60 * 1000);

/**
 * Delete expired cache rows (best-effort). Never throws.
 * @returns {Promise<number>} number of rows deleted
 */
async function sweepExpired() {
  try {
    const [result] = await db.query(
      'DELETE FROM episode_stream_cache WHERE expires_at <= ?',
      [new Date()]
    );
    const deleted = result?.affectedRows || 0;
    if (deleted > 0) {
      logger.info('[STREAM_CACHE] SWEEP', { deleted });
    }
    return deleted;
  } catch (err) {
    logger.warn('[STREAM_CACHE] FAILURE (sweep)', { error: err.message });
    return 0;
  }
}

/**
 * Start the background expiry sweeper (idempotent). The interval is unref'd
 * so it never blocks a clean shutdown. Only started when enabled.
 */
function startSweeper() {
  if (startSweeper._started) return;
  startSweeper._started = true;
  const timer = setInterval(() => {
    sweepExpired().catch(() => {});
  }, SWEEP_INTERVAL_MS);
  if (timer.unref) timer.unref();
  timer._anistrimStreamCache = true;
  process.on('exit', () => {
    if (timer && timer._anistrimStreamCache && typeof timer.unref === 'function') {
      clearInterval(timer);
    }
  });
}

module.exports = {
  findCachedStream,
  saveStream,
  deleteInvalidCache,
  isExpired,
  getOrResolve,
  sweepExpired,
  startSweeper,
  isCachedSourceAlive,
  // Expose the single-flight manager for observability + tests.
  inFlightResolverManager,
};

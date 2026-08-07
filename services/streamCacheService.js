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

// ── In-process single-flight lock ──────────────────────────
// Map<`provider:episodeId`, Promise>. The actual cache remains MySQL-backed;
// this lock only deduplicates concurrent resolutions within this process.
const locks = new Map();

function lockKey(provider, episodeId) {
  return `${String(provider).toLowerCase()}:${episodeId}`;
}

/**
 * Acquire the single-flight lock for a (provider, episodeId) pair.
 * Returns a release function. If another request holds the lock, this waits
 * for it to settle (resolve or reject) before returning.
 *
 * @param {string} provider
 * @param {number|string} episodeId
 * @returns {Promise<() => void>} release function
 */
async function acquireLock(provider, episodeId) {
  const key = lockKey(provider, episodeId);
  for (;;) {
    const existing = locks.get(key);
    if (!existing) break;
    try {
      await existing;
    } catch (_) {
      // The previous holder failed; fall through and try to acquire.
    }
  }
  // Register a promise that resolves when the current holder finishes.
  let release;
  const done = new Promise((resolve) => { release = resolve; });
  locks.set(key, done);
  return () => {
    if (locks.get(key) === done) locks.delete(key);
    release();
  };
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
  const ttl = ttlMin || config.ttlMinutes;
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
 * Single-flight resolution wrapper: given an async resolver for AnimeHeaven,
 * guarantee only ONE upstream resolution per (provider,episodeId) for
 * concurrent requests, with a mandatory second DB cache check after acquiring
 * the lock.
 *
 * Flow:
 *   1. Fast-path DB cache check (already done by caller before calling this).
 *   2. Acquire in-process lock.
 *   3. SECOND DB cache check — if a concurrent holder populated it, use it.
 *   4. Otherwise run `resolver()` once, save to cache, return.
 *
 * @param {number|string} episodeId
 * @param {string} provider
 * @param {() => Promise<object|null>} resolver - returns provider result
 * @returns {Promise<object|null>} provider result (cached or fresh)
 */
async function getOrResolve(episodeId, provider, resolver) {
  if (!episodeId) return resolver();
  const release = await acquireLock(provider, episodeId);
  try {
    // Mandatory second cache check — a concurrent request may have just
    // populated the cache while we were waiting for the lock.
    const second = await this.findCachedStream(episodeId, provider);
    if (second.result) {
      logger.info('[STREAM_CACHE] LOCK_HIT', { episodeId, provider });
      return second.result;
    }

    const fresh = await resolver();
    if (fresh && Array.isArray(fresh.sources) && fresh.sources.length > 0) {
      await this.saveStream(episodeId, provider, fresh);
    }
    return fresh;
  } finally {
    release();
  }
}

module.exports = {
  findCachedStream,
  saveStream,
  deleteInvalidCache,
  isExpired,
  getOrResolve,
  // Exposed for tests/diagnostics.
  lockKey,
};

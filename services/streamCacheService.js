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
const cache = require('../utils/cacheService');
const streamCacheMetrics = require('./streamCacheMetrics');
const streamDiag = require('../utils/streamDiagnostics');

// Redis key prefix for stream sources.
const REDIS_STREAM_KEY_PREFIX = 'stream:source:';

/**
 * Build the Redis cache key for an episode+provider.
 * @param {number|string} episodeId
 * @param {string} provider
 * @returns {string}
 */
function buildRedisKey(episodeId, provider) {
  return `${REDIS_STREAM_KEY_PREFIX}${provider}:${episodeId}`;
}

/**
 * Redis TTL in seconds — matches the MySQL cache TTL so Redis entries expire
 * at the same time as MySQL entries, avoiding stale data if the MySQL sweep
 * hasn't run yet.
 */
const REDIS_TTL_SECONDS = config.ttlMinutes * 60;

// ── Source URL Expiry Detection ────────────────────────────
// Parses resolved source URLs for reliable expiry indicators.
// Supports common expiry parameter names and timestamp formats.
// Returns { detectedExpiresAt: Date|null, expirySource: 'url'|'header'|'unknown' }

// Known expiry parameter names (case-insensitive).
const EXPIRY_PARAM_NAMES = new Set([
  'expires', 'expiry', 'exp', 'expires_at', 'expiration',
  'expire', 'token_expires', 'token_expiry',
]);

// Minimum timestamp threshold: 2020-01-01 in Unix seconds.
// Any numeric value below this is NOT a valid timestamp.
const MIN_VALID_TIMESTAMP = 1577836800;

/**
 * Parse a numeric string as a Unix timestamp (seconds or milliseconds).
 * Returns a Date if valid, null otherwise.
 * @param {string} value
 * @returns {Date|null}
 */
function parseTimestamp(value) {
  if (!value || typeof value !== 'string') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < MIN_VALID_TIMESTAMP) return null;
  // If the value is > 1e12, it's likely milliseconds; otherwise seconds.
  const ms = num > 1e12 ? num : num * 1000;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  return date;
}

/**
 * Detect expiry from a source URL's query parameters.
 * Only recognizes known expiry parameter names with reliable timestamp formats.
 * @param {string} url
 * @returns {{ detectedExpiresAt: Date|null, expirySource: string }}
 */
function detectExpiryFromUrl(url) {
  if (!url || typeof url !== 'string') {
    return { detectedExpiresAt: null, expirySource: 'unknown' };
  }

  try {
    const urlObj = new URL(url);
    for (const [key, value] of urlObj.searchParams.entries()) {
      const keyLower = key.toLowerCase();
      if (EXPIRY_PARAM_NAMES.has(keyLower)) {
        const date = parseTimestamp(value);
        if (date) {
          return { detectedExpiresAt: date, expirySource: 'url' };
        }
      }
    }
  } catch (e) {
    // Invalid URL — cannot parse expiry.
    return { detectedExpiresAt: null, expirySource: 'unknown' };
  }

  return { detectedExpiresAt: null, expirySource: 'unknown' };
}

/**
 * Detect expiry from HTTP response headers.
 * Recognizes Cache-Control max-age, Expires header.
 * @param {object} headers - Response headers object
 * @param {number} requestTime - Date.now() when the request was made
 * @returns {{ detectedExpiresAt: Date|null, expirySource: string }}
 */
function detectExpiryFromHeaders(headers, requestTime) {
  if (!headers || typeof headers !== 'object') {
    return { detectedExpiresAt: null, expirySource: 'unknown' };
  }

  // Check Cache-Control for max-age
  const cacheControl = headers['cache-control'] || headers['Cache-Control'] || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  if (maxAgeMatch) {
    const maxAge = parseInt(maxAgeMatch[1], 10);
    if (Number.isFinite(maxAge) && maxAge > 0) {
      return {
        detectedExpiresAt: new Date(requestTime + maxAge * 1000),
        expirySource: 'header',
      };
    }
  }

  // Check Expires header
  const expiresHeader = headers['expires'] || headers['Expires'];
  if (expiresHeader) {
    const date = new Date(expiresHeader);
    if (Number.isFinite(date.getTime())) {
      return { detectedExpiresAt: date, expirySource: 'header' };
    }
  }

  return { detectedExpiresAt: null, expirySource: 'unknown' };
}

/**
 * Detect the earliest expiry from all sources in a provider result.
 * Checks each source URL for expiry parameters.
 * @param {object} providerResult - { sources: [{url, ...}], ... }
 * @returns {{ detectedExpiresAt: Date|null, expirySource: string }}
 */
function detectSourceExpiry(providerResult) {
  if (!providerResult || !Array.isArray(providerResult.sources)) {
    return { detectedExpiresAt: null, expirySource: 'unknown' };
  }

  let earliestExpiry = null;
  let earliestSource = 'unknown';

  for (const source of providerResult.sources) {
    const { detectedExpiresAt, expirySource } = detectExpiryFromUrl(source.url);
    if (detectedExpiresAt) {
      if (!earliestExpiry || detectedExpiresAt < earliestExpiry) {
        earliestExpiry = detectedExpiresAt;
        earliestSource = expirySource;
      }
    }
  }

  // Also check the top-level streamUrl if sources didn't yield an expiry.
  if (!earliestExpiry && providerResult.streamUrl) {
    const { detectedExpiresAt, expirySource } = detectExpiryFromUrl(providerResult.streamUrl);
    if (detectedExpiresAt) {
      earliestExpiry = detectedExpiresAt;
      earliestSource = expirySource;
    }
  }

  return {
    detectedExpiresAt: earliestExpiry,
    expirySource: earliestSource,
  };
}

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

// ── Cheap Source Verification (HEAD/Range) ─────────────────
// Verifies a cached source URL without downloading the full media.
// Order: HEAD → Range(0-1023) → fail-open.
// Records verification results in episode_stream_cache.
const VERIFY_TIMEOUT_MS = Number(process.env.STREAM_VERIFY_TIMEOUT_MS || 5000);
const RANGE_SIZE = 1024; // Only fetch first 1KB for verification

// Known media content types.
const MEDIA_CONTENT_TYPES = new Set([
  'video/mp4', 'video/webm', 'video/ogg',
  'application/vnd.apple.mpegurl', 'application/x-mpegurl',
  'application/octet-stream', // Some CDNs return this for MP4
  'audio/mp4', 'audio/aac',
]);

/**
 * Verify a single cached source URL using HEAD request.
 * Falls back to Range request if HEAD is unsupported (405).
 * NEVER downloads the full media — Range request fetches only first 1KB.
 *
 * @param {string} url - the raw (pre-proxy) CDN source URL
 * @param {object} [context] - { referer, origin } used when probing
 * @returns {Promise<{status: number|null, contentType: string|null, alive: boolean}>}
 */
async function verifySource(url, context = {}) {
  if (!url) return { status: null, contentType: null, alive: true }; // fail-open

  const extraHeaders = {};
  if (context.referer) extraHeaders.Referer = String(context.referer);
  if (context.origin) extraHeaders.Origin = String(context.origin);

  // Step 1: Try HEAD request.
  try {
    const response = await request(
      { method: 'head', url, maxRedirects: 3 },
      {
        providerName: config.provider,
        streaming: true,
        skipProxy: true,
        dontTrackHealth: true,
        extraHeaders,
        timeout: VERIFY_TIMEOUT_MS,
      }
    );
    // HEAD succeeded — extract status and content type from response.
    return {
      status: response.status || 200,
      contentType: response.headers?.['content-type'] || null,
      alive: true,
    };
  } catch (headErr) {
    const headStatus = Number(headErr?.response?.status || 0);

    // HEAD returned 405 (Method Not Allowed) — try Range fallback.
    if (headStatus === 405) {
      return verifySourceWithRange(url, context, extraHeaders);
    }

    // Explicit dead: 403/404.
    if (headStatus === 403 || headStatus === 404) {
      return { status: headStatus, contentType: null, alive: false };
    }

    // Any other HEAD failure (timeout, 5xx, network error) — fail-open.
    return { status: headStatus, contentType: null, alive: true };
  }
}

/**
 * Fallback verification using a Range request (first 1KB only).
 * Used when HEAD returns 405 (Method Not Allowed).
 * NEVER downloads the full media — only requests bytes 0-1023.
 *
 * @param {string} url
 * @param {object} context
 * @param {object} extraHeaders
 * @returns {Promise<{status: number|null, contentType: string|null, alive: boolean}>}
 */
async function verifySourceWithRange(url, context, extraHeaders) {
  const rangeHeaders = { ...extraHeaders, Range: `bytes=0-${RANGE_SIZE - 1}` };

  try {
    const response = await request(
      { method: 'get', url, maxRedirects: 3 },
      {
        providerName: config.provider,
        streaming: true,
        skipProxy: true,
        dontTrackHealth: true,
        extraHeaders: rangeHeaders,
        timeout: VERIFY_TIMEOUT_MS,
      }
    );
    return {
      status: response.status || 200,
      contentType: response.headers?.['content-type'] || null,
      alive: true,
    };
  } catch (rangeErr) {
    const rangeStatus = Number(rangeErr?.response?.status || 0);

    // Explicit dead: 403/404.
    if (rangeStatus === 403 || rangeStatus === 404) {
      return { status: rangeStatus, contentType: null, alive: false };
    }

    // Any other failure — fail-open.
    return { status: rangeStatus, contentType: null, alive: true };
  }
}

/**
 * Verify a cached source and record the result in episode_stream_cache.
 * Updates: last_verified_at, verification_status, response_status, content_type,
 *          last_failed_at (on failure).
 *
 * @param {number} cacheRowId - the DB row id
 * @param {string} url - the source URL to verify
 * @param {object} [context] - { referer, origin }
 * @returns {Promise<{alive: boolean, status: number|null, contentType: string|null}>}
 */
async function verifyAndRecord(cacheRowId, url, context = {}) {
  const result = await verifySource(url, context);
  const now = new Date();

  try {
    if (result.alive) {
      // Update observation tracking: first success, last success, lifetime.
      await db.query(
        `UPDATE episode_stream_cache
         SET last_verified_at = ?,
             verification_status = ?,
             response_status = ?,
             content_type = ?,
             observed_first_success_at = COALESCE(observed_first_success_at, ?),
             observed_last_success_at = ?,
             observed_lifetime_seconds = TIMESTAMPDIFF(SECOND, COALESCE(observed_first_success_at, ?), ?)
         WHERE id = ?`,
        [now, 'active', result.status, result.contentType, now, now, now, now, cacheRowId]
      );
      streamCacheMetrics.increment('verificationSuccesses');
    } else {
      // Update observation tracking: first failure.
      await db.query(
        `UPDATE episode_stream_cache
         SET last_verified_at = ?,
             verification_status = ?,
             response_status = ?,
             content_type = ?,
             last_failed_at = ?,
             observed_first_failure_at = COALESCE(observed_first_failure_at, ?)
         WHERE id = ?`,
        [now, 'invalid', result.status, result.contentType, now, now, cacheRowId]
      );
      streamCacheMetrics.increment('verificationFailures');
    }
  } catch (err) {
    logger.warn('[STREAM_CACHE] FAILURE (verify record)', { cacheRowId, error: err.message });
  }

  return result;
}

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
  const _probeStart = Date.now();

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
    // DIAG: log successful probe
    streamDiag.logCacheProbe(url, { method: 'head', skipProxy: true, hadCookies: false, hadReferer: !!context.referer, hadOrigin: !!context.origin }, { status: 200, contentType: null, alive: true, durationMs: Date.now() - _probeStart });
    return true; // 2xx/3xx (or a resolved HEAD) → source is alive
  } catch (err) {
    const status = Number(err?.response?.status || 0);
    const probeResult = { status, contentType: null, alive: false, durationMs: Date.now() - _probeStart };
    // Only explicit 403/404 mean the token/context is rejected/dead.
    if (status === 403 || status === 404) {
      streamDiag.logCacheProbe(url, { method: 'head', skipProxy: true, hadCookies: false, hadReferer: !!context.referer, hadOrigin: !!context.origin }, { ...probeResult, alive: false });
      return false;
    }
    // Network error / timeout / 5xx / 429 / redirect-loop etc. — cannot
    // conclude it is dead. Fail-open: keep the cached source (playback must
    // not break).
    streamDiag.logCacheProbe(url, { method: 'head', skipProxy: true, hadCookies: false, hadReferer: !!context.referer, hadOrigin: !!context.origin }, { ...probeResult, alive: true });
    return true;
  }
}

/**
 * Determine the source state for a cached row.
 *
 * States:
 *   ACTIVE    — Source is known to be valid (verified recently or within AniStrim TTL)
 *   EXPIRED   — Upstream expiry (detected_expires_at) has passed
 *   INVALID   — Verification or playback failure marked it unusable
 *   UNKNOWN   — No upstream expiry known, verification status unknown or stale
 *
 * NEVER classifies "no expiry detected" as "permanent".
 *
 * @param {object} row - DB row from episode_stream_cache
 * @param {number} now - Date.now()
 * @returns {string} 'active' | 'expired' | 'invalid' | 'unknown'
 */
function getSourceState(row, now = Date.now()) {
  if (!row) return 'unknown';

  // Rule 1: If detected_expires_at exists and is in the past → EXPIRED.
  if (row.detected_expires_at) {
    const detectedExpiry = new Date(row.detected_expires_at).getTime();
    if (Number.isFinite(detectedExpiry) && detectedExpiry <= now) {
      return 'expired';
    }
  }

  // Rule 3: If verification_status is 'invalid' → INVALID.
  if (row.verification_status === 'invalid') {
    return 'invalid';
  }

  // Rule 2: If source has recently verified successfully → ACTIVE.
  if (row.verification_status === 'active' && row.last_verified_at) {
    return 'active';
  }

  // Rule 4: If AniStrim's cache TTL (expires_at) has passed → treat as expired.
  if (isExpired(row, now)) {
    return 'expired';
  }

  // Rule 4 continued: No upstream expiry known, but within AniStrim TTL → UNKNOWN.
  // This means the source may still be valid, but we don't know for sure.
  return 'unknown';
}

/**
 * Check whether a cached row is reusable based on its source state.
 *
 * Reuse rules:
 *   ACTIVE    → reuse
 *   EXPIRED   → do not reuse
 *   INVALID   → do not reuse
 *   UNKNOWN   → reuse (within AniStrim TTL); verification will happen on next play
 *
 * @param {object} row - DB row from episode_stream_cache
 * @param {number} now - Date.now()
 * @returns {boolean}
 */
function isReusable(row, now = Date.now()) {
  const state = getSourceState(row, now);
  return state === 'active' || state === 'unknown';
}

/**
 * Check whether a cached row is still valid (not expired).
 * Kept for backward compatibility with existing callers.
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
 * Find a valid (non-expired, non-invalid) cached stream for an episode+provider.
 * Returns re-constructed provider-result data, or null if missing/expired/invalid.
 *
 * Uses the source state machine to determine reusability:
 *   ACTIVE/UNKNOWN → reuse (return cached result)
 *   EXPIRED/INVALID → do not reuse (return null, trigger resolution)
 *
 * On any DB error this logs and returns null so the caller resolves normally.
 *
 * @param {number|string} episodeId
 * @param {string} provider
 * @returns {Promise<{row: object|null, result: object|null, state: string|null}>}
 */
async function findCachedStream(episodeId, provider) {
  if (!episodeId) return { row: null, result: null, state: null };
  try {
    const [rows] = await db.query(
      'SELECT id, episode_id, provider, stream_type, stream_data, expires_at, ' +
      'detected_expires_at, expiry_source, verification_status, last_used_at, last_verified_at, ' +
      'url_classification, classification_confidence, classification_reason, ' +
      'observed_first_success_at, observed_last_success_at, observed_first_failure_at, observed_lifetime_seconds ' +
      'FROM episode_stream_cache WHERE episode_id = ? AND provider = ? LIMIT 1',
      [episodeId, provider]
    );
    const row = rows && rows[0] ? rows[0] : null;
    if (!row) return { row: null, result: null, state: null };

    // Parse stream_data (mysql2 returns JSON columns as parsed objects).
    let data = row.stream_data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (_) { data = null; }
    }
    if (!data || !Array.isArray(data.sources) || data.sources.length === 0) {
      // Malformed/empty cache — treat as a miss.
      streamCacheMetrics.increment('invalidSources');
      return { row, result: null, state: 'invalid' };
    }
    row.stream_data = data;

    // Determine source state using the state machine.
    const now = Date.now();
    const state = getSourceState(row, now);

    if (!isReusable(row, now)) {
      logger.info('[STREAM_CACHE] NOT_REUSABLE', {
        episodeId, provider, state,
        detectedExpiresAt: row.detected_expires_at,
        verificationStatus: row.verification_status,
      });
      if (state === 'expired') streamCacheMetrics.increment('expiredSources');
      if (state === 'invalid') streamCacheMetrics.increment('invalidSources');
      return { row, result: null, state };
    }

    // Refresh last_used_at opportunistically (best-effort, non-fatal).
    markUsed(row.id).catch(() => {});

    logger.info('[STREAM_CACHE] HIT', { episodeId, provider, state });
    return { row, result: reconstructProviderResult(row), state };
// ── DIAG: log cache hit with context age check ──────────
    try {
      const { getPlaybackContext } = require('./animeHeavenProvider');
      const result = reconstructProviderResult(row);
      const firstSrc = result?.sources?.[0];
      const playbackCtx = getPlaybackContext(firstSrc?.url, firstSrc?.referer || null);
      const cacheAge = row.resolved_at ? Date.now() - new Date(row.resolved_at).getTime() : 0;
      const remaining = new Date(row.expires_at).getTime() - Date.now();
      streamDiag.logCacheHit(episodeId, provider, row, result, cacheAge, remaining, playbackCtx);
    } catch (_) { /* non-fatal diagnostic */ }
  } catch (err) {
    logger.warn('[STREAM_CACHE] FAILURE (find)', { episodeId, provider, error: err.message });
    return { row: null, result: null, state: null };
  }
}

/**
 * Classify a cached stream source based on available evidence.
 *
 * Classification rules:
 *   TEMPORARY:
 *     - explicit URL expiry detected (detected_expires_at is set)
 *     - or verification_status is 'invalid' after a previous successful check
 *     - or observed_first_failure_at is set (source has been seen to fail)
 *
 *   STABLE:
 *     - no detected URL expiry
 *     - verification_status is 'active' for at least 24 hours
 *     - at least 3 successful observations
 *     - no observed failures
 *
 *   UNKNOWN:
 *     - insufficient evidence for either TEMPORARY or STABLE
 *
 * Confidence:
 *   HIGH:   multiple independent evidence sources agree
 *   MEDIUM: one meaningful evidence source
 *   LOW:    insufficient observation history
 *
 * @param {object} row - DB row from episode_stream_cache
 * @param {number} [now] - Optional timestamp override (for testing)
 * @returns {{ classification: string, confidence: string, reason: string }}
 */
function classifySource(row, now = Date.now()) {
  if (!row) return { classification: 'UNKNOWN', confidence: 'LOW', reason: 'No cache row.' };

  const evidence = [];

  // ── Check for TEMPORARY evidence ──────────────────────────
  const isTemporary = [];

  // Explicit URL expiry parameter detected.
  if (row.detected_expires_at) {
    const detectedExpiry = new Date(row.detected_expires_at).getTime();
    if (Number.isFinite(detectedExpiry)) {
      isTemporary.push(true);
      evidence.push('explicit URL expiry detected');
    }
  }

  // Previously successful source now invalid.
  if (row.verification_status === 'invalid' && row.last_verified_at) {
    isTemporary.push(true);
    evidence.push('source was previously valid, now invalid');
  }

  // Source has been observed to fail.
  if (row.observed_first_failure_at) {
    isTemporary.push(true);
    evidence.push('source has been observed to fail');
  }

  // ── Check for STABLE evidence ────────────────────────────
  const isStable = [];

  // No detected URL expiry.
  if (!row.detected_expires_at && row.expiry_source === 'unknown') {
    isStable.push(true);
    evidence.push('no URL expiry detected');
  }

  // Repeated successful observations over time.
  if (row.observed_first_success_at && row.observed_last_success_at) {
    const firstSuccess = new Date(row.observed_first_success_at).getTime();
    const lastSuccess = new Date(row.observed_last_success_at).getTime();
    const observationDurationMs = lastSuccess - firstSuccess;

    if (observationDurationMs >= 24 * 60 * 60 * 1000) {
      isStable.push(true);
      evidence.push('observed healthy for at least 24 hours');
    }
    // Count successful observations via failure_count not being elevated.
    if (row.failure_count === 0) {
      isStable.push(true);
      evidence.push('no observed failures');
    }
  }

  // ── Determine classification ──────────────────────────────
  let classification = 'UNKNOWN';
  let confidence = 'LOW';

  if (isTemporary.length > 0 && isStable.length === 0) {
    // TEMPORARY evidence exists and there is no countervailing STABLE evidence.
    classification = 'TEMPORARY';
    confidence = isTemporary.length >= 2 ? 'HIGH' : 'MEDIUM';
  } else if (isStable.length >= 2 && isTemporary.length === 0) {
    // Multiple STABLE evidence sources and no TEMPORARY evidence.
    classification = 'STABLE';
    confidence = isStable.length >= 3 ? 'HIGH' : 'MEDIUM';
  } else if (isStable.length > 0 && isTemporary.length > 0) {
    // Conflicting evidence — TEMPORARY wins (conservative).
    classification = 'TEMPORARY';
    confidence = 'LOW';
  } else {
    classification = 'UNKNOWN';
    confidence = 'LOW';
  }

  // Ensure 24-hour observation requirement for STABLE.
  if (classification === 'STABLE') {
    if (row.observed_first_success_at && row.observed_last_success_at) {
      const firstSuccess = new Date(row.observed_first_success_at).getTime();
      const lastSuccess = new Date(row.observed_last_success_at).getTime();
      if (lastSuccess - firstSuccess < 24 * 60 * 60 * 1000) {
        classification = 'UNKNOWN';
        confidence = 'LOW';
        evidence.push('observation period < 24 hours');
      }
    } else {
      classification = 'UNKNOWN';
      confidence = 'LOW';
      evidence.push('no observation history');
    }
  }

  return {
    classification,
    confidence,
    reason: evidence.length > 0 ? evidence.join('; ') : 'insufficient evidence',
  };
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
  // Effective TTL: an explicit override wins, otherwise the configured global
  // TTL is used.  If per-source URL expiry detection found an expiration
  // parameter in the source URL (detectedExpiresAt), the effective expiry is
  // further bounded by that value below.
  const ttl = ttlMin || config.ttlMinutes;
  const now = new Date();
  const expires = new Date(now.getTime() + ttl * 60 * 1000);

  // Detect upstream source expiry from URL parameters.
  const { detectedExpiresAt, expirySource } = detectSourceExpiry(providerResult);

  // Determine verification status based on detected expiry.
  let verificationStatus = 'unknown';
  if (detectedExpiresAt) {
    verificationStatus = detectedExpiresAt <= now ? 'expired' : 'active';
  }

  // Infer stream type from the source URL (HLS manifest vs direct media).
  const firstSourceUrl = providerResult.sources?.[0]?.url || providerResult.streamUrl || '';
  const streamType = /\.m3u8(\?|$)/i.test(firstSourceUrl) ? 'hls' : 'direct';

  // Compute initial classification based on available evidence.
  // At save time, the only evidence is URL expiry detection.
  const classification = classifySource({
    detected_expires_at: detectedExpiresAt,
    expiry_source: expirySource,
    verification_status: verificationStatus,
    last_verified_at: null,
    observed_first_success_at: null,
    observed_last_success_at: null,
    observed_first_failure_at: null,
    failure_count: 0,
  }, now.getTime());

  const payload = {
    provider: providerResult.provider || provider,
    streamUrl: providerResult.streamUrl || (providerResult.sources?.[0]?.url || null),
    sources: providerResult.sources || [],
    subtitles: Array.isArray(providerResult.subtitles) ? providerResult.subtitles : [],
  };

  try {
    await db.query(
      `INSERT INTO episode_stream_cache
         (episode_id, provider, stream_type, stream_data, resolved_at, expires_at,
          detected_expires_at, expiry_source, verification_status, last_used_at,
          url_classification, classification_confidence, classification_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         stream_type = VALUES(stream_type),
         stream_data = VALUES(stream_data),
         resolved_at = VALUES(resolved_at),
         expires_at = VALUES(expires_at),
         detected_expires_at = VALUES(detected_expires_at),
         expiry_source = VALUES(expiry_source),
         verification_status = VALUES(verification_status),
         last_used_at = VALUES(last_used_at),
         url_classification = VALUES(url_classification),
         classification_confidence = VALUES(classification_confidence),
         classification_reason = VALUES(classification_reason)`,
      [episodeId, provider, streamType, JSON.stringify(payload), now, expires,
       detectedExpiresAt, expirySource, verificationStatus, now,
       classification.classification, classification.confidence, classification.reason]
    );
    logger.info('[STREAM_CACHE] SAVE', {
      episodeId, provider, ttlMin: ttl, streamType,
      detectedExpiresAt, expirySource, verificationStatus,
    });
    return true;
streamDiag.logCacheCreation(episodeId, provider, providerResult, ttl * 60 * 1000, expires);
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
streamDiag.logCacheInvalidation(episodeId, provider, 'probe_dead', null, null);
 * @returns {Promise<boolean>}
 */
async function deleteInvalidCache(episodeId, provider) {
  if (!episodeId) return false;
  try {
    await db.query('DELETE FROM episode_stream_cache WHERE episode_id = ? AND provider = ?', [episodeId, provider]);
    logger.info('[STREAM_CACHE] DELETE', { episodeId, provider });
    // Best-effort Redis invalidation: delete the corresponding Redis key.
    // A Redis failure must NOT cause MySQL deletion to fail, so this is
    // deliberately non-awaited and errors are only logged.
    const redisKey = buildRedisKey(episodeId, provider);
    cache.del(redisKey).catch(err => {
      logger.warn('[STREAM_CACHE] Redis delete failed (non-fatal)', { episodeId, provider, error: err && err.message });
    });
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
 * REDIS-FIRST FLOW:
 *   1. Check Redis — if VALID HIT, return immediately (no resolver, no MySQL).
 *   2. Check in-flight manager's memory cache (recently-resolved result).
 *   3. Check MySQL episode_stream_cache — if VALID HIT, populate Redis and return.
 *   4. Register with the InFlightResolverManager (starts OR attaches).
 *   5. Await the shared resolver promise — all waiters get the same result.
 *   6. Persist success to MySQL + Redis.
 *
 * @param {number|string} episodeId
 * @param {string} provider
 * @param {() => Promise<object|null>} resolver - returns provider result
 * @returns {Promise<object|null>} provider result (cached or fresh)
 */
async function getOrResolve(episodeId, provider, resolver) {
  if (!episodeId) return resolver();
  const key = inFlightResolverManager.keyFor(provider, episodeId);
  const redisKey = buildRedisKey(episodeId, provider);

  // TIER 1: Redis cache — fastest path, no resolver, no MySQL.
  try {
    const redisHit = await cache.get(redisKey);
    if (redisHit && redisHit.sources && redisHit.sources.length > 0) {
      // Validate expiry: check both Redis TTL (handled by Redis itself) and
      // any upstream expiry stored in the payload.
      const upstreamExpired = redisHit.detectedExpiresAt
        ? new Date(redisHit.detectedExpiresAt).getTime() <= Date.now()
        : false;
      if (!upstreamExpired) {
        logger.info('[STREAM_CACHE] REDIS_HIT', { episodeId, provider });
        streamCacheMetrics.increment('redisHits');
        return redisHit;
      }
      logger.info('[STREAM_CACHE] REDIS_EXPIRED', { episodeId, provider });
    }
  } catch (err) {
    logger.debug('[STREAM_CACHE] Redis check failed (non-fatal)', { error: err.message });
  }

  // TIER 2: In-memory cache (a recently-successful result, before it
  //    reaches the DB cache on the next request).
  const memCached = inFlightResolverManager.getCached(key);
  if (memCached && memCached.sources && memCached.sources.length > 0) {
    logger.info('[STREAM_CACHE] MEMORY_HIT', { episodeId, provider });
    streamCacheMetrics.increment('mysqlHits');
    return memCached;
  }

  // TIER 3: MySQL cache check — if a concurrent request persisted a result.
  const dbHit = await findCachedStream(episodeId, provider);
  if (dbHit.result) {
    // Populate Redis from MySQL hit for next time.
    try {
      await cache.set(redisKey, dbHit.result, REDIS_TTL_SECONDS);
    } catch (err) {
      logger.debug('[STREAM_CACHE] Redis populate failed (non-fatal)', { error: err.message });
    }
    logger.info('[STREAM_CACHE] MYSQL_HIT', { episodeId, provider });
    streamCacheMetrics.increment('mysqlHits');
    return dbHit.result;
  }

  // TIER 4: Register with the single-flight manager. If a resolver is already
  //    in-flight for this key, this ATTACHES to it (no duplicate execution).
  //    If a settled entry is still present (within grace), it returns the
  //    cached result. Otherwise it starts ONE resolver.
  streamCacheMetrics.increment('cacheMisses');
  const { promise } = inFlightResolverManager.register(key, async () => {
    // Run the resolver ONCE. Normalize the output to a provider result.
    streamCacheMetrics.increment('resolverCalls');
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
      // Record source lifetime: time from resolved_at to now.
      try {
        const [rows] = await db.query(
          'SELECT TIMESTAMPDIFF(SECOND, resolved_at, NOW()) AS lifetime_sec FROM episode_stream_cache WHERE episode_id = ? AND provider = ? LIMIT 1',
          [episodeId, provider]
        );
        if (rows[0]?.lifetime_sec) {
          streamCacheMetrics.recordSourceLifetime(rows[0].lifetime_sec * 1000);
        }
      } catch (_) { /* non-fatal */ }
    }
    return providerResult;
  });

  // Await the SHARED resolver promise. There is NO per-caller timeout that
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
  // Verification functions (exposed for testing + external use).
  verifySource,
  verifySourceWithRange,
  verifyAndRecord,
  // Source state machine (exposed for testing + external use).
  getSourceState,
  isReusable,
  // Source classification (exposed for testing + external use).
  classifySource,
  // Expiry detection functions (exposed for testing).
  detectExpiryFromUrl,
  detectExpiryFromHeaders,
  detectSourceExpiry,
  parseTimestamp,
  // Redis key builder (exposed for testing).
  buildRedisKey,
  // Expose the single-flight manager for observability + tests.
  inFlightResolverManager,
};

// ============================================================
//  services/streamingService.js — AnimeHeaven-Only Playback Engine
//
//  SINGLE-RESOLVER STREAMING PIPELINE (AnimeHeaven only):
//    • The streaming engine uses EXACTLY ONE provider: AnimeHeaven.
//    • All multi-provider logic has been removed:
//        - No provider race
//        - No provider rotation
//        - No provider retries
//        - No provider queues
//        - No Consumet execution
//        - No hosted Consumet execution
//    • A Play request can no longer execute any Consumet resolver.
//
//  EXECUTION MODEL:
//    Sequential, single-path resolution:
//      1. AnimeHeaven is the ONLY provider in the execution path.
//      2. Health is checked (skip if degraded) then the provider is
//         invoked once. There is NO provider-level retry loop — the
//         AnimeHeaven provider (services/animeHeavenProvider.js) has
//         its own internal resilient scraping/nested/mirror fallbacks.
//      3. The result (sources/subtitles) is normalized and quality
//         filtered per user tier.
//      4. A single pipeline failure produces a clean error message.
//      5. Structured metrics are logged per attempt for diagnosis.
//
//  Quality Tiers:
//    Free users:  ≤ 720p (480p, 720p)
//    Premium/Admin users: up to 4K (1080p, 4K)
//
//  Proxy: Uses the SHARED proxy manager from utils/providerHttp.js
//  and the same-origin reverse proxy URLs emitted by the AnimeHeaven
//  provider (services/animeHeavenProvider.js).
//
//  COMPATIBILITY:
//    The public API surface (resolveStream, resolveAllProviders,
//    filterSourcesByTier, getBestQualityLabel, getProviderHealthStatus,
//    QUALITY_TIERS) and the response payload shape are PRESERVED so no
//    controller/route/frontend changes are required.
//
//  NOTE: Consumet/hosted-Consumet/Miruro execution paths are REMOVED
//  from this streaming engine. Legacy Consumet code may still exist
//  elsewhere in the project (catalogue, admin import, etc.) but it is
//  NEVER invoked by the streaming engine anymore.
// ============================================================
const { provider: animeHeavenProvider } = require('./animeHeavenProvider');
const {
  isProviderHealthy,
  getProviderHealth,
  getHealthStats,
  classifyError,
  recordSuccess,
  recordFailure,
  markTimeout,
  isTimeoutError,
} = require('../utils/providerHttp');
const {
  PROVIDER_IDS,
  toHealthKey,
} = require('./providerRegistry');
const cache = require('../utils/cacheService');
const logger = require('../utils/logger');
const streamCacheService = require('./streamCacheService');
const streamCacheConfig = require('../config/streamCache');

// The provider tag used for the persistent stream cache.
const STREAM_CACHE_ENABLED = streamCacheConfig.enabled;
const STREAM_CACHE_PROVIDER = streamCacheConfig.provider;

// ── Quality Tier Definitions ────────────────────────────────
const QUALITY_TIERS = {
  free: {
    max: 720,
    allowed: ['360', '480', '720', 'default', 'auto'],
    label: 'HD (720p Max)',
  },
  premium: {
    max: 4320,
    allowed: ['360', '480', '720', '1080', '2160', '4320', '4k', 'default', 'auto'],
    label: 'Ultra HD (up to 4K)',
  },
};

// ── Pipeline Tuning ─────────────────────────────────────────
// Global ceiling for the entire single-provider resolution. Prevents the
// request from dangling when the provider is slow. The individual HTTP layer
// already caps each call at its configured timeout.
const PIPELINE_TIMEOUT_MS = parseInt(process.env.STREAM_PIPELINE_TIMEOUT_MS || '15000', 10);

// The single streaming provider for the playback engine.
const ANIME_HEAVEN_TAG = PROVIDER_IDS.ANIME_HEAVEN; // 'animeheaven'

/**
 * Parse quality number from string like "1080p", "1080", "4K", "2160p"
 */
function parseQualityNumber(qualityStr) {
  if (!qualityStr || typeof qualityStr !== 'string') return 0;
  const cleaned = qualityStr.toLowerCase().replace(/[^0-9k]/g, '');
  if (cleaned === '4k' || cleaned === '2160') return 2160;
  return parseInt(cleaned, 10) || 0;
}

/**
 * Filter a list of stream sources based on user tier.
 */
function filterSourcesByTier(sources, isPremium) {
  if (!Array.isArray(sources)) return [];
  const tier = isPremium ? QUALITY_TIERS.premium : QUALITY_TIERS.free;
  return sources.filter(src => {
    const qNum = parseQualityNumber(src.quality);
    if (qNum > 0) return qNum <= tier.max;
    const qStr = (src.quality || '').toLowerCase();
    return tier.allowed.includes(qStr);
  });
}

/**
 * Get the best available quality label for display.
 */
function getBestQualityLabel(sources, isPremium) {
  const filtered = filterSourcesByTier(sources, isPremium);
  if (!filtered.length) return 'N/A';
  const sorted = [...filtered].sort((a, b) => {
    return parseQualityNumber(b.quality) - parseQualityNumber(a.quality);
  });
  return sorted[0].quality || 'Auto';
}

/**
 * Normalize a provider result into the canonical payload shape.
 *
 * The AnimeHeaven provider returns `{ provider, streamUrl, sources, subtitles,
 * subtitleMode, externalTracks }`. This helper maps it into the canonical
 * `{ provider, streamUrl, sources, subtitles }` shape the pipeline expects so
 * the success check `sources.length > 0` works uniformly.
 *
 * @param {object} result - Raw provider result
 * @returns {object|null} Normalized result, or null if not usable
 */
function normalizeProviderResult(result) {
  if (!result) return null;

  let sources = result.sources;
  if (!Array.isArray(sources)) sources = result.allSources;
  if (!Array.isArray(sources)) sources = [];

  // Normalize each source entry to { url, quality } while PRESERVING the
  // playback/unlock context (referer, origin, cookies, sourceType) that the
  // AnimeHeaven provider attaches. These fields are REQUIRED by the
  // server-side reverse proxy to authorize hotlink-protected CDN requests.
  // They are kept server-side only — the controller strips them before
  // returning data to the browser (see getPublicStreamPayload in
  // controllers/streamController.js).
  const normalizedSources = sources
    .filter(s => s && (s.url || s.file))
    .map(s => ({
      url: s.url || s.file,
      quality: s.quality || s.qualityLabel || 'auto',
      sourceType: s.sourceType || null,
      // Playback context (server-side only — never exposed to the client).
      referer: s.referer || null,
      origin: s.origin || null,
      cookies: s.cookies || null,
      headers: s.headers || null,
    }));

  if (normalizedSources.length === 0) return null;

  return {
    provider: result.provider || result.source || ANIME_HEAVEN_TAG,
    streamUrl: result.streamUrl || (normalizedSources[0] ? normalizedSources[0].url : null),
    sources: normalizedSources,
    subtitles: Array.isArray(result.subtitles) ? result.subtitles : [],
  };
}

// ── Cache Helpers ──────────────────────────────────────────
const STREAM_CACHE_TTL = parseInt(process.env.STREAM_CACHE_TTL_SECONDS || '300', 10);

function buildCacheKey(animeTitle, episodeNumber, providerName) {
  return `stream:${animeTitle.toLowerCase().replace(/\s+/g, '-')}:ep${episodeNumber}:${providerName || 'all'}`;
}

// ─────────────────────────────────────────────────────────────
//  SINGLE PROVIDER EXECUTION (AnimeHeaven)
// ─────────────────────────────────────────────────────────────

/**
 * Execute the AnimeHeaven provider for an anime episode.
 *
 * This is the ONLY execution path in the streaming engine. It performs a
 * single health check then a single provider invocation. There is NO retry
 * loop, NO concurrency race, NO queue, NO rotation — the AnimeHeaven
 * provider itself handles resilient scraping/mirror/nested fallbacks
 * internally.
 *
 * NEVER throws — always resolves to a result object:
 *   { resolved: boolean, result: object|null, error: string|null,
 *     category: string|null, durationMs: number }
 *
 * @param {string} animeTitle
 * @param {number|string} episodeNumber
 * @returns {Promise<object>} Encapsulated outcome
 */
async function executeAnimeHeaven(animeTitle, episodeNumber) {
  const healthKey = toHealthKey(ANIME_HEAVEN_TAG) || ANIME_HEAVEN_TAG;
  const start = Date.now();

  // Health check before attempting (skip degraded provider quickly).
  if (!isProviderHealthy(healthKey)) {
    logger.streamAttempt({
      provider: ANIME_HEAVEN_TAG,
      anime: animeTitle,
      episode: episodeNumber,
      attempt: 1,
      result: 'skipped',
      failureReason: 'provider marked degraded (skipped)',
      httpStatus: 0,
      timedOut: false,
      cloudflareDetected: false,
      startTime: new Date(start).toISOString(),
      endTime: new Date().toISOString(),
      latencyMs: Date.now() - start,
    });
    return {
      resolved: false,
      result: null,
      error: 'provider marked degraded (skipped)',
      category: 'PROVIDER_DEGRADED',
      durationMs: Date.now() - start,
    };
  }

  const attemptStart = Date.now();
  logger.debugStream('Stream attempt pending', { provider: ANIME_HEAVEN_TAG, anime: animeTitle, episode: episodeNumber });

  try {
    const raw = await animeHeavenProvider.resolveStream({
      title: animeTitle,
      episode: episodeNumber,
    });
    const result = normalizeProviderResult(raw);

    if (result && result.sources.length > 0) {
      recordSuccess(healthKey, Date.now() - attemptStart);
      logger.streamAttempt({
        provider: ANIME_HEAVEN_TAG,
        anime: animeTitle,
        episode: episodeNumber,
        attempt: 1,
        result: 'success',
        httpStatus: 0,
        timedOut: false,
        cloudflareDetected: false,
        searchSuccess: true,
        streamSuccess: true,
        sources: result.sources.length,
        startTime: new Date(attemptStart).toISOString(),
        endTime: new Date().toISOString(),
        latencyMs: Date.now() - attemptStart,
      });
      return {
        resolved: true,
        result,
        error: null,
        category: null,
        durationMs: Date.now() - start,
      };
    }

    // No sources (empty search / missing episode / invalid stream) — not an error.
    const category = 'EMPTY';
    logger.streamAttempt({
      provider: ANIME_HEAVEN_TAG,
      anime: animeTitle,
      episode: episodeNumber,
      attempt: 1,
      result: 'no_sources',
      failureReason: 'no playable stream found',
      httpStatus: 0,
      timedOut: false,
      cloudflareDetected: false,
      searchSuccess: null,
      streamSuccess: false,
      startTime: new Date(attemptStart).toISOString(),
      endTime: new Date().toISOString(),
      latencyMs: Date.now() - attemptStart,
    });
    recordFailure(healthKey, Date.now() - attemptStart);
    return {
      resolved: false,
      result: null,
      error: 'no playable stream found',
      category,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const { category, description } = classifyError(err);
    const timedOut = isTimeoutError(err);
    const cloudflareDetected = category === 'FORBIDDEN' || category === 'SERVER_ERROR';
    logger.streamAttempt({
      provider: ANIME_HEAVEN_TAG,
      anime: animeTitle,
      episode: episodeNumber,
      attempt: 1,
      result: timedOut ? 'timeout' : 'failure',
      failureReason: description || err.message,
      httpStatus: err.response?.status || 0,
      timedOut,
      cloudflareDetected,
      searchSuccess: null,
      streamSuccess: false,
      error: description || err.message,
      startTime: new Date(attemptStart).toISOString(),
      endTime: new Date().toISOString(),
      latencyMs: Date.now() - attemptStart,
    });

    if (isTimeoutError(err)) {
      markTimeout(healthKey, Date.now() - attemptStart);
    } else {
      recordFailure(healthKey, Date.now() - attemptStart);
    }

    return {
      resolved: false,
      result: null,
      error: description || err.message,
      category: category || 'UNKNOWN',
      durationMs: Date.now() - start,
    };
  }
}

// ─────────────────────────────────────────────────────────────
//  FRESH-RESOLUTION CONTINUATION (after cache invalidation)
// ─────────────────────────────────────────────────────────────
// Runs the SAME single-provider execution + payload-building path that
// resolveStream uses after a normal cache miss. Used when the cache-source
// liveness probe marks a cached source dead (403/404): the stale row is
// invalidated and AnimeHeaven is resolved fresh (gate.php → new token) so the
// user always gets a playable stream. NEVER throws.
/**
 * @param {string} animeTitle
 * @param {number|string} episodeNumber
 * @param {number|string} episodeId
 * @param {boolean} isPremium
 * @param {string} tier
 * @param {number} overallStart
 * @param {boolean} usePersistentCache
 * @returns {Promise<object>} final stream payload
 */
async function continueWithFreshResolution(animeTitle, episodeNumber, episodeId, isPremium, tier, overallStart, usePersistentCache) {
  const resolveFresh = async () => executeAnimeHeaven(animeTitle, episodeNumber);

  let outcome;
  if (usePersistentCache) {
    const fresh = await streamCacheService.getOrResolve(episodeId, STREAM_CACHE_PROVIDER, resolveFresh);
    outcome = fresh && fresh.sources && fresh.sources.length > 0
      ? { resolved: true, result: fresh, error: null, category: null, durationMs: 0 }
      : { resolved: false, result: null, error: 'no playable stream found', category: 'EMPTY', durationMs: 0 };
  } else {
    outcome = await Promise.race([
      resolveFresh(),
      new Promise(resolve => setTimeout(() => resolve({
        resolved: false,
        result: null,
        error: 'stream pipeline timed out',
        category: 'TIMEOUT',
        durationMs: PIPELINE_TIMEOUT_MS,
      }), PIPELINE_TIMEOUT_MS)),
    ]);
  }

  const winner = outcome.result;
  const winnerProvider = outcome.resolved ? ANIME_HEAVEN_TAG : null;
  const elapsed = Date.now() - overallStart;

  if (winner && winner.sources.length > 0) {
    const filteredSources = filterSourcesByTier(winner.sources, isPremium);
    if (filteredSources.length === 0) {
      throw new Error(`No stream provider returned a source matching tier "${tier}" for "${animeTitle}" Episode ${episodeNumber}.`);
    }

    const best = filteredSources.reduce((a, b) =>
      parseQualityNumber(b.quality) > parseQualityNumber(a.quality) ? b : a
    , filteredSources[0]);

    const payload = {
      provider: winner.provider || winnerProvider || ANIME_HEAVEN_TAG,
      streamUrl: best.url,
      sources: filteredSources,
      subtitles: winner.subtitles || [],
      bestQuality: best.quality || 'auto',
      tier,
    };

    try {
      const cacheKey = buildCacheKey(animeTitle, episodeNumber);
      await cache.set(cacheKey, payload, STREAM_CACHE_TTL);
    } catch (cacheErr) {
      logger.warn('Cache write failed (fresh resolution)', { anime: animeTitle, episode: episodeNumber, error: cacheErr.message });
    }

    logger.streamAttempt({
      provider: payload.provider,
      anime: animeTitle,
      episode: episodeNumber,
      result: 'success',
      httpStatus: 0,
      timedOut: false,
      cloudflareDetected: false,
      searchSuccess: true,
      streamSuccess: true,
      sources: filteredSources.length,
      bestQuality: payload.bestQuality,
      startTime: new Date(overallStart).toISOString(),
      endTime: new Date().toISOString(),
      latencyMs: elapsed,
    });
    return payload;
  }

  throw new Error(`No stream provider could resolve "${animeTitle}" Episode ${episodeNumber}. Attempted provider: ${ANIME_HEAVEN_TAG} (${elapsed}ms)`);
}

// ─────────────────────────────────────────────────────────────
//  MAIN RESOLVER
// ─────────────────────────────────────────────────────────────

/**
 * Resolve the best available stream for an anime episode via AnimeHeaven.
 *
 * Single-provider, sequential resolution. NEVER crashes on failure.
 *
 * @param {string} animeTitle — Title of the anime
 * @param {number|string} episodeNumber — Episode number
 * @param {object} options
 * @param {boolean} options.isPremium — Whether user can access 1080p/4K
 * @param {string} [options.preferredProvider] — Accepted for backward
 *   compatibility but IGNORED (AnimeHeaven is the only provider).
* @param {boolean} [options.skipCache] — Bypass cache for this request
 * @param {number|string} [options.episodeId] — Optional DB episode id used as
 *   the persistent-stream-cache key. When present, the persistent MySQL cache
 *   is checked BEFORE AnimeHeaven and a successful resolution is persisted.
 * @returns {Promise<{provider: string, streamUrl: string|null, sources: Array, subtitles: Array, bestQuality: string, tier: string}>}
 */
async function resolveStream(animeTitle, episodeNumber, options = {}) {
  const { isPremium = false, skipCache = false, episodeId } = options;
  const tier = isPremium ? 'premium' : 'free';
  const overallStart = Date.now();

  // ── Movie Guard ─────────────────────────────────────────
  const moviePattern = /\b(movie|film|ova|special|the movie)\b/i;
  const titleWords = (animeTitle || '').split(' ');
  const lastWord = titleWords[titleWords.length - 1];
  const hasMovieSuffix = /^\d+$/.test(lastWord) && titleWords.length > 1;
  const isMovieByTitle = moviePattern.test(animeTitle) || hasMovieSuffix;

  if (isMovieByTitle && Number(episodeNumber) > 1) {
    logger.debugStream('Movie guard triggered', { anime: animeTitle, episode: episodeNumber, forcedEpisode: 1 });
    episodeNumber = 1;
  }

  logger.debugStream('resolveStream start', { anime: animeTitle, episode: episodeNumber, tier });

// ── Cache Check ─────────────────────────────────────────
  if (!skipCache) {
    const cacheKey = buildCacheKey(animeTitle, episodeNumber);
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        logger.debugStream('Cache hit', { anime: animeTitle, episode: episodeNumber });

        // ── TIER-SAFE CACHE HIT ─────────────────────────────
        // The in-memory cache key does not include the requester's tier, so a
        // cached payload may have been populated by a premium/admin user and
        // thus contain premium-only (1080p/4K) sources. A free user must NEVER
        // receive those. We therefore re-filter the cached sources for the
        // CURRENT requester's tier on every hit, rebuild the response, and
        // DO NOT mutate the shared cached object (so premium/admin users are
        // never downgraded by a free user's request).
        const cachedSources = Array.isArray(cached.sources) ? cached.sources : [];
        const tierSources = filterSourcesByTier(cachedSources, isPremium);
        if (tierSources.length > 0) {
          const best = tierSources.reduce((a, b) =>
            parseQualityNumber(b.quality) > parseQualityNumber(a.quality) ? b : a
          , tierSources[0]);
          logger.streamAttempt({
            provider: cached.provider || ANIME_HEAVEN_TAG,
            anime: animeTitle,
            episode: episodeNumber,
            result: 'success',
            httpStatus: 0,
            timedOut: false,
            cloudflareDetected: false,
            searchSuccess: true,
            streamSuccess: true,
            sources: tierSources.length,
            bestQuality: best.quality || 'auto',
            startTime: new Date(overallStart).toISOString(),
            endTime: new Date().toISOString(),
            latencyMs: Date.now() - overallStart,
          });
          return {
            provider: cached.provider || ANIME_HEAVEN_TAG,
            streamUrl: best.url,
            sources: tierSources,
            subtitles: Array.isArray(cached.subtitles) ? cached.subtitles : [],
            bestQuality: best.quality || 'auto',
            tier,
            cached: true,
          };
        }
        // No sources match the current tier (e.g. a free user hit a
        // premium-only cached payload). Treat this as a cache miss and fall
        // through to normal resolution, which re-resolves and applies the
        // user's tier. This never recreates a premium-only payload for a free
        // user because the resolution path also filters by `isPremium`.
        logger.debugStream('Cache hit excluded by tier — falling through to resolution', {
          anime: animeTitle,
          episode: episodeNumber,
          tier,
          cachedSources: cachedSources.length,
        });
      } else {
        logger.debugStream('Cache miss', { anime: animeTitle, episode: episodeNumber });
      }
    } catch (cacheErr) {
      logger.warn('Cache read failed — proceeding without cache', { anime: animeTitle, episode: episodeNumber, error: cacheErr.message });
    }
  } else {
    logger.debugStream('Cache bypassed (skipCache=true)', { anime: animeTitle, episode: episodeNumber });
  }

logger.debugStream('Stream provider selected', {
    anime: animeTitle,
    episode: episodeNumber,
    provider: ANIME_HEAVEN_TAG,
    deadlineMs: PIPELINE_TIMEOUT_MS,
  });

  // ── Persistent DB cache (episode-scoped, AnimeHeaven only) ──
  // When an episodeId is supplied AND the persistent cache is enabled, check
  // the MySQL cache BEFORE contacting AnimeHeaven. On a hit we reuse the
  // stored PRE-PROXY source (reconstructed here) and the controller feeds it
  // through the existing proxy pipeline — AnimeHeaven is NOT contacted.
  //
  // On a miss, the single-flight getOrResolve() guarantees only ONE AnimeHeaven
  // resolution for concurrent first plays, performs a second DB cache check
  // after acquiring the lock, and persists a successful resolution.
  const usePersistentCache = STREAM_CACHE_ENABLED && !skipCache && episodeId != null && episodeId !== '';

if (usePersistentCache) {
    const cachedLookup = await streamCacheService.findCachedStream(episodeId, STREAM_CACHE_PROVIDER);
    if (cachedLookup.result) {
      logger.debugStream('Persistent stream cache hit', { anime: animeTitle, episode: episodeNumber, episodeId });
      // Reconstruct the winner + payload from the cached provider result.
      const cachedWinner = cachedLookup.result;
      const filteredSources = filterSourcesByTier(cachedWinner.sources, isPremium);
      if (filteredSources.length > 0) {
        const best = filteredSources.reduce((a, b) =>
          parseQualityNumber(b.quality) > parseQualityNumber(a.quality) ? b : a
        , filteredSources[0]);

        // ── CACHE-SOURCE LIVENESS PROBE ─────────────────────
        // The cached source embeds an expiring AnimeHeaven CDN token. If that
        // token has been revoked/expired, serving the cached URL yields a 403/404
        // playback failure. Before serving, FAIL-OPEN probe the BEST cached
        // source (HEAD). Only an explicit 403/404 invalidates the cache and
        // falls through to a fresh AnimeHeaven resolution (gate.php → new token).
        // Any network error / timeout / 5xx keeps the cache (fail-open) so the
        // probe can never break playback or add meaningful latency.
        const bestSource = best || {};
        const alive = await streamCacheService.isCachedSourceAlive(
          bestSource.url,
          {
            referer: bestSource.referer || null,
            origin: bestSource.origin || null,
          }
        );
        if (!alive) {
          logger.debugStream('Persistent stream cache source dead — invalidating & re-resolving', {
            anime: animeTitle,
            episode: episodeNumber,
            episodeId,
          });
          await streamCacheService.deleteInvalidCache(episodeId, STREAM_CACHE_PROVIDER);
          // Fall through to fresh AnimeHeaven resolution below.
          return continueWithFreshResolution(animeTitle, episodeNumber, episodeId, isPremium, tier, overallStart, usePersistentCache);
        }

        const payload = {
          provider: cachedWinner.provider || STREAM_CACHE_PROVIDER,
          streamUrl: best.url,
          sources: filteredSources,
          subtitles: Array.isArray(cachedWinner.subtitles) ? cachedWinner.subtitles : [],
          bestQuality: best.quality || 'auto',
          tier,
          cached: true,
        };
        logger.streamAttempt({
          provider: payload.provider,
          anime: animeTitle,
          episode: episodeNumber,
          result: 'success',
          httpStatus: 0,
          timedOut: false,
          cloudflareDetected: false,
          searchSuccess: true,
          streamSuccess: true,
          sources: filteredSources.length,
          bestQuality: payload.bestQuality,
          startTime: new Date(overallStart).toISOString(),
          endTime: new Date().toISOString(),
          latencyMs: Date.now() - overallStart,
        });
        return payload;
      }
    }
  }

  // ── Single provider execution ───────────────────────────
  // Wrap the AnimeHeaven resolution in the single-flight cache guard when a
  // persistent cache is active: this deduplicates concurrent first plays and
  // persists the successful (PRE-PROXY) result for later reuse.
  const resolveFresh = async () => executeAnimeHeaven(animeTitle, episodeNumber);

  let outcome;
  if (usePersistentCache) {
    const fresh = await streamCacheService.getOrResolve(episodeId, STREAM_CACHE_PROVIDER, resolveFresh);
    outcome = fresh && fresh.sources && fresh.sources.length > 0
      ? { resolved: true, result: fresh, error: null, category: null, durationMs: 0 }
      : { resolved: false, result: null, error: 'no playable stream found', category: 'EMPTY', durationMs: 0 };
  } else {
    outcome = await Promise.race([
      resolveFresh(),
      new Promise(resolve => setTimeout(() => resolve({
        resolved: false,
        result: null,
        error: 'stream pipeline timed out',
        category: 'TIMEOUT',
        durationMs: PIPELINE_TIMEOUT_MS,
      }), PIPELINE_TIMEOUT_MS)),
    ]);
  }

  const winner = outcome.result;
  const winnerProvider = outcome.resolved ? ANIME_HEAVEN_TAG : null;

  // ── Structured metrics log ──────────────────────────────
  const elapsed = Date.now() - overallStart;
  if (winner && winner.sources.length > 0) {
    logger.stream({
      provider: winnerProvider,
      result: 'winner',
      duration: elapsed,
      sources: winner.sources.length,
      win: true,
      winner: winnerProvider,
      totalDurationMs: elapsed,
    });
  } else {
    logger.stream({
      result: 'all_failed',
      duration: elapsed,
      totalDurationMs: elapsed,
      provider: ANIME_HEAVEN_TAG,
      category: outcome.category,
      error: outcome.error,
    });
  }

  // ── Build the final payload ─────────────────────────────
  if (winner && winner.sources.length > 0) {
    // Filter by tier.
    const filteredSources = filterSourcesByTier(winner.sources, isPremium);
    if (filteredSources.length === 0) {
      const msg = `No stream provider returned a source matching tier "${tier}" for "${animeTitle}" Episode ${episodeNumber}.`;
      logger.streamAttempt({
        provider: winnerProvider,
        anime: animeTitle,
        episode: episodeNumber,
        result: 'failure',
        failureReason: 'no source matching tier',
        httpStatus: 0,
        timedOut: false,
        cloudflareDetected: false,
        startTime: new Date(overallStart).toISOString(),
        endTime: new Date().toISOString(),
        latencyMs: elapsed,
      });
      throw new Error(msg);
    }

    // Pick best quality for tier.
    const best = filteredSources.reduce((a, b) =>
      parseQualityNumber(b.quality) > parseQualityNumber(a.quality) ? b : a
    , filteredSources[0]);

    const payload = {
      provider: winner.provider || winnerProvider || ANIME_HEAVEN_TAG,
      streamUrl: best.url,
      sources: filteredSources,
      subtitles: winner.subtitles || [],
      bestQuality: best.quality || 'auto',
      tier,
    };

    // ── Cache the result ────────────────────────────────
    try {
      const cacheKey = buildCacheKey(animeTitle, episodeNumber);
      await cache.set(cacheKey, payload, STREAM_CACHE_TTL);
      logger.debugStream('Stream cached', { anime: animeTitle, episode: episodeNumber, ttlSec: STREAM_CACHE_TTL });
    } catch (cacheErr) {
      logger.warn('Cache write failed', { anime: animeTitle, episode: episodeNumber, error: cacheErr.message });
    }

    logger.streamAttempt({
      provider: payload.provider,
      anime: animeTitle,
      episode: episodeNumber,
      result: 'success',
      httpStatus: 0,
      timedOut: false,
      cloudflareDetected: false,
      searchSuccess: true,
      streamSuccess: true,
      sources: filteredSources.length,
      bestQuality: payload.bestQuality,
      startTime: new Date(overallStart).toISOString(),
      endTime: new Date().toISOString(),
      latencyMs: elapsed,
    });
    return payload;
  }

  // ── Provider failed ─────────────────────────────────────
  const errorMsg = `No stream provider could resolve "${animeTitle}" Episode ${episodeNumber}. Attempted provider: ${ANIME_HEAVEN_TAG} (${elapsed}ms)`;
  logger.streamAttempt({
    provider: ANIME_HEAVEN_TAG,
    anime: animeTitle,
    episode: episodeNumber,
    result: 'failure',
    failureReason: outcome.error || 'all providers failed',
    httpStatus: 0,
    timedOut: false,
    cloudflareDetected: false,
    startTime: new Date(overallStart).toISOString(),
    endTime: new Date().toISOString(),
    latencyMs: elapsed,
  });
  throw new Error(errorMsg);
}

/**
 * Resolve streams for the "Switch Server" dropdown.
 *
 * With a single AnimeHeaven provider this returns at most one entry (the
 * AnimeHeaven stream). The response shape is preserved so the frontend
 * contract is unchanged.
 *
 * @param {string} animeTitle
 * @param {number|string} episodeNumber
 * @param {object} options
 * @param {boolean} options.isPremium
 * @returns {Promise<Array<{provider: string, streamUrl: string|null, sources: Array, bestQuality: string}>>}
 */
async function resolveAllProviders(animeTitle, episodeNumber, options = {}) {
  const { isPremium = false } = options;
  const results = [];

  logger.debugStream('resolveAllProviders start', { anime: animeTitle, episode: episodeNumber, provider: ANIME_HEAVEN_TAG });

  const outcome = await executeAnimeHeaven(animeTitle, episodeNumber);

  if (outcome.resolved && outcome.result && outcome.result.sources.length > 0) {
    const filteredSources = filterSourcesByTier(outcome.result.sources, isPremium);
    const best = filteredSources.reduce((a, b) =>
      parseQualityNumber(b.quality) > parseQualityNumber(a.quality) ? b : a
    , filteredSources[0]);

    results.push({
      provider: outcome.result.provider || ANIME_HEAVEN_TAG,
      streamUrl: best?.url || null,
      sources: filteredSources,
      bestQuality: best?.quality || 'auto',
    });
  }

  logger.debugStream('resolveAllProviders complete', {
    anime: animeTitle,
    episode: episodeNumber,
    resolved: results.length,
    attempted: 1,
    providers: results.map(r => r.provider),
  });
  return results;
}

// ── Provider Health Endpoint ───────────────────────────────
/**
 * Get the provider health map. The response shape is preserved so the
 * admin dashboard health endpoint continues to work unchanged.
 *
 * @returns {object} Health keyed by provider name
 */
function getProviderHealthStatus() {
  const health = getProviderHealth();
  return health;
}

module.exports = {
  resolveStream,
  resolveAllProviders,
  filterSourcesByTier,
  getBestQualityLabel,
  getProviderHealthStatus,
  QUALITY_TIERS,
};

// ============================================================
//  services/streamingService.js — AnimeHeaven-First Playback Engine
//
//  PRIMARY PROVIDER: AnimeHeaven (metadata + stream).
//  FALLBACK PROVIDERS: KickAssAnime, Hianime, AnimePahe (Consumet-backed),
//  used ONLY after AnimeHeaven fails 3 times.
//
//  FAST PLAYBACK RESOLUTION (Phase 3):
//    Old: search → details → gate → stream
//    New: DB lookup → animeheaven_slug → episode_key → gate → stream
//    The search step NEVER runs during playback. It only runs once during
//    import (services/animeHeavenImportService.js).
//
//  FALLBACK SYSTEM (Phase 4):
//    AnimeHeaven is attempted 3 times. Only after all 3 fail do the
//    fallback providers activate (in priority order). Provider health
//    continues to work; AnimeHeaven failures are recorded; fallback usage
//    is logged. The response includes:
//      providerUsed, fallbackActivated, attemptCount
//
//  COMPATIBILITY:
//    The public API surface (resolveStream, resolveAllProviders,
//    filterSourcesByTier, getBestQualityLabel, getProviderHealthStatus,
//    QUALITY_TIERS) and the response payload shape are PRESERVED so no
//    controller/route/frontend changes are required.
// ============================================================
const { provider: animeHeavenProvider } = require('./animeHeavenProvider');
const { ConsumetProvider } = require('./consumetProvider');
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
const db = require('../config/db');
const cache = require('../utils/cacheService');
const logger = require('../utils/logger');
const streamCacheService = require('./streamCacheService');
const streamCacheConfig = require('../config/streamCache');
const animeHeavenImportService = require('./animeHeavenImportService');
const streamCacheMetrics = require('./streamCacheMetrics');
const streamDiag = require('../utils/streamDiagnostics');
const streamObservationService = require('./streamObservationService');

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

// ── Fallback Configuration (Phase 4) ────────────────────────
// AnimeHeaven is attempted this many times before fallbacks activate.
const ANIMEHEAVEN_MAX_ATTEMPTS = 3;

// Fallback provider priority (Consumet-backed). Only used after AnimeHeaven
// fails ANIMEHEAVEN_MAX_ATTEMPTS times.
const FALLBACK_PROVIDER_ORDER = [
  PROVIDER_IDS.KICK_ASS_ANIME,
  PROVIDER_IDS.HIANIME,
  PROVIDER_IDS.ANIME_PAHE,
];

// The single streaming provider for the playback engine.
const ANIME_HEAVEN_TAG = PROVIDER_IDS.ANIME_HEAVEN; // 'animeheaven'

// ── Helpers ─────────────────────────────────────────────────

/**
 * Parse quality number from string like "1080p", "1080", "4K", "2160p".
 *
 * IMPORTANT: Strings that are NOT quality labels (e.g. AnimeHeaven's
 * "Download Episode 1", "Unknown", "auto", "default") must NEVER be ranked as a
 * numeric quality. The old implementation stripped non-digits then
 * parseInt()'d, so "Download Episode 1" → "1" → ranked above real "auto"
 * (720p) sources and caused the Download link to be selected as the playback
 * streamUrl/bestQuality. Non-quality labels now resolve to 0.
 */
function parseQualityNumber(qualityStr) {
  if (!qualityStr || typeof qualityStr !== 'string') return 0;
  const lower = qualityStr.toLowerCase();
  // Explicitly exclude non-quality labels.
  if (/download|unknown|auto|default|n\/a|upcoming/i.test(lower)) return 0;
  const cleaned = lower.replace(/[^0-9k]/g, '');
  if (cleaned === '4k' || cleaned === '2160') return 2160;
  return parseInt(cleaned, 10) || 0;
}

/**
 * True when a source is a DOWNLOAD-ONLY link (never used for in-browser
 * playback). Mirrors the provider's classification (sourceType link/download
 * or a quality starting with "Download"). Used everywhere "best" is picked so
 * the Download link is never selected as streamUrl/bestQuality.
 */
function isDownloadSource(src) {
  if (!src) return false;
  const type = String(src.sourceType || '').toLowerCase();
  const quality = String(src.quality || '').toLowerCase();
  return (
    type === 'link' ||
    type === 'download' ||
    type === 'download-link' ||
    quality.startsWith('download')
  );
}

/**
 * Pick the best playback source, preferring genuine video/stream sources over
 * download-only links. Used at every "best = ...reduce(...)" site so the
 * Download link is never selected as streamUrl.
 *
 * @param {Array} sources - filtered source candidates
 * @returns {object|null} the best playable source (or null if none)
 */
function pickBestSource(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  // Prefer genuine playback sources (exclude download-only).
  const playable = sources.filter(s => !isDownloadSource(s));
  const pool = playable.length ? playable : sources;
  return pool.reduce((a, b) =>
    parseQualityNumber(b.quality) > parseQualityNumber(a.quality) ? b : a
  , pool[0]);
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

  // Preserve the provider's separately-split download-only sources (tagged
  // forDownload:true). These are for the premium Download button and must never
  // be mistaken for in-browser playback sources.
  const downloadSources = Array.isArray(result.downloadSources)
    ? result.downloadSources
      .filter(s => s && (s.url || s.file))
      .map(s => ({
        url: s.url || s.file,
        quality: s.quality || s.qualityLabel || 'auto',
        sourceType: s.sourceType || 'link',
        forDownload: true,
      }))
    : [];

  return {
    provider: result.provider || result.source || ANIME_HEAVEN_TAG,
    streamUrl: result.streamUrl || (normalizedSources[0] ? normalizedSources[0].url : null),
    sources: normalizedSources,
    // Download-only sources (for the premium Download button).
    downloadSources,
    subtitles: Array.isArray(result.subtitles) ? result.subtitles : [],
  };
}

// ── Cache Helpers ──────────────────────────────────────────
const STREAM_CACHE_TTL = parseInt(process.env.STREAM_CACHE_TTL_SECONDS || '3600', 10);

function buildCacheKey(animeTitle, episodeNumber, providerName) {
  return `stream:${animeTitle.toLowerCase().replace(/\s+/g, '-')}:ep${episodeNumber}:${providerName || 'all'}`;
}

// ─────────────────────────────────────────────────────────────
//  ANIMEHEAVEN EXECUTION (primary)
// ─────────────────────────────────────────────────────────────

/**
 * Execute the AnimeHeaven provider for an anime episode.
 *
 * Uses the FAST path when persisted identifiers are available:
 *   • slug + episodeKey → resolveStreamByKey (no search, no details)
 *   • slug only         → extractStreams({ identifier: slug }) (no search)
 *   • neither           → extractStreams({ title, episode }) (search — only
 *                         for anime not yet imported via AnimeHeaven)
 *
 * NEVER throws — always resolves to a result object:
 *   { resolved: boolean, result: object|null, error: string|null,
 *     category: string|null, durationMs: number }
 *
 * @param {string} animeTitle
 * @param {number|string} episodeNumber
 * @param {object} [identifiers] — { slug, episodeKey } from DB lookup
 * @returns {Promise<object>} Encapsulated outcome
 */
async function executeAnimeHeaven(animeTitle, episodeNumber, identifiers = {}) {
  streamCacheMetrics.increment('animeHeavenCalls');
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
  logger.info('[PLAYBACK]', { event: 'providerStarted', provider: ANIME_HEAVEN_TAG, animeTitle, episode: episodeNumber });
  logger.debugStream('Stream attempt pending', { provider: ANIME_HEAVEN_TAG, anime: animeTitle, episode: episodeNumber });

  try {
    let raw;
    // FAST PATH: persisted slug + episode key (+ episode URL) → no search, no details.
    if (identifiers.slug && identifiers.episodeKey) {
      logger.debugStream('[AnimeHeaven] FAST path (slug + episodeKey)', {
        anime: animeTitle,
        episode: episodeNumber,
        slug: identifiers.slug,
        hasEpisodeUrl: !!identifiers.episodeUrl,
      });
      raw = await animeHeavenProvider.resolveStreamByKey({
        slug: identifiers.slug,
        episodeKey: identifiers.episodeKey,
        episodeUrl: identifiers.episodeUrl || null,
      });
    } else if (identifiers.slug) {
      // MEDIUM PATH: persisted slug only → no search, but details lookup.
      logger.debugStream('[AnimeHeaven] MEDIUM path (slug only)', {
        anime: animeTitle,
        episode: episodeNumber,
        slug: identifiers.slug,
      });
      raw = await animeHeavenProvider.extractStreams({
        title: animeTitle,
        episode: episodeNumber,
        identifier: identifiers.slug,
        slug: identifiers.slug,
      });
    } else {
      // SLOW PATH: no persisted identifiers → full search (import-time only).
      logger.debugStream('[AnimeHeaven] SLOW path (search)', {
        anime: animeTitle,
        episode: episodeNumber,
      });
      raw = await animeHeavenProvider.resolveStream({
        title: animeTitle,
        episode: episodeNumber,
      });
    }

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
//  FALLBACK PROVIDER EXECUTION (Consumet-backed)
// ─────────────────────────────────────────────────────────────

/**
 * Execute a Consumet-backed fallback provider for an anime episode.
 * Used ONLY after AnimeHeaven fails ANIMEHEAVEN_MAX_ATTEMPTS times.
 *
 * @param {string} providerId — canonical provider id (kickassanime, hianime, animepahe)
 * @param {string} animeTitle
 * @param {number|string} episodeNumber
 * @returns {Promise<object>} Encapsulated outcome
 */
async function executeFallbackProvider(providerId, animeTitle, episodeNumber) {
  if (providerId === 'consumet' || providerId === 'kickassanime' || providerId === 'hianime' || providerId === 'animepahe') {
    streamCacheMetrics.increment('consumetCalls');
  }
  const healthKey = toHealthKey(providerId) || providerId;
  const start = Date.now();

  if (!isProviderHealthy(healthKey)) {
    logger.streamAttempt({
      provider: providerId,
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
  logger.info('[PLAYBACK]', { event: 'fallbackProviderStarted', provider: providerId, animeTitle, episode: episodeNumber });

  try {
    const consumet = new ConsumetProvider();
    const raw = await consumet.resolveStreamUrl({
      provider: providerId,
      title: animeTitle,
      episode: episodeNumber,
    });
    const result = normalizeProviderResult(raw);

    if (result && result.sources.length > 0) {
      recordSuccess(healthKey, Date.now() - attemptStart);
      logger.streamAttempt({
        provider: providerId,
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

    const category = 'EMPTY';
    logger.streamAttempt({
      provider: providerId,
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
    logger.streamAttempt({
      provider: providerId,
      anime: animeTitle,
      episode: episodeNumber,
      attempt: 1,
      result: timedOut ? 'timeout' : 'failure',
      failureReason: description || err.message,
      httpStatus: err.response?.status || 0,
      timedOut,
      cloudflareDetected: category === 'FORBIDDEN' || category === 'SERVER_ERROR',
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
/**
 * @param {string} animeTitle
 * @param {number|string} episodeNumber
 * @param {number|string} episodeId
 * @param {boolean} isPremium
 * @param {string} tier
 * @param {number} overallStart
 * @param {boolean} usePersistentCache
 * @param {object} identifiers — { slug, episodeKey }
 * @returns {Promise<object>} final stream payload
 */
async function continueWithFreshResolution(animeTitle, episodeNumber, episodeId, isPremium, tier, overallStart, usePersistentCache, identifiers = {}) {
  const resolveFresh = async () => executeAnimeHeaven(animeTitle, episodeNumber, identifiers);

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

    const best = pickBestSource(filteredSources);

    const payload = {
      provider: winner.provider || winnerProvider || ANIME_HEAVEN_TAG,
      streamUrl: best.url,
      sources: filteredSources,
      downloadSources: Array.isArray(winner.downloadSources) ? winner.downloadSources : [],
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
 * Resolve the best available stream for an anime episode.
 *
 * AnimeHeaven-first with fallback providers:
 *   1. DB lookup for persisted AnimeHeaven slug + episode key (NO search).
 *   2. AnimeHeaven attempted ANIMEHEAVEN_MAX_ATTEMPTS (3) times.
 *   3. Only after all 3 fail → fallback providers (KickAssAnime, Hianime,
 *      AnimePahe) in priority order.
 *
 * NEVER crashes on failure.
 *
 * @param {string} animeTitle — Title of the anime
 * @param {number|string} episodeNumber — Episode number
 * @param {object} options
 * @param {boolean} options.isPremium — Whether user can access 1080p/4K
 * @param {string} [options.preferredProvider] — Accepted for backward
 *   compatibility but IGNORED (AnimeHeaven is the primary provider).
 * @param {boolean} [options.skipCache] — Bypass cache for this request
 * @param {number|string} [options.episodeId] — Optional DB episode id used as
 *   the persistent-stream-cache key.
 * @returns {Promise<{provider: string, streamUrl: string|null, sources: Array, subtitles: Array, bestQuality: string, tier: string, providerUsed: string, fallbackActivated: boolean, attemptCount: number}>}
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

  // ── MANUAL VIDEO SOURCE (Admin-uploaded Cloudinary URL) ────────
  // This is an ADDITIVE source that takes precedence over AnimeHeaven.
  // If the episode has a `manual_video_url`, we return it directly as a
  // playable source WITHOUT touching the AnimeHeaven resolution flow,
  // the AnimeHeaven playable-URL fields, or the AnimeHeaven stream cache.
  //
  // It NEVER writes to, repurposes, or clears the existing AnimeHeaven
  // fields. It only reads `episodes.manual_video_url`.
  if (episodeId != null && episodeId !== '') {
    try {
      const [manualRows] = await db.query(
        'SELECT manual_video_url FROM episodes WHERE id = ? LIMIT 1',
        [episodeId]
      );
      const manualUrl = manualRows?.[0]?.manual_video_url;
      if (manualUrl && String(manualUrl).trim()) {
        const cleanUrl = String(manualUrl).trim();
        logger.info('[MANUAL_VIDEO] Manual source selected for playback', {
          anime: animeTitle,
          episode: episodeNumber,
          episodeId,
        });
        const source = { url: cleanUrl, quality: 'auto', isM3U8: false };
        return {
          provider: 'manual',
          streamUrl: cleanUrl,
          sources: [source],
          downloadSources: [],
          subtitles: [],
          bestQuality: 'auto',
          tier,
          cached: false,
          providerUsed: 'manual',
          fallbackActivated: false,
          attemptCount: 1,
          manualVideo: true,
        };
      }
    } catch (manualErr) {
      // A manual-source lookup failure must NEVER break playback — fall
      // through to the existing AnimeHeaven resolution exactly as before.
      logger.warn('[MANUAL_VIDEO] manual_video_url lookup failed (non-fatal)', {
        anime: animeTitle,
        episode: episodeNumber,
        episodeId,
        error: manualErr.message,
      });
    }
  }

  // ── Phase 3: DB lookup for persisted AnimeHeaven identifiers ──
  // This is the FAST PATH. The search step NEVER runs during playback.
  // The slug + episode key are stored at import time.
  const identifiers = await animeHeavenImportService.resolvePlaybackIdentifiers(animeTitle, episodeNumber);
  if (identifiers.slug) {
    logger.info('[AnimeHeaven Mapping]', {
      animeId: identifiers.animeId,
      identifier: identifiers.slug,
      episode: episodeNumber,
      episodeKey: identifiers.episodeKey || null,
      episodeUrl: identifiers.episodeUrl || null,
      source: 'database',
    });
    logger.info('[PLAYBACK] Provider episode ID', {
      animeTitle,
      episode: episodeNumber,
      slug: identifiers.slug,
      episodeKey: identifiers.episodeKey || null,
      episodeUrl: identifiers.episodeUrl || null,
    });
    logger.debugStream('[AnimeHeaven] DB identifiers found — skipping search', {
      anime: animeTitle,
      episode: episodeNumber,
      slug: identifiers.slug,
      hasEpisodeKey: !!identifiers.episodeKey,
    });

    // ── SELF-HEALING: if the episode key is missing, use the stored slug to
    // fetch details ONCE, locate the episode, persist the missing key, then
    // continue playback. This is a one-time repair, not a search.
    if (!identifiers.episodeKey && identifiers.animeId) {
      try {
        logger.info('[AnimeHeaven Mapping] Episode key missing — self-healing', {
          animeId: identifiers.animeId,
          identifier: identifiers.slug,
          episode: episodeNumber,
        });
        const details = await animeHeavenProvider.getAnimeDetails(identifiers.slug);
        const episodes = Array.isArray(details.episodes) ? details.episodes : [];
        const ep = episodes.find(e => Number(e.number) === Number(episodeNumber))
          || episodes.find(e => String(e.number) === String(episodeNumber));
        if (ep && ep.key) {
          await db.query(
            'UPDATE episodes SET animeheaven_episode_key = ?, animeheaven_episode_url = COALESCE(?, animeheaven_episode_url) WHERE id = ?',
            [ep.key, ep.url || null, identifiers.episodeId]
          );
          identifiers.episodeKey = ep.key;
          identifiers.episodeUrl = identifiers.episodeUrl || ep.url || null;
          logger.info('[AnimeHeaven Mapping] Self-healed episode key', {
            animeId: identifiers.animeId,
            episode: episodeNumber,
            episodeKey: ep.key,
          });
        }
      } catch (healErr) {
        logger.warn('[AnimeHeaven Mapping] Self-heal failed (non-fatal)', {
          animeId: identifiers.animeId,
          episode: episodeNumber,
          error: healErr.message,
        });
      }
    }
  } else {
    logger.debugStream('[AnimeHeaven] No DB identifiers — will use search path (import-time only)', {
      anime: animeTitle,
      episode: episodeNumber,
    });
  }

  // ── Cache Check ─────────────────────────────────────────
  if (!skipCache) {
    const cacheKey = buildCacheKey(animeTitle, episodeNumber);
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        logger.debugStream('Cache hit', { anime: animeTitle, episode: episodeNumber });

        // ── TIER-SAFE CACHE HIT ─────────────────────────────
        const cachedSources = Array.isArray(cached.sources) ? cached.sources : [];
        const tierSources = filterSourcesByTier(cachedSources, isPremium);
        if (tierSources.length > 0) {
          const best = pickBestSource(tierSources);
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
          // Record Tier-1 cache hit for observability.
          streamCacheMetrics.increment('tier1Hits');
          return {
            provider: cached.provider || ANIME_HEAVEN_TAG,
            streamUrl: best.url,
            sources: tierSources,
            downloadSources: Array.isArray(cached.downloadSources) ? cached.downloadSources : [],
            subtitles: Array.isArray(cached.subtitles) ? cached.subtitles : [],
            bestQuality: best.quality || 'auto',
            tier,
            cached: true,
            providerUsed: cached.provider || ANIME_HEAVEN_TAG,
            fallbackActivated: false,
            attemptCount: 1,
          };
        }
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

  // ── Persistent cache (Redis-first, MySQL-backed) ──────────
  // Uses the canonical episodeId + provider key so Redis entries
  // populated by streamCacheService.getOrResolve() are found here.
  const usePersistentCache = STREAM_CACHE_ENABLED && !skipCache && episodeId != null && episodeId !== '';

  if (usePersistentCache) {
    // Tier 1: Redis (shared fast cache, canonical key).
    // Checked before MySQL so a Redis hit saved by a previous
    // getOrResolve() call avoids a DB read entirely.
    const redisKey = streamCacheService.buildRedisKey(episodeId, STREAM_CACHE_PROVIDER);
    try {
      const redisHit = await cache.get(redisKey);
      if (redisHit && redisHit.sources && redisHit.sources.length > 0) {
        // Check upstream expiry from the cached payload.
        const upstreamExpired = redisHit.detectedExpiresAt
          ? new Date(redisHit.detectedExpiresAt).getTime() <= Date.now()
          : false;
        if (!upstreamExpired) {
          logger.debugStream('Redis stream cache hit', { anime: animeTitle, episode: episodeNumber, episodeId });
          streamCacheMetrics.increment('redisHits');
          const filteredSources = filterSourcesByTier(redisHit.sources, isPremium);
          if (filteredSources.length > 0) {
            const best = pickBestSource(filteredSources);
            const payload = {
              provider: redisHit.provider || STREAM_CACHE_PROVIDER,
              streamUrl: best.url,
              sources: filteredSources,
              downloadSources: Array.isArray(redisHit.downloadSources) ? redisHit.downloadSources : [],
              subtitles: Array.isArray(redisHit.subtitles) ? redisHit.subtitles : [],
              bestQuality: best.quality || 'auto',
              tier,
              cached: true,
            };
            logger.streamAttempt({
              provider: payload.provider, anime: animeTitle, episode: episodeNumber,
              result: 'success', httpStatus: 0, timedOut: false, cloudflareDetected: false,
              searchSuccess: true, streamSuccess: true, sources: filteredSources.length,
              bestQuality: payload.bestQuality, startTime: new Date(overallStart).toISOString(),
              endTime: new Date().toISOString(), latencyMs: Date.now() - overallStart,
            });
            return { ...payload, providerUsed: payload.provider, fallbackActivated: false, attemptCount: 1 };
          }
        }
      }
    } catch (cacheErr) {
      logger.debug('[STREAM_CACHE] Redis check failed (non-fatal)', { error: cacheErr.message });
    }
    const cachedLookup = await streamCacheService.findCachedStream(episodeId, STREAM_CACHE_PROVIDER);
    if (cachedLookup.result) {
      logger.debugStream('Persistent stream cache hit', { anime: animeTitle, episode: episodeNumber, episodeId });
      const cachedWinner = cachedLookup.result;
      const filteredSources = filterSourcesByTier(cachedWinner.sources, isPremium);
      if (filteredSources.length > 0) {
        const best = pickBestSource(filteredSources);

        // ── CACHE-SOURCE LIVENESS PROBE ─────────────────────
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
          return continueWithFreshResolution(animeTitle, episodeNumber, episodeId, isPremium, tier, overallStart, usePersistentCache, identifiers);
        }

        // Record direct MySQL cache hit (user-facing serving path).
        streamCacheMetrics.increment('mysqlHits');

        const payload = {
          provider: cachedWinner.provider || STREAM_CACHE_PROVIDER,
          streamUrl: best.url,
          sources: filteredSources,
          downloadSources: Array.isArray(cachedWinner.downloadSources) ? cachedWinner.downloadSources : [],
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
// ── DIAG: deferred observation for URL lifetime tracking ─
        streamObservationService.observeOnCacheHit(episodeId, STREAM_CACHE_PROVIDER, cachedLookup.row, { referer: bestSource.referer, origin: bestSource.origin });
        return {
          ...payload,
          providerUsed: payload.provider,
          fallbackActivated: false,
          attemptCount: 1,
        };
      }
    }
  }

  // ── Phase 4: AnimeHeaven-first with fallback ─────────────
  // AnimeHeaven is attempted ANIMEHEAVEN_MAX_ATTEMPTS (3) times.
  // Only after all 3 fail do the fallback providers activate.
  let attemptCount = 0;
  let fallbackActivated = false;
  let winner = null;
  let winnerProvider = null;
  let lastError = null;

  // Attempt 1..3: AnimeHeaven.
  for (let attempt = 1; attempt <= ANIMEHEAVEN_MAX_ATTEMPTS; attempt++) {
    attemptCount += 1;
    logger.debugStream('[AnimeHeaven] Attempt', { anime: animeTitle, episode: episodeNumber, attempt, of: ANIMEHEAVEN_MAX_ATTEMPTS });

    const outcome = await executeAnimeHeaven(animeTitle, episodeNumber, identifiers);
    if (outcome.resolved && outcome.result && outcome.result.sources.length > 0) {
      winner = outcome.result;
      winnerProvider = ANIME_HEAVEN_TAG;
      break;
    }
    lastError = outcome.error || 'no playable stream found';
    // Small backoff between AnimeHeaven retries (avoid hammering upstream).
    if (attempt < ANIMEHEAVEN_MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }

  // If AnimeHeaven failed all 3 times → activate fallback providers.
  if (!winner) {
    fallbackActivated = true;
    logger.warn('[AnimeHeaven] All 3 attempts failed — activating fallback providers', {
      anime: animeTitle,
      episode: episodeNumber,
      lastError,
    });

    for (const providerId of FALLBACK_PROVIDER_ORDER) {
      attemptCount += 1;
      logger.debugStream('[Fallback] Attempting provider', { anime: animeTitle, episode: episodeNumber, provider: providerId });

      const outcome = await executeFallbackProvider(providerId, animeTitle, episodeNumber);
      if (outcome.resolved && outcome.result && outcome.result.sources.length > 0) {
        winner = outcome.result;
        winnerProvider = providerId;
        break;
      }
      lastError = outcome.error || 'no playable stream found';
    }
  }

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
      fallbackActivated,
      attemptCount,
    });
  } else {
    logger.stream({
      result: 'all_failed',
      duration: elapsed,
      totalDurationMs: elapsed,
      provider: ANIME_HEAVEN_TAG,
      category: 'ALL_FAILED',
      error: lastError,
      fallbackActivated,
      attemptCount,
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

    // Pick best quality for tier (prefer genuine playback, never a download link).
    const best = pickBestSource(filteredSources);

    const payload = {
      provider: winner.provider || winnerProvider || ANIME_HEAVEN_TAG,
      streamUrl: best.url,
      sources: filteredSources,
      downloadSources: Array.isArray(winner.downloadSources) ? winner.downloadSources : [],
      subtitles: winner.subtitles || [],
      bestQuality: best.quality || 'auto',
      tier,
    };
// ── DIAG: log fresh resolution result ──────────────────
    streamDiag.logFreshResolution(episodeId, payload.provider, winner, Date.now() - overallStart, true);

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

    // ── WARM-CACHE NEXT EPISODE (fire-and-forget) ─────────
    // Preload the next episode's stream metadata in the background so the
    // user's next-play is a warm cache hit. This never blocks the response.
    prefetchNextEpisode(animeTitle, episodeNumber, isPremium).catch(() => {});

    return {
      ...payload,
      providerUsed: payload.provider,
      fallbackActivated,
      attemptCount,
    };
  }

  // ── Provider failed ─────────────────────────────────────
  const errorMsg = `No stream provider could resolve "${animeTitle}" Episode ${episodeNumber}. Attempted provider: ${ANIME_HEAVEN_TAG} (${elapsed}ms)`;
  logger.streamAttempt({
    provider: ANIME_HEAVEN_TAG,
    anime: animeTitle,
    episode: episodeNumber,
    result: 'failure',
    failureReason: lastError || 'all providers failed',
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
 * Background warm-cache of the NEXT episode's stream metadata.
 *
 * When a user watches episode N, this preloads episode N+1's AnimeHeaven
 * stream into the persistent cache so the next-play is a cache hit (warm),
 * not a cold resolution. This is fire-and-forget: it never blocks the current
 * request and any failure is swallowed.
 *
 * @param {string} animeTitle
 * @param {number|string} currentEpisodeNumber
 * @param {boolean} isPremium — premium tier for the warm cache
 */
async function prefetchNextEpisode(animeTitle, currentEpisodeNumber, isPremium) {
  const nextEp = Number(currentEpisodeNumber) + 1;
  if (!Number.isFinite(nextEp) || nextEp < 1) return;

  try {
    // Resolve the next episode's DB identifiers (slug + episode key + url).
    const nextIdentifiers = await animeHeavenImportService.resolvePlaybackIdentifiers(animeTitle, nextEp);
    if (!nextIdentifiers.slug || !nextIdentifiers.episodeKey) {
      // No stored identifiers for the next episode — cannot warm-cache.
      return;
    }

    // Resolve the next episode via the FAST path (no search) and cache it.
    const outcome = await executeAnimeHeaven(animeTitle, nextEp, nextIdentifiers);
    if (outcome.resolved && outcome.result && outcome.result.sources.length > 0) {
      // Persist to the persistent episode_stream_cache (if episodeId known).
      if (nextIdentifiers.episodeId) {
        await streamCacheService.saveStream(nextIdentifiers.episodeId, STREAM_CACHE_PROVIDER, outcome.result);
      }
      // Also cache in the in-memory stream cache for instant warm hits.
      const cacheKey = buildCacheKey(animeTitle, nextEp);
      const filtered = filterSourcesByTier(outcome.result.sources, isPremium);
      const best = pickBestSource(filtered);
      if (best) {
        await cache.set(cacheKey, {
          provider: outcome.result.provider || ANIME_HEAVEN_TAG,
          streamUrl: best.url,
          sources: filtered,
          subtitles: outcome.result.subtitles || [],
          bestQuality: best.quality || 'auto',
        }, STREAM_CACHE_TTL);
      }
      logger.info('[AnimeHeaven] Warm-cached next episode', { anime: animeTitle, nextEp, sources: outcome.result.sources.length });
    }
  } catch (err) {
    logger.debugStream('Next-episode warm-cache failed (non-fatal)', { anime: animeTitle, nextEp, error: err.message });
  }
}

/**
 * Resolve streams for the "Switch Server" dropdown.
 *
 * With AnimeHeaven as the primary provider this returns at most one entry (the
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

  // Use the fast path (DB identifiers) when available.
  const identifiers = await animeHeavenImportService.resolvePlaybackIdentifiers(animeTitle, episodeNumber);
  const outcome = await executeAnimeHeaven(animeTitle, episodeNumber, identifiers);

  if (outcome.resolved && outcome.result && outcome.result.sources.length > 0) {
    const filteredSources = filterSourcesByTier(outcome.result.sources, isPremium);
    const best = pickBestSource(filteredSources);

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
  prefetchNextEpisode,
  // Exposed for tests/diagnostics.
  ANIMEHEAVEN_MAX_ATTEMPTS,
  FALLBACK_PROVIDER_ORDER,
};

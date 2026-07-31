// ============================================================
//  services/streamingService.js — Multi-Provider Fallback Engine
//
//  DYNAMIC RESOLVER PIPELINE:
//    • Providers are configured via STREAM_PROVIDERS env var
//    • Each provider has INDEPENDENT health tracking
//    • The pipeline NEVER stops after a single failure
//    • Every configured provider is attempted before giving up
//    • Returns the FIRST successful stream
//
//  Provider Types:
//    consumet-<name> — Consumet-backed sub-provider (KickAssAnime, AnimeKai, etc.)
//    consumet-http   — External Consumet API server
//    miruro          — Miruro API
//
//  Quality Tiers:
//    Free users:  ≤ 720p (480p, 720p)
//    Premium/Admin users: up to 4K (1080p, 4K)
//
//  Proxy: Uses the SHARED proxy manager from utils/providerHttp.js
// ============================================================
const { provider: consumetProvider } = require('./consumetProvider');
const { request, isProviderHealthy, getProviderHealth, classifyError, recordSuccess, recordFailure } = require('../utils/providerHttp');
const cache = require('../utils/cacheService');
const logger = require('../utils/logger');

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

// ─────────────────────────────────────────────────────────────
//  PROVIDER CONFIGURATION
// ─────────────────────────────────────────────────────────────

/**
 * Default provider order (all Consumet sub-providers + HTTP fallback + Miruro).
 * This ensures that if KickAssAnime returns 403, we fall through to AnimeKai,
 * then AnimePahe, Hianime, AnimeSaturn, and finally HTTP/Miruro fallbacks.
 *
 * Set STREAM_PROVIDERS env var to override, e.g.:
 *   STREAM_PROVIDERS=consumet-kickassanime,consumet-animekai,miruro
 */
const DEFAULT_PROVIDERS = [
  'consumet-kickassanime',
  'consumet-animekai',
  'consumet-animepahe',
  'consumet-hianime',
  'consumet-animesaturn',
  'consumet-http',
  'miruro',
];

const PROVIDER_ORDER = (process.env.STREAM_PROVIDERS || DEFAULT_PROVIDERS.join(','))
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

logger.info('Provider order configured', { providers: PROVIDER_ORDER });

// ─────────────────────────────────────────────────────────────
//  INTERNAL RETRY LOGIC (per provider)
// ─────────────────────────────────────────────────────────────

const PROVIDER_RETRY_CONFIG = {
  maxRetries: 2,       // Each provider gets 2 retries before moving on
  perRetryDelayMs: 1000,
};

/**
 * Execute a resolver function with internal retries and health tracking.
 * Each provider gets its own retry budget before the pipeline advances.
 *
 * @param {string} providerName - The display name for logging
 * @param {string} healthKey - The key for health tracking
 * @param {Function} resolverFn - Async function returning result or null
 * @returns {Promise<object|null>} - The resolved result or null
 */
async function executeWithRetry(providerName, healthKey, resolverFn) {
  const { maxRetries, perRetryDelayMs } = PROVIDER_RETRY_CONFIG;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptStart = Date.now();
    const attemptLabel = `attempt ${attempt + 1}/${maxRetries + 1}`;

    // Check provider health before attempting (skip only if degraded and attempt > 0)
    if (attempt === 0) {
      if (!isProviderHealthy(healthKey)) {
        logger.stream({ provider: providerName, attempt: attempt + 1, result: 'skipped_degraded' });
        return null;
      }
    }

    logger.stream({ provider: providerName, attempt: attempt + 1, status: 'pending' });

    try {
      const result = await resolverFn();
      const elapsed = Date.now() - attemptStart;

      if (result && result.sources && result.sources.length > 0) {
        // Record success in health tracker
        recordSuccess(healthKey, elapsed);
        logger.stream({ provider: providerName, attempt: attempt + 1, duration: elapsed, sources: result.sources.length, result: 'success' });
        return result;
      }

      // Resolver returned null/empty sources (not an error)
      const elapsed2 = Date.now() - attemptStart;
      logger.stream({ provider: providerName, attempt: attempt + 1, duration: elapsed2, result: 'no_sources' });

      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, perRetryDelayMs));
      }
      continue;
    } catch (err) {
      const elapsed = Date.now() - attemptStart;
      const { category, description } = classifyError(err);

      logger.stream({ provider: providerName, attempt: attempt + 1, duration: elapsed, error: description || err.message, category, result: 'error' });

      // Record failure only on last attempt
      if (attempt === maxRetries) {
        recordFailure(healthKey, elapsed);
      }

      // Non-retryable errors: abandon provider immediately
      if (!classifyError(err).retryable && err.code !== 'PROVIDER_DEGRADED') {
        logger.stream({ provider: providerName, attempt: attempt + 1, result: 'non_retryable' });
        return null;
      }

      // Retry if attempts remain
      if (attempt < maxRetries) {
        const delay = perRetryDelayMs * Math.pow(2, attempt); // exponential backoff
        logger.stream({ provider: providerName, attempt: attempt + 1, retryDelay: delay, retriesLeft: maxRetries - attempt, result: 'retry' });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  logger.stream({ provider: providerName, result: 'exhausted' });
  return null;
}

// ─────────────────────────────────────────────────────────────
//  RESOLVER FACTORIES
// ─────────────────────────────────────────────────────────────

/**
 * Build a resolver for a Consumet-backed sub-provider.
 * Maps "consumet-kickassanime" → provider "KickAssAnime" in the registry.
 */
function buildConsumetSubProviderResolver(providerTag) {
  // Convert "consumet-kickassanime" → "KickAssAnime"
  const subProviderName = providerTag
    .replace(/^consumet-/, '')
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');

  const healthKey = `consumet-${subProviderName.toLowerCase()}`;

  return async (animeTitle, episodeNumber) => {
    if (!consumetProvider.hasProvider(subProviderName)) {
      logger.stream({ provider: providerTag, result: 'not_in_registry', subProviderName });
      return null;
    }

    return consumetProvider.resolveStreamUrl({
      provider: subProviderName,
      title: animeTitle,
      episode: episodeNumber,
    });
  };
}

/**
 * Build a resolver for the consumet-http provider (external API).
 */
function buildConsumetHttpResolver() {
  const healthKey = 'consumet-http';

  return async (animeTitle, episodeNumber) => {
    const baseUrl = process.env.CONSUMET_API_URL;
    if (!baseUrl) {
      logger.stream({ provider: 'consumet-http', result: 'skipped_config', reason: 'CONSUMET_API_URL not set' });
      return null;
    }

    const startTime = Date.now();
    logger.stream({ provider: 'consumet-http', anime: animeTitle, episode: episodeNumber, status: 'pending' });

    try {
      if (!isProviderHealthy(healthKey)) {
        logger.stream({ provider: 'consumet-http', result: 'skipped_degraded' });
        return null;
      }

      const searchRes = await request({
        method: 'get',
        url: `${baseUrl}/anime/${encodeURIComponent(animeTitle)}`,
      }, {
        providerName: healthKey,
        timeout: 15000,
      });

      const results = searchRes.data?.results || [];
      if (!results.length) {
        logger.stream({ provider: 'consumet-http', result: 'no_search_results', duration: Date.now() - startTime });
        return null;
      }

      const target = results[0];
      const animeId = target.id;

      const epRes = await request({
        method: 'get',
        url: `${baseUrl}/anime/${animeId}`,
      }, {
        providerName: healthKey,
        timeout: 15000,
      });

      const episodes = epRes.data?.episodes || [];
      const targetEp = episodes.find(e => e.number === Number(episodeNumber));
      if (!targetEp?.id) {
        logger.stream({ provider: 'consumet-http', result: 'episode_not_found', episode: episodeNumber, duration: Date.now() - startTime });
        return null;
      }

      const srcRes = await request({
        method: 'get',
        url: `${baseUrl}/anime/${animeId}/episodes/${encodeURIComponent(targetEp.id)}`,
      }, {
        providerName: healthKey,
        timeout: 15000,
      });

      const rawSources = srcRes.data?.sources || [];
      const subtitles = srcRes.data?.subtitles || [];

      const sources = rawSources.map(s => ({
        url: s.url,
        quality: s.quality || 'auto',
      }));

      const best = sources.reduce((a, b) =>
        parseQualityNumber(b.quality) > parseQualityNumber(a.quality) ? b : a
      , sources[0]);

      const elapsed = Date.now() - startTime;
      logger.stream({ provider: 'consumet-http', result: 'success', duration: elapsed, sources: sources.length });

      return {
        provider: 'consumet-http',
        streamUrl: best?.url || null,
        sources,
        subtitles: subtitles.map(sub => ({
          lang: sub.lang || sub.language || 'Unknown',
          url: sub.url,
        })),
      };
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const { category } = classifyError(err);
      logger.stream({ provider: 'consumet-http', result: 'error', duration: elapsed, category, error: err.message });
      return null;
    }
  };
}

/**
 * Build a resolver for the Miruro API provider.
 */
function buildMiruroResolver() {
  const healthKey = 'miruro';

  return async (animeTitle, episodeNumber) => {
    const baseUrl = process.env.MIRURO_API_URL;
    if (!baseUrl) {
      logger.stream({ provider: 'miruro', result: 'skipped_config', reason: 'MIRURO_API_URL not set' });
      return null;
    }

    const startTime = Date.now();
    logger.stream({ provider: 'miruro', anime: animeTitle, episode: episodeNumber, status: 'pending' });

    try {
      if (!isProviderHealthy(healthKey)) {
        logger.stream({ provider: 'miruro', result: 'skipped_degraded' });
        return null;
      }

      const searchRes = await request({
        method: 'get',
        url: `${baseUrl}/search`,
        params: { query: animeTitle },
      }, {
        providerName: healthKey,
        timeout: 15000,
      });

      const results = searchRes.data?.results || [];
      if (!results.length) {
        logger.stream({ provider: 'miruro', result: 'no_results' });
        return null;
      }

      const animeData = results[0];
      const animeId = animeData.id || animeData.slug;

      const epRes = await request({
        method: 'get',
        url: `${baseUrl}/anime/${animeId}/episode/${episodeNumber}`,
      }, {
        providerName: healthKey,
        timeout: 15000,
      });

      const rawSources = epRes.data?.sources || [];
      const sources = rawSources.map(s => ({
        url: s.url,
        quality: s.quality || 'auto',
      }));

      const best = sources.reduce((a, b) =>
        parseQualityNumber(b.quality) > parseQualityNumber(a.quality) ? b : a
      , sources[0]);

      const elapsed = Date.now() - startTime;
      logger.stream({ provider: 'miruro', result: 'success', duration: elapsed, sources: sources.length });

      return {
        provider: 'miruro',
        streamUrl: best?.url || null,
        sources,
        subtitles: (epRes.data?.subtitles || []).map(sub => ({
          lang: sub.lang || sub.language || 'Unknown',
          url: sub.url,
        })),
      };
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const { category } = classifyError(err);
      logger.stream({ provider: 'miruro', result: 'error', duration: elapsed, category, error: err.message });
      return null;
    }
  };
}

// ─────────────────────────────────────────────────────────────
//  DYNAMIC RESOLVER REGISTRY
// ─────────────────────────────────────────────────────────────

/**
 * Map provider tags to resolver factory functions.
 * This is the extensible registry — add new provider types here.
 */
const RESOLVER_FACTORIES = {
  'consumet-': buildConsumetSubProviderResolver,  // prefix match for consumet-*
  'consumet-http': buildConsumetHttpResolver,
  'miruro': buildMiruroResolver,
};

/**
 * Build a resolver function for a given provider tag.
 * Falls back to consumet sub-provider if tag starts with 'consumet-'
 * and isn't 'consumet-http'.
 */
function buildResolverForProvider(providerTag) {
  const tag = providerTag.toLowerCase();

  // Exact match first
  if (tag === 'consumet-http') return buildConsumetHttpResolver();
  if (tag === 'miruro') return buildMiruroResolver();

  // Prefix match for consumet-* sub-providers
  if (tag.startsWith('consumet-')) {
    return buildConsumetSubProviderResolver(tag);
  }

  // Unknown provider type
  logger.warn('Unknown provider type', { providerTag });
  return null;
}

// ── Cache Helpers ──────────────────────────────────────────
const STREAM_CACHE_TTL = parseInt(process.env.STREAM_CACHE_TTL_SECONDS || '300', 10);

function buildCacheKey(animeTitle, episodeNumber, providerName) {
  return `stream:${animeTitle.toLowerCase().replace(/\s+/g, '-')}:ep${episodeNumber}:${providerName || 'all'}`;
}

// ── Main Resolver ──────────────────────────────────────────

/**
 * Resolve the best available stream for an anime episode.
 * Tries providers in priority order; returns the first success.
 * NEVER stops after a single provider failure — continues through
 * every configured provider.
 *
 * @param {string} animeTitle — Title of the anime
 * @param {number|string} episodeNumber — Episode number
 * @param {object} options
 * @param {boolean} options.isPremium — Whether user can access 1080p/4K
 * @param {string} [options.preferredProvider] — Force a specific provider
 * @param {boolean} [options.skipCache] — Bypass cache for this request
 * @returns {Promise<{provider: string, streamUrl: string|null, sources: Array, subtitles: Array, bestQuality: string, tier: string}>}
 */
async function resolveStream(animeTitle, episodeNumber, options = {}) {
  const { isPremium = false, preferredProvider, skipCache = false } = options;
  const tier = isPremium ? 'premium' : 'free';
  const overallStart = Date.now();

  // ── Movie Guard ─────────────────────────────────────────
  const moviePattern = /\b(movie|film|ova|special|the movie)\b/i;
  const titleWords = (animeTitle || '').split(' ');
  const lastWord = titleWords[titleWords.length - 1];
  const hasMovieSuffix = /^\d+$/.test(lastWord) && titleWords.length > 1;
  const isMovieByTitle = moviePattern.test(animeTitle) || hasMovieSuffix;

  if (isMovieByTitle && Number(episodeNumber) > 1) {
    console.log(`[StreamingService] 🎬 MOVIE GUARD: "${animeTitle}" identified as movie — forcing Ep 1 (was ${episodeNumber})`);
    episodeNumber = 1;
  }

  console.log(`[StreamingService] 🎬 resolveStream | "${animeTitle}" Ep ${episodeNumber} | tier: ${tier}`);

  // ── Cache Check ─────────────────────────────────────────
  if (!skipCache) {
    const cacheKey = buildCacheKey(animeTitle, episodeNumber);
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        console.log(`[StreamingService] 💾 CACHE HIT | "${animeTitle}" Ep ${episodeNumber}`);
        return cached;
      }
      console.log(`[StreamingService] 💾 CACHE MISS | "${animeTitle}" Ep ${episodeNumber}`);
    } catch (cacheErr) {
      console.warn(`[StreamingService] Cache read failed: ${cacheErr.message} — proceeding without cache`);
    }
  } else {
    console.log(`[StreamingService] ⏭ Cache bypassed (skipCache=true)`);
  }

  // ── Determine provider order ────────────────────────────
  // If a preferred provider is specified, move it to the front
  const providerOrder = preferredProvider
    ? [preferredProvider, ...PROVIDER_ORDER.filter(p => p !== preferredProvider)]
    : PROVIDER_ORDER;

  console.log(`[StreamingService] 📋 Provider execution order:`);
  providerOrder.forEach((p, i) => {
    console.log(`   ${i + 1}. ${p}`);
  });

// ── Try providers in order — NEVER STOP ON FAILURE ──────
  for (const providerTag of providerOrder) {
    // Build the resolver function for this provider tag
    // Each resolver is an async function(animeTitle, episodeNumber) => result
    const resolver = buildResolverForProvider(providerTag);
    if (!resolver) {
      console.warn(`[StreamingService] ⚠️ ${providerTag} | No resolver available — skipping`);
      continue;
    }

    // Determine health key for this provider (used by providerHttp health tracking)
    const healthKey = providerTag === 'miruro'
      ? 'miruro'
      : providerTag === 'consumet-http'
        ? 'consumet-http'
        : `consumet-${providerTag.replace('consumet-', '')}`;

    // Execute with per-provider retry logic
    // Each provider gets its own retry budget before the pipeline advances
    const result = await executeWithRetry(providerTag, healthKey, () => {
      return resolver(animeTitle, episodeNumber);
    });

    if (result && result.sources && result.sources.length > 0) {
      // Filter by tier
      const filteredSources = filterSourcesByTier(result.sources, isPremium);
      if (filteredSources.length === 0) {
        console.log(`[StreamingService] ⚠️ ${providerTag} returned sources but none match tier "${tier}" — continuing`);
        continue;
      }

      // Pick best quality for tier
      const best = filteredSources.reduce((a, b) =>
        parseQualityNumber(b.quality) > parseQualityNumber(a.quality) ? b : a
      , filteredSources[0]);

      const payload = {
        provider: result.provider || providerTag,
        streamUrl: best.url,
        sources: filteredSources,
        subtitles: result.subtitles || [],
        bestQuality: best.quality || 'auto',
        tier,
      };

      // ── Cache the result ────────────────────────────────
      try {
        const cacheKey = buildCacheKey(animeTitle, episodeNumber);
        await cache.set(cacheKey, payload, STREAM_CACHE_TTL);
        console.log(`[StreamingService] 💾 CACHED | "${animeTitle}" Ep ${episodeNumber} for ${STREAM_CACHE_TTL}s`);
      } catch (cacheErr) {
        console.warn(`[StreamingService] Cache write failed: ${cacheErr.message}`);
      }

      const elapsed = Date.now() - overallStart;
      console.log(`[StreamingService] ✅ RESOLVED | "${animeTitle}" Ep ${episodeNumber} → ${payload.provider} (${best.quality}) | ${elapsed}ms`);
      console.log(`[StreamingService] 📊 Summary: ${providerOrder.length} providers configured, succeeded on ${providerTag}`);

      return payload;
    }

    // This provider failed — log and continue to next
    console.log(`[StreamingService] ➡️ ${providerTag} | Failed — advancing to next provider`);
  }

  // ── All providers failed ────────────────────────────────
  const elapsed = Date.now() - overallStart;
  const attemptedProviders = providerOrder.join(', ');
  const errorMsg = `No stream provider could resolve "${animeTitle}" Episode ${episodeNumber}. Attempted ${providerOrder.length} providers: ${attemptedProviders} (${elapsed}ms)`;
  console.error(`[StreamingService] 🛑 ALL PROVIDERS FAILED | ${errorMsg}`);
  console.error(`[StreamingService] 📊 Attempted ${providerOrder.length} providers in ${elapsed}ms: ${attemptedProviders}`);
  throw new Error(errorMsg);
}

/**
 * Resolve streams from ALL configured providers (for server switcher).
 * Returns an array of results from each provider.
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

  console.log(`[StreamingService] 📋 resolveAllProviders | "${animeTitle}" Ep ${episodeNumber}`);

  for (const providerTag of PROVIDER_ORDER) {
    const resolver = buildResolverForProvider(providerTag);
    if (!resolver) continue;

    try {
      const healthKey = providerTag === 'miruro'
        ? 'miruro'
        : providerTag === 'consumet-http'
          ? 'consumet-http'
          : `consumet-${providerTag.replace('consumet-', '')}`;

      const result = await executeWithRetry(providerTag, healthKey, () => {
        return resolver(animeTitle, episodeNumber);
      });

      if (result && result.sources && result.sources.length > 0) {
        const filteredSources = filterSourcesByTier(result.sources, isPremium);
        const best = filteredSources.reduce((a, b) =>
          parseQualityNumber(b.quality) > parseQualityNumber(a.quality) ? b : a
        , filteredSources[0]);

        results.push({
          provider: result.provider || providerTag,
          streamUrl: best?.url || null,
          sources: filteredSources,
          bestQuality: best?.quality || 'auto',
        });
      }
    } catch (err) {
      const { category } = classifyError(err);
      console.warn(`[StreamingService] resolveAllProviders: ${providerTag} failed [${category}]: ${err.message}`);
    }
  }

  console.log(`[StreamingService] 📋 resolveAllProviders | ${results.length}/${PROVIDER_ORDER.length} providers resolved`);
  return results;
}

// ── Provider Health Endpoint ───────────────────────────────
function getProviderHealthStatus() {
  const health = getProviderHealth();

  // Also add Consumet sub-provider health entries
  const consumetProviders = consumetProvider.listProviders();
  for (const name of consumetProviders) {
    const key = `consumet-${name.toLowerCase()}`;
    if (!health[key]) {
      health[key] = {
        successRate: 'N/A',
        totalRequests: 0,
        consecutiveFailures: 0,
        avgResponseTime: 'N/A',
        degraded: false,
        degradedRemainingSec: 0,
      };
    }
  }

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


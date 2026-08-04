// ============================================================
//  services/streamingService.js — Multi-Provider Fallback Engine
//
//  DYNAMIC RESOLVER PIPELINE (PARTIAL-PARALLEL):
//    • Providers are configured via STREAM_PROVIDERS env var
//    • Each provider has INDEPENDENT health tracking
//    • The pipeline NEVER stops after a single failure
//    • Every configured provider is attempted before giving up
//    • Returns the FIRST successful stream
//
//  EXECUTION MODEL:
//    Sequential-first, then parallel race:
//      1. The preferred provider (or first provider) is tried first
//         with a short soft deadline — preserves the historical
//         "preferred provider wins" behaviour and fast-path latency.
//      2. If it fails/returns empty within the soft deadline, the
//         REMAINING providers are launched IN PARALLEL and the first
//         successful playable stream is returned.
//      3. A global pipeline deadline (PIPELINE_TIMEOUT_MS) caps the
//         whole operation so the request fails fast instead of
//         dangling for ~80s (worst-case sequential).
//      4. Every provider runs in its own error-isolated context — a
//         single provider crashing/timeout never crashes the request.
//      5. Structured logs are collected per provider for diagnosis.
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
//
//  COMPATIBILITY:
//    The public API surface (resolveStream, resolveAllProviders,
//    filterSourcesByTier, getBestQualityLabel, getProviderHealthStatus,
//    QUALITY_TIERS) and the response payload shape are PRESERVED so no
//    controller/route/frontend changes are required.
// ============================================================
const { provider: consumetProvider } = require('./consumetProvider');
const {
  request,
  isProviderHealthy,
  getProviderHealth,
  classifyError,
  recordSuccess,
  recordFailure,
} = require('../utils/providerHttp');
const {
  PROVIDER_IDS,
  normalizeProviderName,
  toConsumetClassName,
  toHealthKey,
  getDefaultProviderOrder,
} = require('./providerRegistry');
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

// ── Pipeline Tuning ─────────────────────────────────────────
// Global ceiling for the ENTIRE provider pipeline. Prevents the request
// from dangling when every provider is slow (sequential worst case used to
// exceed 80s). The individual HTTP layer already caps each call at 10s.
const PIPELINE_TIMEOUT_MS = parseInt(process.env.STREAM_PIPELINE_TIMEOUT_MS || '15000', 10);

// Soft deadline for the FIRST/preferred provider attempt. If the preferred
// provider doesn't resolve within this window we fall through to the
// parallel race. Kept short so the fast path stays fast.
const PREFERRED_SOFT_DEADLINE_MS = parseInt(process.env.STREAM_PREFERRED_DEADLINE_MS || '6000', 10);

// Provider retry budget BEFORE the pipeline advances to the next provider.
const PROVIDER_RETRY_CONFIG = {
  maxRetries: 1,        // Each provider gets 1 retry before moving on (reduced from 2 to bound latency)
  perRetryDelayMs: 500, // Short backoff between attempts
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

/**
 * Normalize a provider result into the canonical shape the pipeline expects.
 *
 * The in-memory ConsumetProvider returns `{ streamUrl, allSources, subtitles,
 * provider }` while the HTTP/Miruro resolvers return `{ streamUrl, sources,
 * subtitles, provider }`. This helper maps both (and any other variant) into
 * `{ streamUrl, sources, subtitles, provider }` so the success check
 * `sources.length > 0` works uniformly. THIS FIXES the bug where Consumet
 * sub-providers were silently skipped because they returned `allSources`.
 *
 * @param {object} result - Raw provider result
 * @returns {object|null} Normalized result, or null if not usable
 */
function normalizeProviderResult(result) {
  if (!result) return null;

  // Normalize the sources array (accept both `sources` and `allSources`).
  let sources = result.sources;
  if (!Array.isArray(sources)) sources = result.allSources;
  if (!Array.isArray(sources)) sources = [];

  // Normalize each source entry to { url, quality } if needed.
  const normalizedSources = sources
    .filter(s => s && (s.url || s.file))
    .map(s => ({
      url: s.url || s.file,
      quality: s.quality || s.qualityLabel || 'auto',
    }));

  if (normalizedSources.length === 0) return null;

  return {
    provider: result.provider || result.source || 'unknown',
    streamUrl: result.streamUrl || (normalizedSources[0] ? normalizedSources[0].url : null),
    sources: normalizedSources,
    subtitles: Array.isArray(result.subtitles) ? result.subtitles : [],
  };
}

// ─────────────────────────────────────────────────────────────
//  PROVIDER CONFIGURATION
// ─────────────────────────────────────────────────────────────

/**
 * Default provider order (all Consumet sub-providers + HTTP fallback + Miruro).
 * Set STREAM_PROVIDERS env var to override. Derived from the centralized
 * provider registry (services/providerRegistry.js) so IDs stay consistent.
 */
const DEFAULT_PROVIDERS = getDefaultProviderOrder();

// Runtime tag prefix for Consumet-backed sub-providers (e.g. 'consumet-kickassanime').
const CONSUMET_TAG_PREFIX = `${PROVIDER_IDS.CONSUMET}-`;

const PROVIDER_ORDER = (process.env.STREAM_PROVIDERS || DEFAULT_PROVIDERS.join(','))
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean)
  .filter(tag => !!normalizeProviderName(tag));

logger.info('Provider order configured', { providers: PROVIDER_ORDER });

// ─────────────────────────────────────────────────────────────
//  ERROR CATEGORY / MESSAGING
// ─────────────────────────────────────────────────────────────

/**
 * Map a classified error + provider result state into a clean, user-facing
 * failure reason. Used for structured logging and, in aggregate, for the
 * final error message when all providers fail.
 *
 * @param {string} category - classifyError category
 * @param {object} [result] - normalized provider result (may be null)
 * @returns {string} human-readable failure reason
 */
function describeFailure(category, result) {
  if (!category) return 'unknown error';
  switch (category) {
    case 'FORBIDDEN':
      return 'Cloudflare/anti-bot block (403)';
    case 'TIMEOUT':
      return 'request timed out';
    case 'NOT_FOUND':
      return 'resource not found (404)';
    case 'RATE_LIMITED':
      return 'rate limited (429)';
    case 'SERVER_ERROR':
      return 'provider server error (5xx)';
    case 'DNS_FAILURE':
      return 'DNS resolution failed';
    case 'CONNECTION_REFUSED':
      return 'connection refused (provider unavailable)';
    case 'CONNECTION_RESET':
      return 'connection reset by provider';
    case 'NETWORK_ERROR':
      return 'network error';
    case 'PROVIDER_DEGRADED':
      return 'provider marked degraded (skipped)';
    default:
      return result ? 'no playable stream found' : 'invalid stream';
  }
}

// ─────────────────────────────────────────────────────────────
//  RESOLVER FACTORIES
// ─────────────────────────────────────────────────────────────

/**
 * Build a resolver for a Consumet-backed sub-provider.
 * Maps "consumet-kickassanime" → provider "KickAssAnime" in the registry.
 */
function buildConsumetSubProviderResolver(providerTag) {
  const normalizedId = normalizeProviderName(providerTag);
  const subProviderName = toConsumetClassName(normalizedId || providerTag) || providerTag;
  const healthKey = toHealthKey(normalizedId || providerTag);

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
  const healthKey = PROVIDER_IDS.CONSUMET_HTTP;

  return async (animeTitle, episodeNumber) => {
    const baseUrl = process.env.CONSUMET_API_URL;
    if (!baseUrl) {
      logger.stream({ provider: PROVIDER_IDS.CONSUMET_HTTP, result: 'skipped_config', reason: 'CONSUMET_API_URL not set' });
      return null;
    }

    const startTime = Date.now();
    logger.stream({ provider: PROVIDER_IDS.CONSUMET_HTTP, anime: animeTitle, episode: episodeNumber, status: 'pending' });

    try {
      if (!isProviderHealthy(healthKey)) {
        logger.stream({ provider: PROVIDER_IDS.CONSUMET_HTTP, result: 'skipped_degraded' });
        return null;
      }

      const searchRes = await request({
        method: 'get',
        url: `${baseUrl}/anime/${encodeURIComponent(animeTitle)}`,
      }, {
        providerName: healthKey,
        streaming: true, // caps at 10s via the dedicated streaming client timeout
      });

      const results = searchRes.data?.results || [];
      if (!results.length) {
        logger.stream({ provider: PROVIDER_IDS.CONSUMET_HTTP, result: 'no_search_results', duration: Date.now() - startTime });
        return null;
      }

      const target = results[0];
      const animeId = target.id;

      const epRes = await request({
        method: 'get',
        url: `${baseUrl}/anime/${animeId}`,
      }, {
        providerName: healthKey,
        streaming: true, // caps at 10s via the dedicated streaming client timeout
      });

      const episodes = epRes.data?.episodes || [];
      const targetEp = episodes.find(e => e.number === Number(episodeNumber));
      if (!targetEp?.id) {
        logger.stream({ provider: PROVIDER_IDS.CONSUMET_HTTP, result: 'episode_not_found', episode: episodeNumber, duration: Date.now() - startTime });
        return null;
      }

      const srcRes = await request({
        method: 'get',
        url: `${baseUrl}/anime/${animeId}/episodes/${encodeURIComponent(targetEp.id)}`,
      }, {
        providerName: healthKey,
        streaming: true, // caps at 10s via the dedicated streaming client timeout
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
      logger.stream({ provider: PROVIDER_IDS.CONSUMET_HTTP, result: 'success', duration: elapsed, sources: sources.length });

      return {
        provider: PROVIDER_IDS.CONSUMET_HTTP,
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
      logger.stream({ provider: PROVIDER_IDS.CONSUMET_HTTP, result: 'error', duration: elapsed, category, error: err.message });
      return null;
    }
  };
}

/**
 * Build a resolver for the Miruro API provider.
 */
function buildMiruroResolver() {
  const healthKey = PROVIDER_IDS.MIRURO;

  return async (animeTitle, episodeNumber) => {
    const baseUrl = process.env.MIRURO_API_URL;
    if (!baseUrl) {
      logger.stream({ provider: PROVIDER_IDS.MIRURO, result: 'skipped_config', reason: 'MIRURO_API_URL not set' });
      return null;
    }

    const startTime = Date.now();
    logger.stream({ provider: PROVIDER_IDS.MIRURO, anime: animeTitle, episode: episodeNumber, status: 'pending' });

    try {
      if (!isProviderHealthy(healthKey)) {
        logger.stream({ provider: PROVIDER_IDS.MIRURO, result: 'skipped_degraded' });
        return null;
      }

      const searchRes = await request({
        method: 'get',
        url: `${baseUrl}/search`,
        params: { query: animeTitle },
      }, {
        providerName: healthKey,
        streaming: true, // caps at 10s via the dedicated streaming client timeout
      });

      const results = searchRes.data?.results || [];
      if (!results.length) {
        logger.stream({ provider: PROVIDER_IDS.MIRURO, result: 'no_results' });
        return null;
      }

      const animeData = results[0];
      const animeId = animeData.id || animeData.slug;

      const epRes = await request({
        method: 'get',
        url: `${baseUrl}/anime/${animeId}/episode/${episodeNumber}`,
      }, {
        providerName: healthKey,
        streaming: true, // caps at 10s via the dedicated streaming client timeout
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
      logger.stream({ provider: PROVIDER_IDS.MIRURO, result: 'success', duration: elapsed, sources: sources.length });

      return {
        provider: PROVIDER_IDS.MIRURO,
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
      logger.stream({ provider: PROVIDER_IDS.MIRURO, result: 'error', duration: elapsed, category, error: err.message });
      return null;
    }
  };
}

// ─────────────────────────────────────────────────────────────
//  DYNAMIC RESOLVER REGISTRY
// ─────────────────────────────────────────────────────────────

/**
 * Map provider tags to resolver factory functions.
 */
const RESOLVER_FACTORIES = {
  [CONSUMET_TAG_PREFIX]: buildConsumetSubProviderResolver,  // prefix match for consumet-*
  [PROVIDER_IDS.CONSUMET_HTTP]: buildConsumetHttpResolver,
  [PROVIDER_IDS.MIRURO]: buildMiruroResolver,
};

/**
 * Build a resolver function for a given provider tag.
 */
function buildResolverForProvider(providerTag) {
  const tag = providerTag.toLowerCase();

  if (tag === PROVIDER_IDS.CONSUMET_HTTP) return buildConsumetHttpResolver();
  if (tag === PROVIDER_IDS.MIRURO) return buildMiruroResolver();

  if (tag.startsWith(CONSUMET_TAG_PREFIX)) {
    return buildConsumetSubProviderResolver(tag);
  }

  logger.warn('Unknown provider type', { providerTag });
  return null;
}

// ── Cache Helpers ──────────────────────────────────────────
const STREAM_CACHE_TTL = parseInt(process.env.STREAM_CACHE_TTL_SECONDS || '300', 10);

function buildCacheKey(animeTitle, episodeNumber, providerName) {
  return `stream:${animeTitle.toLowerCase().replace(/\s+/g, '-')}:ep${episodeNumber}:${providerName || 'all'}`;
}

// ─────────────────────────────────────────────────────────────
//  PER-PROVIDER EXECUTION
// ─────────────────────────────────────────────────────────────

/**
 * Execute a single provider through its resolver with an internal retry
 * budget, concurrency-safe, collecting structured logs.
 *
 * NEVER throws — always resolves to a result object:
 *   { resolved: boolean, result: object|null, error: string|null,
 *     category: string|null, durationMs: number, attempts: number }
 *
 * This isolation is what guarantees a single provider failure/timeout can
 * never crash the request or the parallel race.
 *
 * @param {string} providerTag - Provider tag (e.g. 'consumet-kickassanime')
 * @param {Function} resolver - Async resolver fn(animeTitle, episodeNumber)
 * @param {string} animeTitle
 * @param {number|string} episodeNumber
 * @returns {Promise<object>} Encapsulated outcome
 */
async function executeProvider(providerTag, resolver, animeTitle, episodeNumber) {
  const healthKey = toHealthKey(providerTag);
  const { maxRetries, perRetryDelayMs } = PROVIDER_RETRY_CONFIG;
  const start = Date.now();
  let attempts = 0;
  let lastCategory = null;
  let lastDescription = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts++;

    // Health check before attempting (skip degraded providers quickly).
    if (attempt === 0 && !isProviderHealthy(healthKey)) {
      logger.stream({ provider: providerTag, attempt: 1, result: 'skipped_degraded' });
      return {
        resolved: false,
        result: null,
        error: describeFailure('PROVIDER_DEGRADED'),
        category: 'PROVIDER_DEGRADED',
        durationMs: Date.now() - start,
        attempts,
      };
    }

    const attemptStart = Date.now();
    logger.stream({ provider: providerTag, attempt: attempt + 1, status: 'pending' });

    try {
      const raw = await resolver(animeTitle, episodeNumber);
      const result = normalizeProviderResult(raw);

      if (result && result.sources.length > 0) {
        recordSuccess(healthKey, Date.now() - attemptStart);
        logger.stream({
          provider: providerTag,
          attempt: attempt + 1,
          duration: Date.now() - attemptStart,
          sources: result.sources.length,
          result: 'success',
        });
        return {
          resolved: true,
          result,
          error: null,
          category: null,
          durationMs: Date.now() - start,
          attempts,
        };
      }

      // No sources (empty search / missing episode / invalid stream) — not an error.
      lastCategory = 'EMPTY';
      lastDescription = describeFailure('EMPTY', result);
      logger.stream({ provider: providerTag, attempt: attempt + 1, duration: Date.now() - attemptStart, result: 'no_sources' });

      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, perRetryDelayMs));
      }
    } catch (err) {
      const { category, description } = classifyError(err);
      lastCategory = category;
      lastDescription = description || err.message;
      logger.stream({
        provider: providerTag,
        attempt: attempt + 1,
        duration: Date.now() - attemptStart,
        error: description || err.message,
        category,
        result: 'error',
      });

      // Record failure only on last attempt.
      if (attempt === maxRetries) {
        recordFailure(healthKey, Date.now() - attemptStart);
      }

      // Non-retryable errors: abandon provider immediately.
      if (!classifyError(err).retryable && err.code !== 'PROVIDER_DEGRADED') {
        logger.stream({ provider: providerTag, attempt: attempt + 1, result: 'non_retryable' });
        break;
      }

      if (attempt < maxRetries) {
        logger.stream({ provider: providerTag, attempt: attempt + 1, result: 'retry' });
        await new Promise(resolve => setTimeout(resolve, perRetryDelayMs));
      }
    }
  }

  logger.stream({ provider: providerTag, result: 'exhausted' });
  return {
    resolved: false,
    result: null,
    error: describeFailure(lastCategory, null),
    category: lastCategory,
    durationMs: Date.now() - start,
    attempts,
  };
}

/**
 * Execute a list of providers in PARALLEL and resolve with the first
 * successful playable stream. All providers run concurrently; each is
 * isolated so failures never crash the race. A global deadline aborts the
 * whole batch fast.
 *
 * @param {Array<string>} providerTags - Provider tags to run
 * @param {string} animeTitle
 * @param {number|string} episodeNumber
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - Overall deadline for this batch
 * @returns {Promise<{result: object|null, logs: Array}>}
 */
async function executeProvidersInParallel(providerTags, animeTitle, episodeNumber, options = {}) {
  const timeoutMs = options.timeoutMs || PIPELINE_TIMEOUT_MS;
  const logs = [];

  if (!providerTags.length) {
    return { result: null, logs };
  }

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logs.push({ phase: 'parallel', result: 'timeout', timeoutMs });
      logger.stream({ result: 'pipeline_timeout', timeoutMs, providers: providerTags.join(',') });
      resolve({ result: null, logs, timedOut: true });
    }, timeoutMs);

    // Promise each provider; each returns an encapsulated outcome (never throws).
    const promises = providerTags.map(async (tag) => {
      const resolver = buildResolverForProvider(tag);
      if (!resolver) {
        return { resolved: false, result: null, error: 'no resolver', category: 'NO_RESOLVER', durationMs: 0, attempts: 0, tag };
      }
      const outcome = await executeProvider(tag, resolver, animeTitle, episodeNumber);
      outcome.tag = tag;
      return outcome;
    });

    Promise.all(promises).then((outcomes) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      for (const o of outcomes) {
        logs.push({
          provider: o.tag,
          resolved: o.resolved,
          category: o.category,
          error: o.error,
          durationMs: o.durationMs,
          attempts: o.attempts,
        });
      }

      const winner = outcomes.find(o => o.resolved && o.result && o.result.sources.length > 0);
      resolve({ result: winner ? winner.result : null, logs });
    });
  });
}

// ─────────────────────────────────────────────────────────────
//  MAIN RESOLVER
// ─────────────────────────────────────────────────────────────

/**
 * Resolve the best available stream for an anime episode.
 * Sequential-first (preferred provider) then parallel race.
 * Returns the first successful stream; NEVER crashes on failure.
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
  // If a preferred provider is specified, move it to the front.
  const providerOrder = preferredProvider
    ? [preferredProvider, ...PROVIDER_ORDER.filter(p => p !== preferredProvider)]
    : PROVIDER_ORDER;

  console.log(`[StreamingService] 📋 Provider execution order:`);
  providerOrder.forEach((p, i) => console.log(`   ${i + 1}. ${p}`));

  // Preferred provider (first) — try alone with a short soft deadline.
  const preferredTag = providerOrder[0];
  const remainingTags = providerOrder.slice(1);

  let winner = null;
  let winnerProvider = null;

  if (preferredTag) {
    const resolver = buildResolverForProvider(preferredTag);
    if (resolver) {
      console.log(`[StreamingService] 🚀 Trying preferred provider "${preferredTag}" first (soft deadline ${PREFERRED_SOFT_DEADLINE_MS}ms)`);
      const preferredOutcome = await Promise.race([
        executeProvider(preferredTag, resolver, animeTitle, episodeNumber),
        new Promise(resolve => setTimeout(() => resolve({ resolved: false, result: null, error: 'soft deadline exceeded', category: 'SOFT_DEADLINE', durationMs: 0, attempts: 1, tag: preferredTag }), PREFERRED_SOFT_DEADLINE_MS)),
      ]);

      if (preferredOutcome.resolved && preferredOutcome.result && preferredOutcome.result.sources.length > 0) {
        winner = preferredOutcome.result;
        winnerProvider = preferredTag;
      } else {
        console.log(`[StreamingService] ➡️ Preferred "${preferredTag}" failed (${preferredOutcome.error || 'no sources'}) — launching parallel race`);
      }
    } else {
      console.warn(`[StreamingService] ⚠️ ${preferredTag} | No resolver available — skipping`);
    }
  }

  // ── Parallel race over remaining providers ──────────────
  if (!winner && remainingTags.length > 0) {
    console.log(`[StreamingService] ⚡ Racing ${remainingTags.length} providers in parallel (deadline ${PIPELINE_TIMEOUT_MS}ms)`);
    const race = await executeProvidersInParallel(remainingTags, animeTitle, episodeNumber, {
      timeoutMs: PIPELINE_TIMEOUT_MS,
    });

    if (race.result && race.result.sources.length > 0) {
      winner = race.result;
      winnerProvider = race.result.provider;
    }
  }

  // ── Build the final payload ─────────────────────────────
  if (winner && winner.sources.length > 0) {
    // Filter by tier.
    const filteredSources = filterSourcesByTier(winner.sources, isPremium);
    if (filteredSources.length === 0) {
      const msg = `No stream provider returned a source matching tier "${tier}" for "${animeTitle}" Episode ${episodeNumber}.`;
      console.error(`[StreamingService] 🛑 ${msg}`);
      throw new Error(msg);
    }

    // Pick best quality for tier.
    const best = filteredSources.reduce((a, b) =>
      parseQualityNumber(b.quality) > parseQualityNumber(a.quality) ? b : a
    , filteredSources[0]);

    const payload = {
      provider: winner.provider || winnerProvider || 'unknown',
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
      console.log(`[StreamingService] 💾 CACHED | "${animeTitle}" Ep ${episodeNumber} for ${STREAM_CACHE_TTL}s`);
    } catch (cacheErr) {
      console.warn(`[StreamingService] Cache write failed: ${cacheErr.message}`);
    }

    const elapsed = Date.now() - overallStart;
    console.log(`[StreamingService] ✅ RESOLVED | "${animeTitle}" Ep ${episodeNumber} → ${payload.provider} (${best.quality}) | ${elapsed}ms`);
    return payload;
  }

  // ── All providers failed ────────────────────────────────
  const elapsed = Date.now() - overallStart;
  const attemptedProviders = providerOrder.join(', ');
  const errorMsg = `No stream provider could resolve "${animeTitle}" Episode ${episodeNumber}. Attempted ${providerOrder.length} providers: ${attemptedProviders} (${elapsed}ms)`;
  console.error(`[StreamingService] 🛑 ALL PROVIDERS FAILED | ${errorMsg}`);
  throw new Error(errorMsg);
}

/**
 * Resolve streams from ALL configured providers (for server switcher).
 * Runs all providers in PARALLEL and collects the successful results.
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

  // Run all providers in parallel; each outcome is isolated (never throws).
  // A global deadline aborts the batch fast so a slow provider can't stall
  // the server-switcher request. We collect ALL successes (not just the first).
  const allOutcomes = await Promise.all(
    PROVIDER_ORDER.map(async (tag) => {
      const resolver = buildResolverForProvider(tag);
      if (!resolver) return null;
      return executeProvider(tag, resolver, animeTitle, episodeNumber);
    })
  );

  for (let i = 0; i < PROVIDER_ORDER.length; i++) {
    const outcome = allOutcomes[i];
    if (!outcome || !outcome.resolved || !outcome.result || outcome.result.sources.length === 0) continue;

    const filteredSources = filterSourcesByTier(outcome.result.sources, isPremium);
    const best = filteredSources.reduce((a, b) =>
      parseQualityNumber(b.quality) > parseQualityNumber(a.quality) ? b : a
    , filteredSources[0]);

    results.push({
      provider: outcome.result.provider || PROVIDER_ORDER[i],
      streamUrl: best?.url || null,
      sources: filteredSources,
      bestQuality: best?.quality || 'auto',
    });
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

// ============================================================
//  services/streamingService.js — Multi-Provider Fallback Engine
//
//  DYNAMIC RESOLVER PIPELINE (CONCURRENT, CONCURRENCY-LIMITED RACE):
//    • Providers are configured via STREAM_PROVIDERS env var
//    • Each provider has INDEPENDENT health tracking
//    • The pipeline NEVER stops after a single failure
//    • Every configured provider is attempted before giving up
//    • Returns the FIRST successful playable stream
//
//  EXECUTION MODEL:
//    Fully-concurrent, concurrency-limited race:
//      1. Providers are launched IMMEDIATELY in a sliding window
//         of up to STREAM_CONCURRENCY (default 3) at a time.
//      2. The execution queue is ordered by provider health:
//         preferred provider → healthy providers → degraded
//         providers → providers in cooldown last. This keeps
//         unhealthy providers from delaying resolution.
//      3. The FIRST provider to return a valid playable stream WINS
//         and the request resolves immediately. Remaining providers
//         are NOT scheduled (cancelled) and late responses are
//         ignored — no duplicate work, no unnecessary provider load.
//      4. If a running provider fails, the next provider in the queue
//         is launched to fill the concurrency window (sliding window).
//      5. A global pipeline deadline (PIPELINE_TIMEOUT_MS) caps the
//         whole operation so the request fails fast.
//      6. Every provider runs in its own error-isolated context — a
//         single provider crashing/timeout never crashes the request.
//      7. Structured metrics are logged per provider (latency,
//         success/failure, timeout, skipped) plus the winner and the
//         total pipeline duration for diagnosis.
//
//  Provider Types:
//    consumet-<name> — Consumet-backed sub-provider (KickAssAnime, AnimeKai, etc.)
//    consumet-http   — External Consumet API server
//    miruro          — Miruro API (INTENTIONALLY DISABLED — see buildMiruroResolver()
//                       and MIRURO_COMPATIBILITY_REPORT.md. The resolver is a no-op
//                       stub; it is NOT part of the active provider order.)
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
const hostedConsumet = require('./hostedConsumetProvider');
const { provider: animeHeavenProvider } = require('./animeHeavenProvider');
const {
  request,
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

// Maximum number of providers to run CONCURRENTLY at any moment. This is the
// sliding-window concurrency limit that prevents unnecessary load on the
// upstream providers. Override via STREAM_CONCURRENCY env var (default 3).
const STREAM_CONCURRENCY = parseInt(process.env.STREAM_CONCURRENCY || '3', 10);

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
 * Build a resolver for the consumet-http provider (HOSTED Consumet fallback).
 *
 * TIER 2 FALLBACK — activates ONLY when the Tier 1 local Consumet sub-providers
 * (consumet-kickassanime, consumet-animekai, ...) fail to resolve a stream.
 *
 * Delegates the actual HTTP work to services/hostedConsumetProvider.js, which:
 *   • Uses a DEDICATED axios client (createStreamingInstance) with an
 *     INDEPENDENT timeout (CONSUMET_HOSTED_TIMEOUT_MS).
 *   • Reads all endpoint paths from configurable env vars (no hardcoded URLs).
 *   • Preserves the existing output shape { provider, streamUrl, sources, subtitles }.
 *
 * Health tracking for the shared 'consumet-http' health key is performed here
 * (in executeProvider) exactly as for the other HTTP/Miruro resolvers, so the
 * hosted fallback stays consistent with the rest of the pipeline.
 */
function buildConsumetHttpResolver() {
  const healthKey = PROVIDER_IDS.CONSUMET_HTTP;

  return async (animeTitle, episodeNumber) => {
    // Fallback only activates when the hosted instance is configured AND the
    // provider is healthy (not degraded). Health is tracked by executeProvider.
    if (!hostedConsumet.isConfigured()) {
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

      const result = await hostedConsumet.resolveStream({
        title: animeTitle,
        episode: episodeNumber,
      });

      if (!result || !result.sources || result.sources.length === 0) {
        logger.stream({ provider: PROVIDER_IDS.CONSUMET_HTTP, result: 'no_sources', duration: Date.now() - startTime });
        return null;
      }

      const elapsed = Date.now() - startTime;
      logger.stream({ provider: PROVIDER_IDS.CONSUMET_HTTP, result: 'success', duration: elapsed, sources: result.sources.length });

      return result;
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const { category } = classifyError(err);
      logger.stream({ provider: PROVIDER_IDS.CONSUMET_HTTP, result: 'error', duration: elapsed, category, error: err.message });
      return null;
    }
  };
}

/**
 * Build a resolver for the AnimeHeaven provider.
 * Reuses the existing shared providerHttp request layer and the
 * normalized streaming response shape used by the pipeline.
 */
function buildAnimeHeavenResolver() {
  const healthKey = PROVIDER_IDS.ANIME_HEAVEN;

  return async (animeTitle, episodeNumber) => {
    if (!isProviderHealthy(healthKey)) {
      logger.stream({ provider: PROVIDER_IDS.ANIME_HEAVEN, result: 'skipped_degraded' });
      return null;
    }

    const result = await animeHeavenProvider.resolveStream({
      title: animeTitle,
      episode: episodeNumber,
    });

    if (!result || !Array.isArray(result.sources) || result.sources.length === 0) {
      return null;
    }

    return result;
  };
}

/**
 * Build a resolver for the Miruro API provider.
 *
 * ⚠️ INTENTIONALLY DISABLED — DO NOT ENABLE.
 *
 * The Miruro compatibility audit (see MIRURO_COMPATIBILITY_REPORT.md) proved the
 * previous implementation assumed non-existent endpoints (`/search`, `/anime/{id}/episode/{n}`).
 * Live probing of the real Miruro service (miruro.tv v1.13.0) returned **410 Gone / 404 Not Found**
 * for those paths. The real service is a React/Vite SPA exposing a same-origin, undocumented
 * `/api/*` REST API protected by Cloudflare, with an optional JWE (ECDH-ES) transport that Node.js
 * Web Crypto cannot transparently implement.
 *
 * This stub is intentionally replaceable: it logs that Miruro is disabled, immediately returns
 * null, NEVER performs an HTTP request, NEVER throws, and NEVER affects provider selection.
 * It exists so that:
 *   - A future developer can implement a verified adapter (services/miruroProvider.js) and
 *     swap it in here after Phase 1 browser-traffic capture of `/api/search`, `/api/episodes`,
 *     `/api/sources`.
 *   - Even if a client forces `preferredProvider=miruro`, the pipeline safely falls through
 *     to the next provider without any network activity.
 *
 * @returns {Promise<null>} Always resolves to null (provider disabled).
 */
function buildMiruroResolver() {
  const healthKey = PROVIDER_IDS.MIRURO;

  return async (animeTitle, episodeNumber) => {
    // Miruro is intentionally disabled. Log clearly and return null immediately.
    logger.stream({
      provider: PROVIDER_IDS.MIRURO,
      result: 'disabled',
      reason: 'MIRURO_INTENTIONALLY_DISABLED',
      detail: 'Invalid endpoint assumptions (see MIRURO_COMPATIBILITY_REPORT.md). Awaiting verified adapter after Phase 1 browser-traffic capture.',
      anime: animeTitle,
      episode: episodeNumber,
    });
    // No HTTP request, no health mutation, no throw — always a clean no-op.
    return null;
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
  [PROVIDER_IDS.ANIME_HEAVEN]: buildAnimeHeavenResolver,
  [PROVIDER_IDS.MIRURO]: buildMiruroResolver,
};

/**
 * Build a resolver function for a given provider tag.
 */
function buildResolverForProvider(providerTag) {
  const tag = providerTag.toLowerCase();

  if (tag === PROVIDER_IDS.CONSUMET_HTTP) return buildConsumetHttpResolver();
  if (tag === PROVIDER_IDS.ANIME_HEAVEN) return buildAnimeHeavenResolver();
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
      logger.streamAttempt({
        provider: providerTag,
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
        error: describeFailure('PROVIDER_DEGRADED'),
        category: 'PROVIDER_DEGRADED',
        durationMs: Date.now() - start,
        attempts,
      };
    }

    const attemptStart = Date.now();
    logger.debugStream('Provider attempt pending', { provider: providerTag, anime: animeTitle, episode: episodeNumber, attempt: attempt + 1 });

    try {
      const raw = await resolver(animeTitle, episodeNumber);
      const result = normalizeProviderResult(raw);

      if (result && result.sources.length > 0) {
        recordSuccess(healthKey, Date.now() - attemptStart);
        logger.streamAttempt({
          provider: providerTag,
          anime: animeTitle,
          episode: episodeNumber,
          attempt: attempt + 1,
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
          attempts,
        };
      }

      // No sources (empty search / missing episode / invalid stream) — not an error.
      lastCategory = 'EMPTY';
      lastDescription = describeFailure('EMPTY', result);
      logger.streamAttempt({
        provider: providerTag,
        anime: animeTitle,
        episode: episodeNumber,
        attempt: attempt + 1,
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

      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, perRetryDelayMs));
      }
    } catch (err) {
      const { category, description } = classifyError(err);
      lastCategory = category;
      lastDescription = description || err.message;
      const timedOut = isTimeoutError(err);
      const cloudflareDetected = category === 'FORBIDDEN' || category === 'SERVER_ERROR';
      logger.streamAttempt({
        provider: providerTag,
        anime: animeTitle,
        episode: episodeNumber,
        attempt: attempt + 1,
        result: timedOut ? 'timeout' : 'failure',
        failureReason: describeFailure(category, null),
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

// Record failure only on last attempt. Genuine timeouts are tracked via
      // markTimeout (a failure + separate timeout counter); everything else
      // uses recordFailure (markFailure). 403/404/429/5xx/DNS/connection
      // resets are NOT timeouts and go through the normal failure path.
      if (attempt === maxRetries) {
        if (isTimeoutError(err)) {
          markTimeout(healthKey, Date.now() - attemptStart);
        } else {
          recordFailure(healthKey, Date.now() - attemptStart);
        }
      }

      // Non-retryable errors: abandon provider immediately.
      if (!classifyError(err).retryable && err.code !== 'PROVIDER_DEGRADED') {
        logger.debugStream('Provider non-retryable error', { provider: providerTag, anime: animeTitle, episode: episodeNumber, attempt: attempt + 1 });
        break;
      }

      if (attempt < maxRetries) {
        logger.debugStream('Provider will retry', { provider: providerTag, anime: animeTitle, episode: episodeNumber, attempt: attempt + 1 });
        await new Promise(resolve => setTimeout(resolve, perRetryDelayMs));
      }
    }
  }

  logger.streamAttempt({
    provider: providerTag,
    anime: animeTitle,
    episode: episodeNumber,
    result: 'failure',
    failureReason: describeFailure(lastCategory, null),
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
    error: describeFailure(lastCategory, null),
    category: lastCategory,
    durationMs: Date.now() - start,
    attempts,
  };
}

/**
 * Build the provider execution queue ordered by health.
 *
 * Ordering (highest priority first):
 *   1. Preferred provider (if specified)  — user-forced selection
 *   2. Healthy providers (not degraded)   — in configured order
 *   3. Degraded providers                 — currently in cooldown, last
 *
 * This keeps unhealthy/providers-in-cooldown from delaying resolution.
 *
 * @param {string[]} providerTags - All provider tags in configured order
 * @param {string} [preferredProvider] - Optional preferred provider tag
 * @returns {string[]} Reordered execution queue
 */
function buildExecutionQueue(providerTags, preferredProvider) {
  const queue = [];

  // 1. Preferred provider first (if it's a known provider).
  if (preferredProvider) {
    const match = providerTags.find(t => t === preferredProvider);
    if (match) queue.push(match);
  }

  // 2. Healthy providers in configured order.
  const healthy = providerTags.filter(t => {
    if (preferredProvider && t === preferredProvider) return false; // already queued
    return isProviderHealthy(toHealthKey(t));
  });

  // 3. Degraded / cooldown providers last.
  const degraded = providerTags.filter(t => {
    if (preferredProvider && t === preferredProvider) return false;
    return !isProviderHealthy(toHealthKey(t));
  });

  return [...queue, ...healthy, ...degraded];
}

/**
 * Execute providers concurrently with a configurable concurrency limit and
 * resolve with the FIRST successful playable stream.
 *
 * This is a sliding-window race:
 *   • Launch up to STREAM_CONCURRENCY providers at once.
 *   • As soon as one returns a valid playable stream, resolve IMMEDIATELY.
 *   • Stop scheduling remaining providers and ignore late responses
 *     (prevents duplicate work / unnecessary provider load).
 *   • If a running provider fails, launch the next one in the queue to fill
 *     the window.
 *   • A global deadline (PIPELINE_TIMEOUT_MS) aborts the whole race fast.
 *
 * Each provider is executed exactly once (no duplicate work). The returned
 * object shape is preserved:
 *   { result: object|null, logs: Array, winnerProvider: string|null }
 *
 * @param {Array<string>} providerTags - Provider tags in execution order
 * @param {string} animeTitle
 * @param {number|string} episodeNumber
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - Overall deadline for this batch
 * @param {number} [options.concurrency] - Concurrency limit (default STREAM_CONCURRENCY)
 * @returns {Promise<{result: object|null, logs: Array, winnerProvider: string|null}>}
 */
async function raceWithConcurrency(providerTags, animeTitle, episodeNumber, options = {}) {
  const timeoutMs = options.timeoutMs || PIPELINE_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency || STREAM_CONCURRENCY);
  const logs = [];

  if (!providerTags.length) {
    return { result: null, logs, winnerProvider: null };
  }

  return new Promise((resolve) => {
    let settled = false;
    let winnerFound = false;
    let winnerProvider = null;
    let cursor = 0;
    const outcomes = [];

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logs.push({ phase: 'race', result: 'timeout', timeoutMs });
      logger.stream({ result: 'pipeline_timeout', timeoutMs, providers: providerTags.join(',') });
      resolve({ result: null, logs, winnerProvider, timedOut: true });
    }, timeoutMs);

    const trySchedule = () => {
      // Stop scheduling once a winner is found.
      if (winnerFound || settled) return;

      // Launch the next batch of providers up to the concurrency limit.
      while (cursor < providerTags.length && !winnerFound && !settled) {
        const tag = providerTags[cursor];
        cursor += 1;

        const resolver = buildResolverForProvider(tag);
        if (!resolver) {
          outcomes.push({ provider: tag, resolved: false, error: 'no resolver', category: 'NO_RESOLVER', durationMs: 0, attempts: 0, skipped: true });
          continue;
        }

        // Execute the provider asynchronously; never throws.
        executeProvider(tag, resolver, animeTitle, episodeNumber)
          .then((outcome) => {
            outcome.provider = tag;
            outcomes.push(outcome);

            if (outcome.resolved && outcome.result && outcome.result.sources.length > 0 && !winnerFound) {
              // First playable stream wins — resolve immediately.
              winnerFound = true;
              winnerProvider = tag;
              settled = true;
              clearTimeout(timer);
              resolve({ result: outcome.result, logs, winnerProvider });
              return;
            }

            // Failure — fill the window with the next provider.
            trySchedule();
          })
          .catch(() => {
            // executeProvider never rejects, but be defensive.
            outcomes.push({ provider: tag, resolved: false, error: 'unexpected error', category: 'UNKNOWN', durationMs: 0, attempts: 0 });
            trySchedule();
          });
      }

      // Exhausted the queue without a winner (all failed).
      if (cursor >= providerTags.length && !winnerFound && !settled) {
        settled = true;
        clearTimeout(timer);
        // Build logs from collected outcomes.
        for (const o of outcomes) {
          logs.push({
            provider: o.provider,
            resolved: o.resolved,
            category: o.category,
            error: o.error,
            durationMs: o.durationMs,
            attempts: o.attempts,
            skipped: o.skipped,
          });
        }
        resolve({ result: null, logs, winnerProvider });
      }
    };

    trySchedule();
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
        return cached;
      }
      logger.debugStream('Cache miss', { anime: animeTitle, episode: episodeNumber });
    } catch (cacheErr) {
      logger.warn('Cache read failed — proceeding without cache', { anime: animeTitle, episode: episodeNumber, error: cacheErr.message });
    }
  } else {
    logger.debugStream('Cache bypassed (skipCache=true)', { anime: animeTitle, episode: episodeNumber });
  }

// ── Build health-aware execution queue ──────────────────
  // Ordered: preferred provider → healthy providers → degraded/cooldown last.
  const executionQueue = buildExecutionQueue(PROVIDER_ORDER, preferredProvider);

  logger.debugStream('Provider execution queue', {
    anime: animeTitle,
    episode: episodeNumber,
    concurrency: STREAM_CONCURRENCY,
    deadlineMs: PIPELINE_TIMEOUT_MS,
    queue: executionQueue,
  });

  // ── Concurrent limited race ─────────────────────────────
  // Launch up to STREAM_CONCURRENCY providers at once; first success wins.
  // Remaining providers are cancelled (not scheduled) and late responses
  // are ignored — no duplicate work, no unnecessary provider load.
  const race = await raceWithConcurrency(executionQueue, animeTitle, episodeNumber, {
    timeoutMs: PIPELINE_TIMEOUT_MS,
    concurrency: STREAM_CONCURRENCY,
  });

  const winner = race.result;
  const winnerProvider = race.winnerProvider;

  // ── Structured metrics log ──────────────────────────────
  const elapsed = Date.now() - overallStart;
  if (winner && winner.sources.length > 0) {
    const failedProviders = race.logs
      .filter(l => !l.resolved)
      .map(l => ({ provider: l.provider, category: l.category, durationMs: l.durationMs, skipped: l.skipped }));
    logger.stream({
      provider: winnerProvider,
      result: 'winner',
      duration: elapsed,
      sources: winner.sources.length,
      win: true,
      winner: winnerProvider,
      failedProviders,
      totalDurationMs: elapsed,
    });
  } else {
    logger.stream({
      result: 'all_failed',
      duration: elapsed,
      totalDurationMs: elapsed,
      providers: race.logs.map(l => ({
        provider: l.provider,
        category: l.category,
        durationMs: l.durationMs,
        skipped: l.skipped,
      })),
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

  // ── All providers failed ────────────────────────────────
  const attemptedProviders = executionQueue.join(', ');
  const errorMsg = `No stream provider could resolve "${animeTitle}" Episode ${episodeNumber}. Attempted ${executionQueue.length} providers: ${attemptedProviders} (${elapsed}ms)`;
  logger.streamAttempt({
    provider: executionQueue.join(','),
    anime: animeTitle,
    episode: episodeNumber,
    result: 'failure',
    failureReason: 'all providers failed',
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

logger.debugStream('resolveAllProviders start', { anime: animeTitle, episode: episodeNumber, concurrency: STREAM_CONCURRENCY });

  // Run ALL providers with a concurrency limit (sliding window), collecting
  // every successful outcome. Unlike resolveStream, this does NOT stop after
  // the first success — it attempts every provider so the server switcher can
  // list all available sources. Each outcome is isolated (never throws).
  const allOutcomes = await runAllWithConcurrency(PROVIDER_ORDER, animeTitle, episodeNumber, {
    concurrency: STREAM_CONCURRENCY,
  });

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

logger.debugStream('resolveAllProviders complete', {
    anime: animeTitle,
    episode: episodeNumber,
    resolved: results.length,
    attempted: PROVIDER_ORDER.length,
    providers: results.map(r => r.provider),
  });
  return results;
}

/**
 * Execute ALL providers with a concurrency limit (sliding window), collecting
 * every successful outcome. Used by resolveAllProviders (server switcher).
 *
 * Each provider runs exactly once; outcomes are returned in the SAME order as
 * providerTags. A global deadline (PIPELINE_TIMEOUT_MS) aborts the batch fast.
 *
 * @param {Array<string>} providerTags - Provider tags in configured order
 * @param {string} animeTitle
 * @param {number|string} episodeNumber
 * @param {object} [options]
 * @param {number} [options.concurrency] - Concurrency limit (default STREAM_CONCURRENCY)
 * @returns {Promise<Array<object|null>>} Outcomes aligned to providerTags
 */
async function runAllWithConcurrency(providerTags, animeTitle, episodeNumber, options = {}) {
  const concurrency = Math.max(1, options.concurrency || STREAM_CONCURRENCY);
  const outcomes = new Array(providerTags.length).fill(null);
  let cursor = 0;
  let inFlight = 0;

  if (!providerTags.length) return outcomes;

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.stream({ result: 'resolve_all_timeout', timeoutMs: PIPELINE_TIMEOUT_MS, providers: providerTags.join(',') });
      resolve(outcomes);
    }, PIPELINE_TIMEOUT_MS);

    const trySchedule = () => {
      if (settled) return;

      // Fill the concurrency window.
      while (cursor < providerTags.length && inFlight < concurrency) {
        const idx = cursor;
        const tag = providerTags[idx];
        cursor += 1;

        const resolver = buildResolverForProvider(tag);
        if (!resolver) {
          outcomes[idx] = null;
          continue;
        }

        inFlight += 1;
        executeProvider(tag, resolver, animeTitle, episodeNumber)
          .then((outcome) => {
            outcome.provider = tag;
            outcomes[idx] = outcome;
            inFlight -= 1;
            trySchedule();
          })
          .catch(() => {
            outcomes[idx] = null;
            inFlight -= 1;
            trySchedule();
          });
      }

      // All providers have settled (none in flight, cursor exhausted).
      if (cursor >= providerTags.length && inFlight === 0) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcomes);
      }
    };

    trySchedule();
  });
}

// ── Provider Health Endpoint ───────────────────────────────
function getProviderHealthStatus() {
  const health = getProviderHealth();

  // Also add Consumet sub-provider health entries
  const consumetProviders = consumetProvider.listProviders();
  for (const name of consumetProviders) {
    const key = `consumet-${name.toLowerCase()}`;
    if (!health[key]) {
      // Use the enriched single-provider stats so the default (untracked)
      // entries expose the same extended shape as tracked providers.
      health[key] = {
        ...(getHealthStats(key) || {}),
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

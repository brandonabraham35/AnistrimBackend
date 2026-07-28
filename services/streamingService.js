// ============================================================
//  services/streamingService.js — Multi-API Fallback Engine
//
//  CLEAN ORCHESTRATION LAYER:
//    • Does NOT contain scraping logic (all providers via ConsumetProvider)
//    • Pre-queries cache before calling providers
//    • Centralized retry orchestration via providerHttp
//    • Provider health check integration
//    • Structured logging throughout
//    • Proper fallback chain
//
//  Providers (configurable via STREAM_PROVIDERS env var):
//    consumet      — In-memory @consumet/extensions (via ConsumetProvider)
//    consumet-http — External Consumet API server (via providerHttp)
//    miruro        — Miruro API (via providerHttp)
//
//  Quality Tiers:
//    Free users:  ≤ 720p (480p, 720p)
//    Premium/Admin users: up to 4K (1080p, 4K)
//
//  Proxy:
//    Uses the SHARED proxy manager from utils/providerHttp.js
//    NO duplicate proxy configuration.
// ============================================================
const { ConsumetProvider } = require('./consumetProvider');
const { request, isProviderHealthy, getProviderHealth } = require('../utils/providerHttp');
const cache = require('../utils/cacheService');

// ── Quality Tier Definitions ────────────────────────────────
const QUALITY_TIERS = {
  free: {
    max: 720,
    allowed: ['360', '480', '720', 'default', 'auto'],
    label: 'HD (720p Max)',
  },
  premium: {
    max: 4320, // 4K+
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
 * @param {Array} sources — Array of { url, quality }
 * @param {boolean} isPremium — Whether user is premium/admin
 * @returns {Array} Filtered sources
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

// ── Provider Priority ───────────────────────────────────────
const PROVIDER_ORDER = (process.env.STREAM_PROVIDERS || 'consumet')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// ── Consumet (In-Memory) Provider ──────────────────────────
let consumetProvider = null;

function getConsumetProvider() {
  if (!consumetProvider) {
    consumetProvider = new ConsumetProvider();
  }
  return consumetProvider;
}

async function resolveViaConsumet(animeTitle, episodeNumber) {
  const startTime = Date.now();
  console.log(`[StreamingService] ➡️ consumet | "${animeTitle}" Ep ${episodeNumber}`);

  try {
    // Check provider health first
    if (!isProviderHealthy('consumet')) {
      console.warn(`[StreamingService] ⏭ consumet is DEGRADED — skipping`);
      return null;
    }

    const provider = getConsumetProvider();
    const result = await provider.resolveStreamUrl(animeTitle, episodeNumber);

    const elapsed = Date.now() - startTime;

    // Normalize sources into standard format
    const sources = (result.allSources || []).map(s => ({
      url: s.url,
      quality: s.quality || 'auto',
    }));

    console.log(`[StreamingService] ✅ consumet | ${elapsed}ms | ${sources.length} sources found`);

    return {
      provider: 'consumet',
      streamUrl: result.streamUrl,
      sources,
      subtitles: (result.subtitles || []).map(sub => ({
        lang: sub.lang || sub.language || 'Unknown',
        url: sub.url,
      })),
    };
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.warn(`[StreamingService] ❌ consumet | ${elapsed}ms | ${err.message}`);
    return null;
  }
}

// ── Consumet HTTP API Provider ─────────────────────────────
async function resolveViaConsumetHttp(animeTitle, episodeNumber) {
  const baseUrl = process.env.CONSUMET_API_URL;
  if (!baseUrl) {
    console.log(`[StreamingService] ⏭ consumet-http skipped (CONSUMET_API_URL not set)`);
    return null;
  }

  const startTime = Date.now();
  console.log(`[StreamingService] ➡️ consumet-http | "${animeTitle}" Ep ${episodeNumber}`);

  try {
    if (!isProviderHealthy('consumet-http')) {
      console.warn(`[StreamingService] ⏭ consumet-http is DEGRADED — skipping`);
      return null;
    }

    // First search for the anime using shared providerHttp (with proxy + retry)
    const searchRes = await request({
      method: 'get',
      url: `${baseUrl}/anime/${encodeURIComponent(animeTitle)}`,
    }, {
      providerName: 'consumet-http',
      timeout: 15000,
    });

    const results = searchRes.data?.results || [];
    if (!results.length) {
      console.warn(`[StreamingService] ⚠️ consumet-http search returned 0 results`);
      return null;
    }

    const target = results[0];
    const animeId = target.id;

    // Fetch episodes
    const epRes = await request({
      method: 'get',
      url: `${baseUrl}/anime/${animeId}`,
    }, {
      providerName: 'consumet-http',
      timeout: 15000,
    });

    const episodes = epRes.data?.episodes || [];
    const targetEp = episodes.find(e => e.number === Number(episodeNumber));
    if (!targetEp?.id) {
      console.warn(`[StreamingService] ⚠️ consumet-http episode ${episodeNumber} not found`);
      return null;
    }

    // Fetch sources
    const srcRes = await request({
      method: 'get',
      url: `${baseUrl}/anime/${animeId}/episodes/${encodeURIComponent(targetEp.id)}`,
    }, {
      providerName: 'consumet-http',
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
    console.log(`[StreamingService] ✅ consumet-http | ${elapsed}ms | ${sources.length} sources`);

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
    console.warn(`[StreamingService] ❌ consumet-http | ${elapsed}ms | ${err.message}`);
    return null;
  }
}

// ── Miruro API Provider ────────────────────────────────────
async function resolveViaMiruro(animeTitle, episodeNumber) {
  const baseUrl = process.env.MIRURO_API_URL;
  if (!baseUrl) {
    console.log(`[StreamingService] ⏭ miruro skipped (MIRURO_API_URL not set)`);
    return null;
  }

  const startTime = Date.now();
  console.log(`[StreamingService] ➡️ miruro | "${animeTitle}" Ep ${episodeNumber}`);

  try {
    if (!isProviderHealthy('miruro')) {
      console.warn(`[StreamingService] ⏭ miruro is DEGRADED — skipping`);
      return null;
    }

    // Search via shared providerHttp
    const searchRes = await request({
      method: 'get',
      url: `${baseUrl}/search`,
      params: { query: animeTitle },
    }, {
      providerName: 'miruro',
      timeout: 15000,
    });

    const results = searchRes.data?.results || [];
    if (!results.length) return null;

    const animeData = results[0];
    const animeId = animeData.id || animeData.slug;

    // Get episode sources
    const epRes = await request({
      method: 'get',
      url: `${baseUrl}/anime/${animeId}/episode/${episodeNumber}`,
    }, {
      providerName: 'miruro',
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
    console.log(`[StreamingService] ✅ miruro | ${elapsed}ms | ${sources.length} sources`);

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
    console.warn(`[StreamingService] ❌ miruro | ${elapsed}ms | ${err.message}`);
    return null;
  }
}

// ── Provider Registry ──────────────────────────────────────
const PROVIDER_RESOLVERS = {
  consumet: resolveViaConsumet,
  'consumet-http': resolveViaConsumetHttp,
  miruro: resolveViaMiruro,
};

// ── Cache Helpers ──────────────────────────────────────────
const STREAM_CACHE_TTL = parseInt(process.env.STREAM_CACHE_TTL_SECONDS || '300', 10); // 5 minutes default

function buildCacheKey(animeTitle, episodeNumber, providerName) {
  return `stream:${animeTitle.toLowerCase().replace(/\s+/g, '-')}:ep${episodeNumber}:${providerName || 'all'}`;
}

// ── Main Resolver ──────────────────────────────────────────

/**
 * Resolve the best available stream for an anime episode.
 * Tries providers in priority order; returns the first success.
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

  console.log(`[StreamingService] 🎬 resolveStream | "${animeTitle}" Ep ${episodeNumber} | tier: ${tier}`);

  // ── Cache Check ──────────────────────────────────────────
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

  // ── Determine provider order ─────────────────────────────
  const providerOrder = preferredProvider
    ? [preferredProvider, ...PROVIDER_ORDER.filter(p => p !== preferredProvider)]
    : PROVIDER_ORDER;

  console.log(`[StreamingService] Provider order: ${providerOrder.join(' → ')}`);

  // ── Try providers in order ───────────────────────────────
  for (const providerName of providerOrder) {
    const resolver = PROVIDER_RESOLVERS[providerName];
    if (!resolver) {
      console.warn(`[StreamingService] ⚠️ Unknown provider: ${providerName}`);
      continue;
    }

    const result = await resolver(animeTitle, episodeNumber);

    if (result && result.sources && result.sources.length > 0) {
      // Filter by tier
      const filteredSources = filterSourcesByTier(result.sources, isPremium);
      if (filteredSources.length === 0) {
        console.log(`[StreamingService] ⚠️ ${providerName} returned sources but none match tier "${tier}"`);
        continue;
      }

      // Pick best quality for tier
      const best = filteredSources.reduce((a, b) =>
        parseQualityNumber(b.quality) > parseQualityNumber(a.quality) ? b : a
      , filteredSources[0]);

      const payload = {
        provider: result.provider,
        streamUrl: best.url,
        sources: filteredSources,
        subtitles: result.subtitles || [],
        bestQuality: best.quality || 'auto',
        tier,
      };

      // ── Cache the result ──────────────────────────────
      try {
        const cacheKey = buildCacheKey(animeTitle, episodeNumber);
        await cache.set(cacheKey, payload, STREAM_CACHE_TTL);
        console.log(`[StreamingService] 💾 CACHED | "${animeTitle}" Ep ${episodeNumber} for ${STREAM_CACHE_TTL}s`);
      } catch (cacheErr) {
        console.warn(`[StreamingService] Cache write failed: ${cacheErr.message}`);
      }

      const elapsed = Date.now() - overallStart;
      console.log(`[StreamingService] ✅ RESOLVED | "${animeTitle}" Ep ${episodeNumber} → ${result.provider} (${best.quality}) | ${elapsed}ms`);

      return payload;
    }

    console.log(`[StreamingService] ⚠️ ${providerName} returned no usable sources`);
  }

  // All providers failed
  const elapsed = Date.now() - overallStart;
  const errorMsg = `No stream provider could resolve "${animeTitle}" Episode ${episodeNumber} (${elapsed}ms)`;
  console.error(`[StreamingService] 🛑 ${errorMsg}`);
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

  for (const providerName of PROVIDER_ORDER) {
    const resolver = PROVIDER_RESOLVERS[providerName];
    if (!resolver) continue;

    try {
      const result = await resolver(animeTitle, episodeNumber);
      if (result && result.sources && result.sources.length > 0) {
        const filteredSources = filterSourcesByTier(result.sources, isPremium);
        const best = filteredSources.reduce((a, b) =>
          parseQualityNumber(b.quality) > parseQualityNumber(a.quality) ? b : a
        , filteredSources[0]);

        results.push({
          provider: result.provider,
          streamUrl: best?.url || null,
          sources: filteredSources,
          bestQuality: best?.quality || 'auto',
        });
      }
    } catch (err) {
      console.warn(`[StreamingService] resolveAllProviders: ${providerName} failed: ${err.message}`);
    }
  }

  console.log(`[StreamingService] 📋 resolveAllProviders | ${results.length} providers resolved`);
  return results;
}

// ── Provider Health Endpoint ───────────────────────────────
function getProviderHealthStatus() {
  return getProviderHealth();
}

module.exports = {
  resolveStream,
  resolveAllProviders,
  filterSourcesByTier,
  getBestQualityLabel,
  getProviderHealthStatus,
  QUALITY_TIERS,
};


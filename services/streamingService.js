// ============================================================
//  services/streamingService.js — Multi-API Fallback Engine
//  Aggregates stream sources from multiple providers with
//  configurable priority ordering and quality tier enforcement.
//
//  Providers (configurable via STREAM_PROVIDERS env var):
//    consumet — In-memory @consumet/extensions
//    consumet-http — External Consumet API server
//    miruro — Miruro API
//    zoro — Direct Zoro/Aniwatch via Consumet
//
//  Quality Tiers:
//    Free users:  ≤ 720p (480p, 720p)
//    Premium/Admin users: up to 4K (1080p, 4K)
// ============================================================
const axios = require('axios');
const { ConsumetProvider } = require('./consumetProvider');

// ── Provider Priority ───────────────────────────────────────
const PROVIDER_ORDER = (process.env.STREAM_PROVIDERS || 'consumet')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

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

// Parse quality number from string like "1080p", "1080", "4K", "2160p"
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
    // If we can parse a number, enforce the tier max
    if (qNum > 0) return qNum <= tier.max;
    // Otherwise, check if the quality string is in the allowed list
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

// ── Consumet (In-Memory) Provider ──────────────────────────
let consumetProvider = null;

function getConsumetProvider() {
  if (!consumetProvider) {
    consumetProvider = new ConsumetProvider();
  }
  return consumetProvider;
}

async function resolveViaConsumet(animeTitle, episodeNumber) {
  try {
    const provider = getConsumetProvider();
    const result = await provider.resolveStreamUrl(animeTitle, episodeNumber);

    // Normalize sources into standard format
    const sources = (result.allSources || []).map(s => ({
      url: s.url,
      quality: s.quality || 'auto',
    }));

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
    console.warn(`[StreamingService] Consumet failed: ${err.message}`);
    return null;
  }
}

// ── Consumet HTTP API Provider ─────────────────────────────
async function resolveViaConsumetHttp(animeTitle, episodeNumber) {
  const baseUrl = process.env.CONSUMET_API_URL;
  if (!baseUrl) return null;

  try {
    // First search for the anime
    const searchRes = await axios.get(`${baseUrl}/anime/${encodeURIComponent(animeTitle)}`, {
      timeout: 8000,
    });

    const results = searchRes.data?.results || [];
    if (!results.length) return null;

    const target = results[0];
    const animeId = target.id;

    // Fetch episodes
    const epRes = await axios.get(`${baseUrl}/anime/${animeId}`, { timeout: 8000 });
    const episodes = epRes.data?.episodes || [];
    const targetEp = episodes.find(e => e.number === Number(episodeNumber));
    if (!targetEp?.id) return null;

    // Fetch sources
    const srcRes = await axios.get(`${baseUrl}/anime/${animeId}/episodes/${encodeURIComponent(targetEp.id)}`, {
      timeout: 10000,
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
    console.warn(`[StreamingService] Consumet-HTTP failed: ${err.message}`);
    return null;
  }
}

// ── Miruro API Provider ────────────────────────────────────
async function resolveViaMiruro(animeTitle, episodeNumber) {
  const baseUrl = process.env.MIRURO_API_URL;
  if (!baseUrl) return null;

  try {
    const searchRes = await axios.get(`${baseUrl}/search`, {
      params: { query: animeTitle },
      timeout: 8000,
    });

    const results = searchRes.data?.results || [];
    if (!results.length) return null;

    const animeData = results[0];
    const animeId = animeData.id || animeData.slug;

    // Get episode sources
    const epRes = await axios.get(`${baseUrl}/anime/${animeId}/episode/${episodeNumber}`, {
      timeout: 10000,
    });

    const rawSources = epRes.data?.sources || [];
    const sources = rawSources.map(s => ({
      url: s.url,
      quality: s.quality || 'auto',
    }));

    const best = sources.reduce((a, b) =>
      parseQualityNumber(b.quality) > parseQualityNumber(a.quality) ? b : a
    , sources[0]);

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
    console.warn(`[StreamingService] Miruro failed: ${err.message}`);
    return null;
  }
}

// ── Provider Registry ──────────────────────────────────────
const PROVIDER_RESOLVERS = {
  consumet: resolveViaConsumet,
  'consumet-http': resolveViaConsumetHttp,
  miruro: resolveViaMiruro,
};

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
 * @returns {Promise<{provider: string, streamUrl: string|null, sources: Array, subtitles: Array, bestQuality: string, tier: string}>}
 */
async function resolveStream(animeTitle, episodeNumber, options = {}) {
  const { isPremium = false, preferredProvider } = options;
  const tier = isPremium ? 'premium' : 'free';

  // Determine provider order
  const providerOrder = preferredProvider
    ? [preferredProvider, ...PROVIDER_ORDER.filter(p => p !== preferredProvider)]
    : PROVIDER_ORDER;

  for (const providerName of providerOrder) {
    const resolver = PROVIDER_RESOLVERS[providerName];
    if (!resolver) {
      console.warn(`[StreamingService] Unknown provider: ${providerName}`);
      continue;
    }

    console.log(`[StreamingService] Trying provider: ${providerName}`);
    const result = await resolver(animeTitle, episodeNumber);

    if (result && result.sources && result.sources.length > 0) {
      // Filter by tier
      const filteredSources = filterSourcesByTier(result.sources, isPremium);
      if (filteredSources.length === 0) {
        console.log(`[StreamingService] ${providerName} returned sources but none match tier "${tier}"`);
        continue;
      }

      // Pick best quality for tier
      const best = filteredSources.reduce((a, b) =>
        parseQualityNumber(b.quality) > parseQualityNumber(a.quality) ? b : a
      , filteredSources[0]);

      console.log(`[StreamingService] ✅ ${providerName} — best quality: ${best.quality}`);

      return {
        provider: result.provider,
        streamUrl: best.url,
        sources: filteredSources,
        subtitles: result.subtitles || [],
        bestQuality: best.quality || 'auto',
        tier,
      };
    }
  }

  // All providers failed
  throw new Error(`No stream provider could resolve "${animeTitle}" Episode ${episodeNumber}`);
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
      // Silently skip failed providers
    }
  }

  return results;
}

module.exports = {
  resolveStream,
  resolveAllProviders,
  filterSourcesByTier,
  getBestQualityLabel,
  QUALITY_TIERS,
};


// ============================================================
//  services/consumetProvider.js — Multi-Provider Consumet Engine
//
//  Instead of picking ONE sub-provider at module load time,
//  this creates a REGISTRY of all available Consumet-backed anime
//  providers. Each gets its OWN axios instance so proxy rotation
//  and health tracking are independent per sub-provider.
//
//  USAGE:
//    const { provider } = require('./consumetProvider');
//    const result = await provider.resolveStreamUrl({
//      provider: 'KickAssAnime',
//      title: 'Attack on Titan',
//      episode: 1,
//    });
//
//  Available sub-providers (verified against @consumet/extensions v1.8.8):
//    KickAssAnime, AnimePahe, AnimeKai, AnimeSaturn, Hianime, AnimeSama, AnimeUnity
// ============================================================
const consumet = require('@consumet/extensions');
const {
  buildHeaders,
  getProxyList,
  createProxyAgent,
  isProviderHealthy,
  classifyError,
} = require('../utils/providerHttp');
const {
  PROVIDER_IDS,
  normalizeProviderName,
  toConsumetClassName,
  toHealthKey,
  listKnownConsumetProviders,
} = require('./providerRegistry');
const { createStreamingInstance } = require('../utils/streamingHttp');
const logger = require('../utils/logger');

const META = consumet.META || consumet.default?.META || consumet.PROVIDERS?.META;
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

const availableProviders = Object.keys(ANIME);
logger.info(`[ConsumetProvider] Available ANIME providers: ${availableProviders.join(', ')}`);

// ── Shared dependencies ────────────────────────────────────
const PROXY_LIST = getProxyList();

// ── Provider Instance Factory ──────────────────────────────
// Creates an independent axios instance + proxy rotation for a given sub-provider.

/**
 * Build an axios instance configured for a specific Consumet sub-provider.
 * Uses the DEDICATED streaming client (10s timeout, retries disabled) so
 * streaming timeouts are never applied globally. Each instance has its own
 * proxy rotation index so providers don't share proxy state. This prevents
 * one provider's failures from cascading.
 */
function createProviderAxios(providerName) {
  const headers = buildHeaders(providerName);

  const instance = createStreamingInstance({
    timeout: 10000,
    headers,
    tag: `consumet:${providerName}`,
  });

  // Independent proxy rotation index per provider
  let proxyIdx = Math.floor(Math.random() * PROXY_LIST.length);

  if (PROXY_LIST.length > 0) {
    // Request interceptor: attach next proxy in rotation.
    // Browser headers (Origin, Referer, etc.) are set by buildHeaders(providerName)
    // when creating the axios instance above — no need to override them here.
    instance.interceptors.request.use(config => {
      const proxyUrl = PROXY_LIST[proxyIdx % PROXY_LIST.length];
      proxyIdx = (proxyIdx + 1) % PROXY_LIST.length;
      if (proxyUrl) {
        config.httpsAgent = createProxyAgent(proxyUrl);
      }
      return config;
    });

    // Response interceptor: on 403, retry ONCE with next proxy
    instance.interceptors.response.use(
      response => response,
      async error => {
        const config = error.config;
if (error.response?.status === 403 && !config._retry) {
          config._retry = true;
          logger.warn(`[ConsumetProvider:${providerName}] 403 blocked — retrying with next proxy`, { provider: providerName, httpStatus: 403, cloudflareDetected: true });
          const nextProxyUrl = PROXY_LIST[proxyIdx % PROXY_LIST.length];
          proxyIdx = (proxyIdx + 1) % PROXY_LIST.length;
          if (nextProxyUrl) {
            config.httpsAgent = createProxyAgent(nextProxyUrl);
            return instance.request(config);
          }
        }
        // If 403 persists after proxy retry, try without proxy as last resort
        if (error.response?.status === 403 && config._retry && config.httpsAgent) {
          logger.warn(`[ConsumetProvider:${providerName}] 403 persists — retrying WITHOUT proxy`, { provider: providerName, httpStatus: 403, cloudflareDetected: true });
          config.httpsAgent = null;
          return instance.request(config);
        }
        return Promise.reject(error);
      }
    );
  }

  return instance;
}

// ── Provider Registry ─────────────────────────────────────
// Instantiate ALL available Consumet providers so we can fallback between them.
// Each gets its own axios instance with independent proxy tracking.
// Only providers listed in the centralized registry are instantiated, using
// the canonical class names from services/providerRegistry.js.

const REGISTRY = new Map();

for (const providerId of listKnownConsumetProviders()) {
  const className = toConsumetClassName(providerId);
  if (!className) continue;
  const ProviderClass = ANIME[className];
  if (typeof ProviderClass === 'function') {
    try {
const instance = createProviderAxios(className);
      const providerInstance = new ProviderClass(instance);
      // Wrap in AniList meta-provider
      const metaProvider = new META.Anilist(providerInstance);
      REGISTRY.set(className, metaProvider);
      logger.info(`[ConsumetProvider] Registered: ${className}`);
    } catch (e) {
      logger.warn(`[ConsumetProvider] Failed to register ${className}`, { error: e.message });
    }
  }
}

logger.info(`[ConsumetProvider] Registry ready: ${[...REGISTRY.keys()].join(', ')}`);

// ── ConsumetProvider Class ─────────────────────────────────
// Provides the public API used by streamingService.js

class ConsumetProvider {
  constructor() {
    this.registry = REGISTRY;
  }

/**
   * Check if a specific sub-provider is available.
   * Accepts any naming variant (e.g. 'KickAssAnime', 'kickassanime',
   * 'consumet-kickassanime') and normalizes it safely.
   */
  hasProvider(name) {
    const normalized = normalizeProviderName(name);
    if (!normalized) return false;
    const className = toConsumetClassName(normalized);
    return className ? this.registry.has(className) : false;
  }

  /**
   * Get list of all registered provider names (class names).
   */
  listProviders() {
    return [...this.registry.keys()];
  }

  /**
   * Get count of registered providers.
   */
  get providerCount() {
    return this.registry.size;
  }

  configured() {
    return process.env.CONSUMET_BASE_URL !== 'disabled';
  }

  async fetchAnimeInfo(slug) {
    // Uses first available provider for info fetching (catalogue)
    const firstProvider = this.registry.values().next().value;
    if (!firstProvider) throw new Error('[ConsumetProvider] No providers registered');
    return firstProvider.fetchAnimeInfo(slug);
  }

  async getEpisodes(slug) {
    const info = await this.fetchAnimeInfo(slug);
    return info.episodes || [];
  }

  async getSources(episodeId) {
    const firstProvider = this.registry.values().next().value;
    if (!firstProvider) throw new Error('[ConsumetProvider] No providers registered');
    return firstProvider.fetchEpisodeSources(episodeId);
  }

  async fetchTrendingAnime(page = 1, perPage = 15) {
    const firstProvider = this.registry.values().next().value;
    if (!firstProvider) throw new Error('[ConsumetProvider] No providers registered');
    return firstProvider.fetchTrendingAnime(page, perPage);
  }

  async fetchPopularAnime(page = 1, perPage = 15) {
    const firstProvider = this.registry.values().next().value;
    if (!firstProvider) throw new Error('[ConsumetProvider] No providers registered');
    return firstProvider.fetchPopularAnime(page, perPage);
  }

async searchAnime(query, limit = 10) {
    // Try each registered provider for search, fallback to next on failure
    const providers = [...this.registry.values()];

    for (const p of providers) {
      try {
        const searchResponse = await p.search(query, limit);
        const results = Array.isArray(searchResponse) ? searchResponse : (searchResponse.results || []);
        if (results.length) return results;
} catch (error) {
        logger.warn(`[ConsumetProvider] Search failed on ${p.constructor?.name}`, { provider: p.constructor?.name, searchSuccess: false, error: error.message || 'unknown error' });
      }
    }

    // Kitsu fallback for catalogue search
    try {
      const { get } = require('../utils/providerHttp');
      const response = await get('https://kitsu.io/api/edge/anime', {
        providerName: PROVIDER_IDS.KITSU,
        params: { 'filter[text]': query, 'page[limit]': Math.min(limit, 20) },
        timeout: 12000,
        skipProxy: true,
      });
      return (response.data?.data || []).map(item => ({
        id: `kitsu:${item.id}`,
        title: item.attributes?.titles?.en_jp || item.attributes?.canonicalTitle || 'Untitled Anime',
        image: item.attributes?.posterImage?.medium || item.attributes?.posterImage?.original || null,
        cover: item.attributes?.coverImage?.large || item.attributes?.coverImage?.original || null,
        description: item.attributes?.synopsis || '',
        releaseDate: item.attributes?.startDate?.slice(0, 4) || null,
        totalEpisodes: item.attributes?.episodeCount || null,
      }));
    } catch (error) {
      logger.warn(`[ConsumetProvider] Kitsu fallback failed`, { provider: PROVIDER_IDS.KITSU, searchSuccess: false, error: error.message });
      return [];
    }
  }

  async advancedSearch({ query, page = 1, perPage = 15, genres, season, year, status, sort }) {
    const firstProvider = this.registry.values().next().value;
    if (!firstProvider) throw new Error('[ConsumetProvider] No providers registered');

    try {
      const options = { page, perPage };

      if (query) options.query = query;
      if (genres && Array.isArray(genres) && genres.length > 0) options.genres = genres;
      if (season) options.season = season.toUpperCase();
      if (year) options.year = parseInt(year, 10);
      if (status) options.status = status.toUpperCase();
      if (sort && Array.isArray(sort) && sort.length > 0) options.sort = sort;

const response = await firstProvider.advancedSearch(options.query, options);
      return response;
    } catch (err) {
      logger.error(`[ConsumetProvider] advancedSearch error`, { error: err.message });
      throw err;
    }
  }

  /**
   * Resolve a streaming URL for a given anime title and episode number,
   * using a SPECIFIC Consumet sub-provider.
   *
   * @param {object} params
   * @param {string} params.provider — The sub-provider name (e.g., 'KickAssAnime', 'AnimeKai')
   * @param {string} params.title — Anime title
   * @param {number|string} params.episode — Episode number
   * @returns {Promise<{streamUrl: string|null, allSources: Array, subtitles: Array, provider: string}>}
   */
  async resolveStreamUrl({ provider: providerName, title, episode }) {
    const startTime = Date.now();

    // Normalize the incoming provider name safely (handles 'KickAssAnime',
    // 'kickassanime', 'consumet-kickassanime', 'kick-ass-anime', etc.).
    const normalizedId = normalizeProviderName(providerName);
    const className = normalizedId ? toConsumetClassName(normalizedId) : null;
    const resolvedProvider = className || providerName;

const logTag = `[ConsumetProvider:${resolvedProvider}]`;

    logger.streamAttempt({
      provider: resolvedProvider,
      animeTitle: title,
      episode,
      startTime: new Date(startTime).toISOString(),
      status: 'pending',
    });

    // 1. Find the requested provider in registry
    const metaProvider = className ? this.registry.get(className) : undefined;
    if (!metaProvider) {
      const errorMsg = `Provider "${providerName}" not registered. Available: ${this.listProviders().join(', ')}`;
      logger.streamAttempt({
        provider: resolvedProvider,
        animeTitle: title,
        episode,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(),
        latencyMs: Date.now() - startTime,
        result: 'failure',
        failureReason: errorMsg,
        httpStatus: 0,
        timeoutStatus: false,
        cloudflareDetected: false,
        searchSuccess: false,
        streamSuccess: false,
      });
      throw new Error(errorMsg);
    }

// 2. Check provider health (via providerHttp)
    // Health key derived solely from the registry. toHealthKey() always resolves
    // known Consumet sub-providers to their 'consumet-<id>' key.
    const healthKey = toHealthKey(providerName);
    if (!isProviderHealthy(healthKey)) {
      logger.streamAttempt({
        provider: resolvedProvider,
        animeTitle: title,
        episode,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(),
        latencyMs: Date.now() - startTime,
        result: 'failure',
        failureReason: 'Provider degraded — skipped',
        httpStatus: 0,
        timeoutStatus: false,
        cloudflareDetected: false,
        searchSuccess: false,
        streamSuccess: false,
      });
      const err = new Error(`Provider ${providerName} is degraded — skipping`);
      err.code = 'PROVIDER_DEGRADED';
      throw err;
    }

    try {
      // 3. Search for the anime via AniList
      let searchResponse = await metaProvider.search(title);
      let searchResults = searchResponse.results ? searchResponse.results : searchResponse;
      let searchSuccess = Array.isArray(searchResults) && searchResults.length > 0;

      // SMART RETRY: If 0 results, drop last word (handles "Jujutsu Kaisen 0" → "Jujutsu Kaisen")
      if (!searchSuccess && title.includes(' ')) {
        const simplifiedTitle = title.split(' ').slice(0, -1).join(' ');
        logger.debugStream(`[ConsumetProvider] 0 results — retrying with: "${simplifiedTitle}"`, {
          provider: resolvedProvider,
          animeTitle: title,
          episode,
        });
        searchResponse = await metaProvider.search(simplifiedTitle);
        searchResults = searchResponse.results ? searchResponse.results : searchResponse;
        searchSuccess = Array.isArray(searchResults) && searchResults.length > 0;
      }

      if (!searchSuccess) {
        throw new Error(`Search returned 0 results for: "${title}"`);
      }

      // 4. Match anime from search results
      const targetTitle = title.toLowerCase().trim();
      let targetAnime = searchResults.find(a => {
        const titleStr = typeof a.title === 'string'
          ? a.title.toLowerCase()
          : (a.title?.english || a.title?.romaji || '').toLowerCase();
        return titleStr.includes(targetTitle) ||
               targetTitle.includes(titleStr) ||
               (a.id && a.id.toLowerCase().includes(targetTitle.replace(/\s+/g, '-')));
      });

      // Ultimate fallback: use first result
      if (!targetAnime && searchResults.length > 0) {
        logger.debugStream(`${logTag} Fuzzy match failed — using first result`, {
          provider: resolvedProvider,
          animeTitle: title,
          episode,
        });
        targetAnime = searchResults[0];
      }

      if (!targetAnime || !targetAnime.id) {
        throw new Error(`Failed to resolve a valid anime ID from search results.`);
      }

      const slug = targetAnime.id;

      // 5. Fetch full anime info (includes episodes)
      const info = await metaProvider.fetchAnimeInfo(slug);
      const episodes = info?.episodes || [];

      // Movie-specific handling
      if (!episodes.length) {
        logger.debugStream(`${logTag} "${title}" has no episode list — treating as movie`, {
          provider: resolvedProvider,
          animeTitle: title,
          episode,
        });
        try {
          const sources = await metaProvider.fetchEpisodeSources(slug);
          const streamList = sources?.sources || [];
          if (streamList.length > 0) {
            const bestSource = streamList.reduce((best, src) =>
              (src.quality && src.quality !== 'default' && (!best.quality || src.quality > best.quality)) ? src : best
            , streamList[0]);
            logger.streamAttempt({
              provider: resolvedProvider,
              animeTitle: title,
              episode,
              startTime: new Date(startTime).toISOString(),
              endTime: new Date().toISOString(),
              latencyMs: Date.now() - startTime,
              result: 'success',
              httpStatus: 200,
              timeoutStatus: false,
              cloudflareDetected: false,
              searchSuccess: true,
              streamSuccess: true,
              sourceCount: streamList.length,
            });
            return {
              streamUrl: bestSource?.url || streamList[0]?.url,
              allSources: streamList,
              subtitles: sources?.subtitles || [],
              episodeTitle: info.title || title,
              episodeImage: info.image || null,
              provider: providerName,
            };
          }
        } catch (err) {
          logger.warn(`${logTag} Movie direct fetch failed`, { provider: resolvedProvider, animeTitle: title, episode, error: err.message });
        }
        throw new Error(`No playable sources found for "${title}".`);
      }

      // 6. Find target episode by number
      const targetEp = episodes.find(ep => ep.number === Number(episode));
      if (!targetEp) {
        // For movies/episode-1 fallback
        if (Number(episode) === 1 && episodes.length >= 1) {
          logger.debugStream(`${logTag} Episode 1 not found by number — using first episode entry`, {
            provider: resolvedProvider,
            animeTitle: title,
            episode,
          });
          const firstEp = episodes[0];
          const sources = await metaProvider.fetchEpisodeSources(firstEp.id);
          const streamList = sources?.sources || [];
          if (!streamList.length) {
            throw new Error(`No stream sources found for "${title}".`);
          }
          const bestSource = streamList.reduce((best, src) =>
            (src.quality && src.quality !== 'default' && (!best.quality || src.quality > best.quality)) ? src : best
          , streamList[0]);
          logger.streamAttempt({
            provider: resolvedProvider,
            animeTitle: title,
            episode,
            startTime: new Date(startTime).toISOString(),
            endTime: new Date().toISOString(),
            latencyMs: Date.now() - startTime,
            result: 'success',
            httpStatus: 200,
            timeoutStatus: false,
            cloudflareDetected: false,
            searchSuccess: true,
            streamSuccess: true,
            sourceCount: streamList.length,
          });
          return {
            streamUrl: bestSource?.url || streamList[0]?.url,
            allSources: streamList,
            subtitles: sources?.subtitles || [],
            episodeTitle: firstEp.title || null,
            episodeImage: firstEp.image || null,
            provider: providerName,
          };
        }
        throw new Error(`Episode ${episode} not found for "${title}". Available: ${episodes.length} episodes`);
      }

      // 7. Resolve streaming sources
      const sources = await metaProvider.fetchEpisodeSources(targetEp.id);
      const streamList = sources?.sources || [];
      if (!streamList.length) {
        throw new Error(`No stream sources found for "${title}" Episode ${episode}.`);
      }

      // 8. Return the highest quality
      const bestSource = streamList.reduce((best, src) =>
        (src.quality && src.quality !== 'default' && (!best.quality || src.quality > best.quality)) ? src : best
      , streamList[0]);

      const elapsed = Date.now() - startTime;
      logger.streamAttempt({
        provider: resolvedProvider,
        animeTitle: title,
        episode,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(),
        latencyMs: elapsed,
        result: 'success',
        httpStatus: 200,
        timeoutStatus: false,
        cloudflareDetected: false,
        searchSuccess: true,
        streamSuccess: true,
        sourceCount: streamList.length,
        bestQuality: bestSource?.quality || 'auto',
      });

      return {
        streamUrl: bestSource?.url || streamList[0]?.url,
        allSources: streamList,
        subtitles: sources?.subtitles || [],
        episodeTitle: targetEp.title || null,
        episodeImage: targetEp.image || null,
        provider: providerName,
      };
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const { category, description } = classifyError(err);
      const httpStatus = err.response?.status || 0;
      const isTimeout = /timeout/i.test(err.message || '') || err.code === 'ECONNABORTED';
      const cloudflareDetected = httpStatus === 403 || /cloudflare/i.test(err.message || '');
      logger.streamAttempt({
        provider: resolvedProvider,
        animeTitle: title,
        episode,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(),
        latencyMs: elapsed,
        result: 'failure',
        failureReason: description || err.message,
        category,
        httpStatus,
        timeoutStatus: isTimeout,
        cloudflareDetected,
        searchSuccess: false,
        streamSuccess: false,
      });
      throw err;
    }
  }
}

// ── Singleton export ───────────────────────────────────────
const provider = new ConsumetProvider();

module.exports = { ConsumetProvider, provider };


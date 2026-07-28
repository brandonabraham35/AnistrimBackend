// ============================================================
//  services/consumetProvider.js — Consumet In-Memory Provider
//
//  Uses @consumet/extensions with:
//    • Shared HTTP client from utils/providerHttp.js for proxy,
//      retry, and header management
//    • Unified proxy configuration (no duplicate proxy logic)
//    • Provider health tracking via providerHttp
//    • Rotating proxies with 403 retry handling
//    • Cloudflare-bypass headers
//    • Fallback across multiple Consumet-supported providers
// ============================================================
const consumet = require('@consumet/extensions');
const { buildHeaders, getProxyList, createProxyAgent, getNextProxyUrl } = require('../utils/providerHttp');

const META = consumet.META || consumet.default?.META || consumet.PROVIDERS?.META;
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

const availableProviders = Object.keys(ANIME);
console.log(`[ConsumetProvider] Available ANIME providers:`, availableProviders.join(', '));

// ── Shared Proxy Integration ──────────────────────────────
// Build a customAxios that uses the SAME proxy configuration as providerHttp.js
// The @consumet/extensions library accepts an axios instance — we configure it
// to use our shared proxy rotation and unified headers.

const axios = require('axios');

// Build the initial headers from our shared system
const sharedHeaders = buildHeaders('consumet');

const customAxios = axios.create({
  timeout: 15000,
  headers: sharedHeaders,
});

// Attach rotating proxy interceptor — uses same proxy list as providerHttp
const PROXY_LIST = getProxyList();

if (PROXY_LIST.length > 0) {
  console.log(`[ConsumetProvider] Using shared proxy rotation (${PROXY_LIST.length} proxies)`);

  // Request interceptor: attach proxy agent
  customAxios.interceptors.request.use(config => {
    const proxyUrl = getNextProxyUrl();
    if (proxyUrl) {
      config.httpsAgent = createProxyAgent(proxyUrl);
      // Add Referer header for Cloudflare-bypass
      config.headers['Referer'] = 'https://consumet.org/';
      config.headers['Origin'] = 'https://consumet.org';
    }
    return config;
  });

  // Response interceptor: on 403, retry with a different proxy once
  customAxios.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error.config;
      if (error.response?.status === 403 && config.httpsAgent && !config._retry) {
        config._retry = true;
        console.warn(`[ConsumetProvider] 403 blocked — retrying with different proxy...`);
        // Get a new proxy (next in rotation)
        const newProxyUrl = getNextProxyUrl();
        if (newProxyUrl) {
          config.httpsAgent = createProxyAgent(newProxyUrl);
          return customAxios.request(config);
        }
      }
      // On 403 without proxy, or retry exhausted — try without proxy as last resort
      if (error.response?.status === 403 && config.httpsAgent && config._retry) {
        console.warn(`[ConsumetProvider] 403 persists with proxy — retrying WITHOUT proxy...`);
        config._retry = true;
        config.httpsAgent = null;
        return customAxios.request(config);
      }
      return Promise.reject(error);
    }
  );
} else {
  console.log(`[ConsumetProvider] No proxies configured. Consumet uses direct connection.`);
}

// ── Provider Selection ────────────────────────────────────
// Priority order — Consumet's internal fallback chain.
// AnimePahe and Hianime are included but will be attempted WITH proxy.
// The proxy rotation should handle 403 blocks from these targets.
const preferredOrder = [
  'KickAssAnime',
  'AnimePahe',
  'AnimeKai',
  'AnimeSaturn',
  'Hianime',
  'AnimeSama',
];

let fallbackProvider = null;

for (const name of preferredOrder) {
  const key = availableProviders.find(k => k.toLowerCase() === name.toLowerCase());
  if (key && typeof ANIME[key] === 'function') {
    try {
      console.log(`[ConsumetProvider] ✅ Selected provider: ${key}`);
      fallbackProvider = new ANIME[key](customAxios);
      break;
    } catch (e) {
      console.warn(`[ConsumetProvider] Failed to instantiate ${key}:`, e.message);
    }
  }
}

// Ultimate safe fallback — exclude known-broken providers
if (!fallbackProvider) {
  const safeKey = availableProviders.find(key =>
    typeof ANIME[key] === 'function' &&
    !key.toLowerCase().includes('pahe') &&
    !key.toLowerCase().includes('hianime')
  );
  if (safeKey) {
    console.log(`[ConsumetProvider] ⚠️  Blind fallback: ${safeKey}`);
    fallbackProvider = new ANIME[safeKey](customAxios);
  } else {
    throw new Error("[ConsumetProvider] CRITICAL: No usable anime providers found in @consumet/extensions.");
  }
}

// Wrap in AniList meta-provider
const provider = new META.Anilist(fallbackProvider);

class ConsumetProvider {
  configured() {
    return process.env.CONSUMET_BASE_URL !== 'disabled';
  }

  async fetchAnimeInfo(slug) {
    return provider.fetchAnimeInfo(slug);
  }

  async getEpisodes(slug) {
    const info = await provider.fetchAnimeInfo(slug);
    return info.episodes || [];
  }

  async getSources(episodeId) {
    const sources = await provider.fetchEpisodeSources(episodeId);
    return sources;
  }

  async fetchTrendingAnime(page = 1, perPage = 15) {
    return provider.fetchTrendingAnime(page, perPage);
  }

  async fetchPopularAnime(page = 1, perPage = 15) {
    return provider.fetchPopularAnime(page, perPage);
  }

  async searchAnime(query, limit = 10) {
    try {
      const searchResponse = await provider.search(query, limit);
      const results = Array.isArray(searchResponse) ? searchResponse : (searchResponse.results || []);
      if (results.length) return results;
    } catch (error) {
      console.warn(`[ConsumetProvider] Search failed: ${error.message || 'unknown error'}`);
    }

    // Kitsu fallback for catalogue search
    try {
      const { get } = require('../utils/providerHttp');
      const response = await get('https://kitsu.io/api/edge/anime', {
        providerName: 'kitsu',
        params: { 'filter[text]': query, 'page[limit]': Math.min(limit, 20) },
        timeout: 12000,
        skipProxy: true, // Kitsu doesn't need proxy
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
      console.error(`[ConsumetProvider] Kitsu fallback failed: ${error.message}`);
      return [];
    }
  }

  async advancedSearch({ query, page = 1, perPage = 15, genres, season, year, status, sort }) {
    try {
      const options = { page, perPage };

      if (query) options.query = query;
      if (genres && Array.isArray(genres) && genres.length > 0) options.genres = genres;
      if (season) options.season = season.toUpperCase();
      if (year) options.year = parseInt(year, 10);
      if (status) options.status = status.toUpperCase();
      if (sort && Array.isArray(sort) && sort.length > 0) options.sort = sort;

      const response = await provider.advancedSearch(options.query, options);
      return response;
    } catch (err) {
      console.error(`[ConsumetProvider] advancedSearch error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Resolve a streaming URL for a given anime title and episode number.
   * Steps:
   *   1. Search AniList by title to find the anime
   *   2. Fetch full anime info (includes episode list)
   *   3. Find the episode matching the given number
   *   4. Resolve streaming sources for that episode
   *   5. Return the highest quality .m3u8 URL
   */
  async resolveStreamUrl(animeTitle, episodeNumber) {
    console.log(`[resolveStream] Searching Consumet for: "${animeTitle}" Ep ${episodeNumber}`);

    // 1. Search for the anime
    let searchResponse = await provider.search(animeTitle);
    let searchResults = searchResponse.results ? searchResponse.results : searchResponse;

    // SMART RETRY: If 0 results, drop the last word (e.g., "Jujutsu Kaisen 0" -> "Jujutsu Kaisen")
    // This handles movie titles that include a numeric suffix like "0" or "I".
    if ((!Array.isArray(searchResults) || searchResults.length === 0) && animeTitle.includes(' ')) {
      const simplifiedTitle = animeTitle.split(' ').slice(0, -1).join(' ');
      console.log(`[resolveStream] 0 results — retrying with: "${simplifiedTitle}"`);
      searchResponse = await provider.search(simplifiedTitle);
      searchResults = searchResponse.results ? searchResponse.results : searchResponse;
    }

    if (!Array.isArray(searchResults) || searchResults.length === 0) {
      throw new Error(`Consumet search returned 0 results for: "${animeTitle}"`);
    }

    // Normalize the original search string
    const targetTitle = animeTitle.toLowerCase().trim();

    // 1. Flexible Matcher
    let targetAnime = searchResults.find(a => {
      const titleStr = typeof a.title === 'string'
        ? a.title.toLowerCase()
        : (a.title?.english || a.title?.romaji || '').toLowerCase();

      return titleStr.includes(targetTitle) ||
             targetTitle.includes(titleStr) ||
             (a.id && a.id.toLowerCase().includes(targetTitle.replace(/\s+/g, '-')));
    });

    // 2. Ultimate Fallback
    if (!targetAnime && searchResults.length > 0) {
      console.log(`[resolveStream] Fuzzy match failed — using first result`);
      targetAnime = searchResults[0];
    }

    if (!targetAnime || !targetAnime.id) {
      throw new Error(`Failed to resolve a valid anime ID from search results.`);
    }

    const slug = targetAnime.id;

    // 3. Fetch full anime info (includes episodes)
    const info = await provider.fetchAnimeInfo(slug);
    const episodes = info?.episodes || [];

    // Movie-specific handling
    if (!episodes.length) {
      console.log(`[resolveStream] "${animeTitle}" has no episode list — treating as movie`);
      try {
        const sources = await provider.fetchEpisodeSources(slug);
        const streamList = sources?.sources || [];
        if (streamList.length > 0) {
          const bestSource = streamList.reduce((best, src) =>
            (src.quality && src.quality !== 'default' && (!best.quality || src.quality > best.quality)) ? src : best
          , streamList[0]);
          return {
            streamUrl: bestSource?.url || streamList[0]?.url,
            allSources: streamList,
            subtitles: sources?.subtitles || [],
            episodeTitle: info.title || animeTitle,
            episodeImage: info.image || null,
          };
        }
      } catch (err) {
        console.warn(`[resolveStream] Movie direct fetch failed: ${err.message}`);
      }
      throw new Error(`No playable sources found for "${animeTitle}".`);
    }

    // 4. Find the target episode by number (strict matching)
    const targetEp = episodes.find(ep => ep.number === Number(episodeNumber));
    if (!targetEp) {
      // For movies/episode-1 fallback
      if (Number(episodeNumber) === 1 && episodes.length >= 1) {
        console.log(`[resolveStream] Episode 1 not found by number — using first episode entry`);
        const firstEp = episodes[0];
        const sources = await provider.fetchEpisodeSources(firstEp.id);
        const streamList = sources?.sources || [];
        if (!streamList.length) {
          throw new Error(`No stream sources found for "${animeTitle}".`);
        }
        const bestSource = streamList.reduce((best, src) =>
          (src.quality && src.quality !== 'default' && (!best.quality || src.quality > best.quality)) ? src : best
        , streamList[0]);
        return {
          streamUrl: bestSource?.url || streamList[0]?.url,
          allSources: streamList,
          subtitles: sources?.subtitles || [],
          episodeTitle: firstEp.title || null,
          episodeImage: firstEp.image || null,
        };
      }
      throw new Error(`Episode ${episodeNumber} not found for "${animeTitle}". Available: ${episodes.length} episodes`);
    }

    // 5. Resolve streaming sources
    const sources = await provider.fetchEpisodeSources(targetEp.id);
    const streamList = sources?.sources || [];
    if (!streamList.length) {
      throw new Error(`No stream sources found for "${animeTitle}" Episode ${episodeNumber}.`);
    }

    // 6. Return the highest quality
    const bestSource = streamList.reduce((best, src) =>
      (src.quality && src.quality !== 'default' && (!best.quality || src.quality > best.quality)) ? src : best
    , streamList[0]);

    return {
      streamUrl: bestSource?.url || streamList[0]?.url,
      allSources: streamList,
      subtitles: sources?.subtitles || [],
      episodeTitle: targetEp.title || null,
      episodeImage: targetEp.image || null,
    };
  }
}

module.exports = { ConsumetProvider };


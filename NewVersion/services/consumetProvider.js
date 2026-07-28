const axios = require('axios');
const consumet = require('@consumet/extensions');
const { HttpsProxyAgent } = require('https-proxy-agent');

const META = consumet.META || consumet.default?.META || consumet.PROVIDERS?.META;
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

const availableProviders = Object.keys(ANIME);
console.log(`[STREAM SETUP] Available ANIME providers:`, availableProviders.join(', '));

// ── Thordata Proxy (Single) ───────────────────────────────
// If PROXY_HOST/PORT/USER/PASS are set, build a proxy URL for
// the fallback HTTP client (Kitsu API, etc.)
const THORDATA_PROXY_URL = (() => {
  const host = process.env.PROXY_HOST;
  const port = process.env.PROXY_PORT;
  const user = process.env.PROXY_USER;
  const pass = process.env.PROXY_PASS;
  if (host && port) {
    const auth = user && pass ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
    return `http://${auth}${host}:${port}`;
  }
  return null;
})();

// Load a comma-separated list of proxies from environment variables.
// Format: http://USER:PASS@HOST:PORT,http://USER2:PASS2@HOST2:PORT2
// If THORDATA_PROXY_URL is set but PROXY_LIST is empty, add it as the single entry.
const PROXY_LIST = (() => {
  const list = (process.env.PROXY_LIST || '').split(',').map(p => p.trim()).filter(Boolean);
  if (list.length === 0 && THORDATA_PROXY_URL) {
    return [THORDATA_PROXY_URL];
  }
  return list;
})();

let proxyIndex = 0;

const customAxios = axios.create({
    timeout: 15000, // Increased timeout for proxies
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
    }
});

if (PROXY_LIST.length > 0) {
    console.log(`[STREAM SETUP] Initializing with ${PROXY_LIST.length} rotating proxies.`);

    // Request interceptor to attach a rotating proxy to each outgoing request
    customAxios.interceptors.request.use(config => {
        // Round-robin proxy selection
        const proxyUrl = PROXY_LIST[proxyIndex];
        proxyIndex = (proxyIndex + 1) % PROXY_LIST.length;
        
        config.httpsAgent = new HttpsProxyAgent(proxyUrl);
        return config;
    });

    // Response interceptor to handle 403 Forbidden errors by retrying without a proxy
    customAxios.interceptors.response.use(
        (response) => response,
        async (error) => {
            const config = error.config;
            if (error.response?.status === 403 && config.httpsAgent && !config._retry) {
                config._retry = true;
                console.warn(`[Proxy] Request to ${config.url} was blocked (403). Retrying once without proxy...`);
                return customAxios.request({ ...config, httpsAgent: null });
            }
            return Promise.reject(error);
        }
    );
} else {
    console.log(`[STREAM SETUP] No proxies configured. Using direct connection.`);
}

// Priority list excluding hard-blocked providers (AnimePahe / HiAnime)
const preferredOrder = ['KickAssAnime', 'AnimeKai', 'AnimeSama', 'AnimeSaturn'];

let fallbackProvider = null;

for (const name of preferredOrder) {
    const key = availableProviders.find(k => k.toLowerCase() === name.toLowerCase());
    if (key && typeof ANIME[key] === 'function') {
        try {
            console.log(`[STREAM SETUP] Success: Using ${key}`);
            fallbackProvider = new ANIME[key](customAxios);
            break;
        } catch (e) {
            console.warn(`[STREAM SETUP] Failed to instantiate ${key}:`, e.message);
        }
    }
}

if (!fallbackProvider) {
    const safeKey = availableProviders.find(key => 
        typeof ANIME[key] === 'function' && 
        !key.toLowerCase().includes('pahe') &&
        !key.toLowerCase().includes('hianime')
    );
    if (safeKey) {
        console.log(`[STREAM SETUP] Blind Fallback Success: Using ${safeKey}`);
        fallbackProvider = new ANIME[safeKey](customAxios);
    } else {
        throw new Error("CRITICAL: No safe anime providers found.");
    }
}

const provider = new META.Anilist(fallbackProvider);

class ConsumetProvider {
  configured() {
    // Always configured in in-memory mode; only returns false if
    // CONSUMET_BASE_URL is set to 'disabled' explicitly.
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

  /**
   * Fetch trending anime from AniList (based on TRENDING_DESC sort).
   * Returns a paginated response: { results: [...], total, page, perPage }.
   */
  async fetchTrendingAnime(page = 1, perPage = 15) {
    const response = await provider.fetchTrendingAnime(page, perPage);
    return response;
  }

  /**
   * Fetch popular anime from AniList (based on POPULARITY_DESC sort).
   * Returns a paginated response: { results: [...], total, page, perPage }.
   */
  async fetchPopularAnime(page = 1, perPage = 15) {
    const response = await provider.fetchPopularAnime(page, perPage);
    return response;
  }

  /**
   * Search for anime by title using AniList's built-in search.
   * Returns an array of search results.
   * NOTE: Consumet's search() returns a paginated object { results: [...], total, ... },
   * so we extract the array before returning.
   */
  async searchAnime(query, limit = 10) {
    try {
      const searchResponse = await provider.search(query, limit);
      const results = Array.isArray(searchResponse) ? searchResponse : (searchResponse.results || []);
      if (results.length) return results;
    } catch (error) {
      console.warn('[ConsumetProvider] Primary search failed:', error.message || 'unknown provider error');
    }

    // Keep the admin import usable when the current Consumet streaming provider
    // or AniList is rate-limited. This remains server-side; the browser never
    // contacts an external catalogue provider directly.
    try {
      const response = await axios.get('https://kitsu.io/api/edge/anime', {
        params: { 'filter[text]': query, 'page[limit]': Math.min(limit, 20) },
        timeout: 12000,
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
      console.error('[ConsumetProvider] Kitsu fallback search failed:', error.message);
      return [];
    }
  }

  /**
   * Advanced search using AniList's filtering capabilities.
   * Supported options:
   *   query   - search text
   *   page    - page number (default: 1)
   *   perPage - results per page (default: 15)
   *   genres  - array of genre strings (e.g. ["Action", "Drama"])
   *   season  - "WINTER", "SPRING", "SUMMER", "FALL"
   *   year    - release year (number)
   *   status  - "RELEASING", "FINISHED", "NOT_YET_RELEASED", "CANCELLED"
   *   sort    - array of sort strings (e.g. ["SCORE_DESC", "POPULARITY_DESC"])
   */
  async advancedSearch({ query, page = 1, perPage = 15, genres, season, year, status, sort }) {
    try {
      const options = { page, perPage };

      if (query) options.query = query;
      if (genres && Array.isArray(genres) && genres.length > 0) options.genres = genres;
      if (season) options.season = season.toUpperCase();
      if (year) options.year = parseInt(year, 10);
      if (status) options.status = status.toUpperCase();
      if (sort && Array.isArray(sort) && sort.length > 0) options.sort = sort;

      // Anilist.advancedSearch() typically returns { results: [...], total, ... }
      const response = await provider.advancedSearch(options.query, options);
      return response;
    } catch (err) {
      console.error('[ConsumetProvider] advancedSearch error:', err.message);
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
   *
   * Movie Handling:
   *   When episodeNumber is 1 and the anime is a standalone movie
   *   (e.g. "Jujutsu Kaisen 0"), the episode list may contain only 1
   *   entry or the "episode" may be identified by title rather than number.
   *   The smart search retry drops trailing numerical tokens (e.g. "0")
   *   to find the parent entry.
   */
  async resolveStreamUrl(animeTitle, episodeNumber) {
    // 1. Search for the anime
    console.log(`[resolveStream] Searching Consumet for: "${animeTitle}"`);
    let searchResponse = await provider.search(animeTitle);
    let searchResults = searchResponse.results ? searchResponse.results : searchResponse;

    // THE SMART RETRY: If 0 results, drop the last word (e.g., "Jujutsu Kaisen 0" -> "Jujutsu Kaisen")
    // This handles movie titles that include a numeric suffix like "0" or "I".
    if ((!Array.isArray(searchResults) || searchResults.length === 0) && animeTitle.includes(' ')) {
      const simplifiedTitle = animeTitle.split(' ').slice(0, -1).join(' ');
      console.log(`[resolveStream WARN] 0 results for exact title. Retrying with widened search: "${simplifiedTitle}"...`);
      searchResponse = await provider.search(simplifiedTitle);
      searchResults = searchResponse.results ? searchResponse.results : searchResponse;
    }

    if (!Array.isArray(searchResults) || searchResults.length === 0) {
      throw new Error(`Consumet search API returned 0 results for: "${animeTitle}"`);
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
      console.log(`[resolveStream WARN] Fuzzy match failed. Trusting provider's first result.`);
      targetAnime = searchResults[0];
    }

    if (!targetAnime || !targetAnime.id) {
      throw new Error(`Failed to resolve a valid anime ID from search results.`);
    }

    const slug = targetAnime.id;  // AniList ID

    // 3. Fetch full anime info (includes episodes)
    const info = await provider.fetchAnimeInfo(slug);
    const episodes = info?.episodes || [];

    // ── Movie-specific handling ────────────────────────────
    // If no episodes array exists or it's empty, this could be a movie
    // where the provider reports 0 episodes. Try fetching the entire
    // info as a single "episode" by using the anime ID itself.
    if (!episodes.length) {
      console.log(`[resolveStream] "${animeTitle}" has no episode list — treating as movie/single-entry.`);
      // For movies, the "episode" may be the anime itself.
      // Attempt to resolve sources using the anime slug/id as the episode ID.
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

    // 4. Find the target episode by number
    const targetEp = episodes.find(ep => ep.number === Number(episodeNumber));
    if (!targetEp) {
      // For movies, where episodeNumber=1 but the provider may not have
      // numbered its single entry, use the first episode as fallback.
      if (Number(episodeNumber) === 1 && episodes.length >= 1) {
        console.log(`[resolveStream] Episode 1 not found by number — using first episode entry for "${animeTitle}".`);
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
      throw new Error(`Episode ${episodeNumber} not found for "${animeTitle}".`);
    }

    // 5. Resolve streaming sources
    const sources = await provider.fetchEpisodeSources(targetEp.id);
    const streamList = sources?.sources || [];
    if (!streamList.length) {
      throw new Error(`No stream sources found for "${animeTitle}" Episode ${episodeNumber}.`);
    }

    // 6. Return the highest quality .m3u8 URL (last entry is usually highest)
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

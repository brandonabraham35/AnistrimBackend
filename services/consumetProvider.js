const consumet = require('@consumet/extensions');
// Fallback safely in case of export changes
const META = consumet.META || consumet.default?.META || consumet.PROVIDERS?.META;
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

if (!META || !META.Anilist || !ANIME || !ANIME.AnimePahe) {
  console.error('Available META providers:', Object.keys(META || {}));
  console.error('Available ANIME providers:', Object.keys(ANIME || {}));
  throw new Error('Failed to extract required providers (META.Anilist + ANIME.AnimePahe) from @consumet/extensions.');
}

console.log('✅ Successfully loaded META.Anilist with ANIME.Gogoanime fallback');

// Use Gogoanime as the underlying episode scraper for Anilist
// Gogoanime is more reliable in cloud environments than AnimePahe (which blocks Render via Cloudflare DNS)
const fallbackProvider = new ANIME.Gogoanime();
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
   * Search for anime by title using AniList's built-in search.
   * Returns an array of search results.
   * NOTE: Consumet's search() returns a paginated object { results: [...], total, ... },
   * so we extract the array before returning.
   */
  async searchAnime(query, limit = 10) {
    const searchResponse = await provider.search(query, limit);
    // Safely extract the array (handling both paginated object and flat array returns)
    const results = Array.isArray(searchResponse)
      ? searchResponse
      : (searchResponse.results || []);
    return results;
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
    // 1. Search for the anime
    console.log(`[resolveStream] Searching Consumet for: "${animeTitle}"`);
    let searchResponse = await provider.search(animeTitle);
    let searchResults = searchResponse.results ? searchResponse.results : searchResponse;

    // THE SMART RETRY: If 0 results, drop the last word (e.g., "Jujutsu Kaisen 0" -> "Jujutsu Kaisen")
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
    if (!episodes.length) {
      throw new Error(`No episodes found for "${animeTitle}". The provider may not support this title.`);
    }

    // 4. Find the target episode by number
    const targetEp = episodes.find(ep => ep.number === Number(episodeNumber));
    if (!targetEp) {
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


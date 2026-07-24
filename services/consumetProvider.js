const consumet = require('@consumet/extensions');
// Fallback safely in case of export changes
const META = consumet.META || consumet.default?.META || consumet.PROVIDERS?.META;
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

if (!META || !META.Anilist || !ANIME || !ANIME.AnimePahe) {
  console.error('Available META providers:', Object.keys(META || {}));
  console.error('Available ANIME providers:', Object.keys(ANIME || {}));
  throw new Error('Failed to extract required providers (META.Anilist + ANIME.AnimePahe) from @consumet/extensions.');
}

console.log('✅ Successfully loaded META.Anilist with ANIME.AnimePahe fallback');

// Inject AnimePahe as the dedicated episode scraper for Anilist
// This prevents Consumet from defaulting to Hianime (which is blocked on Render)
const fallbackProvider = new ANIME.AnimePahe();
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
    const searchResults = await this.searchAnime(animeTitle);
    if (!Array.isArray(searchResults) || searchResults.length === 0) {
      throw new Error(`No anime found for title: "${animeTitle}"`);
    }

    // 2. Pick the best match — prefer exact title match
    const targetAnime = searchResults.find(
      r => r.title?.romaji?.toLowerCase() === animeTitle.toLowerCase() ||
           r.title?.english?.toLowerCase() === animeTitle.toLowerCase() ||
           r.title?.native === animeTitle ||
           (r.id && String(r.id).includes(animeTitle.toLowerCase().replace(/\s+/g, '-')))
    );
    const bestMatch = targetAnime || searchResults[0];
    if (!bestMatch) {
      throw new Error(`Anime not found in search results for: "${animeTitle}"`);
    }
    const slug = bestMatch.id;  // AniList ID

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


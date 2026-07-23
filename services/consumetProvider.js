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
}

module.exports = { ConsumetProvider };


const consumet = require('@consumet/extensions');
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

if (!ANIME || !ANIME.Hianime) {
  console.error('Available ANIME providers in package:', Object.keys(ANIME));
  throw new Error('Failed to extract ANIME.Hianime from @consumet/extensions.');
}

console.log('✅ Successfully mapped provider to: ANIME.Hianime');

// Initialize the Hianime provider
const provider = new ANIME.Hianime();

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


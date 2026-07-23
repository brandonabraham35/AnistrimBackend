const consumet = require('@consumet/extensions');
// Fallback safely in case of export changes
const META = consumet.META || consumet.default?.META || consumet.PROVIDERS?.META;

if (!META || !META.Anilist) {
  console.error('Available META providers in package:', Object.keys(META || {}));
  throw new Error('Failed to extract META.Anilist from @consumet/extensions.');
}

console.log('✅ Successfully mapped provider to: META.Anilist');

// Initialize the Anilist aggregator — uses Anilist's GraphQL API which is
// much more resilient for cloud environments (no Cloudflare blocking).
const provider = new META.Anilist();

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


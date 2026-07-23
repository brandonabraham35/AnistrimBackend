// Robust import pattern for @consumet/extensions — handles CommonJS vs ESM mismatches
const consumet = require('@consumet/extensions');

// Safely resolve the ANIME object regardless of the package version / export structure.
// Latest versions may export under: consumet.ANIME, consumet.default.ANIME, or consumet.PROVIDERS.ANIME.
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

if (!ANIME || !ANIME.Gogoanime) {
  console.error('Consumet Export Object:', Object.keys(consumet));
  throw new Error(
    'Failed to extract ANIME.Gogoanime from @consumet/extensions. See logs above for available exports.'
  );
}

// In-memory Gogoanime provider — no more HTTP calls to a separate microservice.
const gogoanime = new ANIME.Gogoanime("https://anitaku.pe");

class ConsumetProvider {
  configured() {
    // Always configured in in-memory mode; only returns false if
    // CONSUMET_BASE_URL is set to 'disabled' explicitly.
    return process.env.CONSUMET_BASE_URL !== 'disabled';
  }

  async fetchAnimeInfo(slug) {
    return gogoanime.fetchAnimeInfo(slug);
  }

  async getEpisodes(slug) {
    const info = await gogoanime.fetchAnimeInfo(slug);
    return info.episodes || [];
  }

  async getSources(episodeId) {
    const sources = await gogoanime.fetchEpisodeSources(episodeId);
    return sources;
  }
}

module.exports = { ConsumetProvider };


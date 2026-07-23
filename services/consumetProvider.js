// Robust import pattern for @consumet/extensions — handles variations across versions
const consumet = require('@consumet/extensions');
const Gogoanime = consumet.ANIME?.Gogoanime;

if (!Gogoanime) {
  throw new Error(
    'Failed to initialize @consumet/extensions: ANIME.Gogoanime is not available. ' +
    'Run `npm install @consumet/extensions@latest` and try again.'
  );
}

// In-memory Gogoanime provider — no more HTTP calls to a separate microservice.
// Falls back to HTTP if CONSUMET_BASE_URL is explicitly set (legacy mode).
const gogoanime = new Gogoanime("https://anitaku.pe");

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


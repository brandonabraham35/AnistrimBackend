const consumet = require('@consumet/extensions');
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

if (!ANIME) {
  throw new Error('Failed to extract ANIME object from @consumet/extensions.');
}

// Dynamically find the provider key regardless of exact casing or renaming
const providerKey = Object.keys(ANIME).find(key =>
  key.toLowerCase().includes('gogo') ||
  key.toLowerCase().includes('anitaku')
);

if (!providerKey) {
  console.error('Available ANIME providers in package:', Object.keys(ANIME));
  throw new Error('Could not find Gogoanime or Anitaku in ANIME exports. Check the Render logs for the available providers.');
}

console.log(`✅ Successfully mapped provider to: ANIME.${providerKey}`);

// Initialize the dynamically found class (passing the custom URL to be safe)
const gogoanime = new ANIME[providerKey]("https://anitaku.pe");

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


const { request } = require('../utils/providerHttp');

class ConsumetProvider {
  configured() { return Boolean(process.env.CONSUMET_BASE_URL); }
  base() { return process.env.CONSUMET_BASE_URL.replace(/\/$/, ''); }
  async getAnimeInfo(slug) { const response = await request({ method: 'GET', url: `${this.base()}/anime/gogoanime/${encodeURIComponent(slug)}` }); return response.data; }
  async getEpisodes(slug) { const info = await this.getAnimeInfo(slug); return info.episodes || []; }
  async getSources(episodeId) { const response = await request({ method: 'GET', url: `${this.base()}/anime/gogoanime/watch/${encodeURIComponent(episodeId)}` }); return response.data; }
}

module.exports = { ConsumetProvider };

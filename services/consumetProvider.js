const { request } = require('../utils/providerHttp');

class ConsumetProvider {
  configured() { return Boolean(process.env.CONSUMET_BASE_URL); }
  base() { return process.env.CONSUMET_BASE_URL.replace(/\/$/, ''); }
  async getAnimeInfo(slug) { const response = await request({ method: 'GET', url: `${this.base()}/anime/gogoanime/${encodeURIComponent(slug)}` }); return response.data; }
  async getEpisodes(slug) {
    const info = await this.getAnimeInfo(slug);
    console.log(`[CONSUMET DEBUG] getEpisodes("${slug}") — info keys: ${Object.keys(info || {}).join(', ')}, has episodes: ${Boolean(info?.episodes)}, episodes type: ${typeof info?.episodes}, isArray: ${Array.isArray(info?.episodes)}`);
    if (info?.episodes && Array.isArray(info.episodes)) {
      console.log(`[CONSUMET DEBUG] First episode sample:`, JSON.stringify(info.episodes[0] || 'empty').substring(0, 150));
    }
    return info.episodes || [];
  }
  async getSources(episodeId) { const response = await request({ method: 'GET', url: `${this.base()}/anime/gogoanime/watch/${encodeURIComponent(episodeId)}` }); return response.data; }
}

module.exports = { ConsumetProvider };

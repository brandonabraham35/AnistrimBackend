const { request } = require('../utils/providerHttp');

const BASE_URL = process.env.KITSU_BASE_URL || 'https://kitsu.io/api/edge';

function normalize(record) {
  const attributes = record.attributes || {};
  const titles = attributes.titles || {};
  const startDate = attributes.startDate || null;
  const statusMap = { current: 'airing', finished: 'completed', upcoming: 'upcoming', tba: 'upcoming', unreleased: 'upcoming' };
  return {
    kitsu_id: String(record.id),
    title: attributes.canonicalTitle || titles.en || titles.en_jp || Object.values(titles)[0] || 'Untitled Anime',
    title_japanese: titles.ja_jp || titles.ja || null,
    description: attributes.synopsis || attributes.description || null,
    cover_image: attributes.posterImage?.original || attributes.posterImage?.large || null,
    banner_image: attributes.coverImage?.original || attributes.coverImage?.large || null,
    episode_count: attributes.episodeCount || 0,
    rating: Number(attributes.averageRating || 0) / 10 || 0,
    season: attributes.season || null,
    year: startDate ? Number(startDate.slice(0, 4)) : null,
    status: statusMap[attributes.status] || 'upcoming',
    age_rating: attributes.ageRating || null,
    popularity: Number(attributes.popularityRank || 0),
    slug: attributes.slug || null,
    genres: [],
    source: 'kitsu',
  };
}

class KitsuProvider {
  async searchAnime(query, limit = 20) {
    const response = await request({ method: 'GET', url: `${BASE_URL}/anime`, params: { 'filter[text]': query, 'page[limit]': limit } });
    return (response.data?.data || []).map(normalize);
  }

  async getAnimeInfo(kitsuId) {
    const response = await request({ method: 'GET', url: `${BASE_URL}/anime/${encodeURIComponent(kitsuId)}` });
    return normalize(response.data.data);
  }
}

module.exports = { KitsuProvider };

const catalogue = require('../services/catalogueService');
const cache = require('../utils/cacheService');
const { KitsuProvider } = require('../services/kitsuProvider');
const kitsu = new KitsuProvider();

exports.search = async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.status(400).json({ message: 'A search query is required.' });
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const cacheKey = `provider:kitsu:search:${query.toLowerCase()}:${limit}`;
    let results = await cache.get(cacheKey);
    if (!results) {
      results = await kitsu.searchAnime(query, limit);
      results = results.map(item => ({ ...item, id: item.kitsu_id }));
      await cache.set(cacheKey, results, 24 * 60 * 60);
    }
    res.json(results);
  }
  catch (error) { console.error('Catalogue search failed:', error.message); res.status(502).json({ message: 'Catalogue search is temporarily unavailable.' }); }
};
exports.getEpisodes = async (req, res) => { try { res.json(await catalogue.getEpisodes(Number(req.params.id))); } catch (error) { console.error('Episode lookup failed:', error.message); res.status(502).json({ message: 'Episodes are temporarily unavailable.' }); } };
exports.getStream = async (req, res) => { try { const stream = await catalogue.getStream(Number(req.params.id), req.params.episode); if (!stream?.video_url) return res.status(404).json({ message: 'No stream is currently available for this episode.' }); res.json(stream); } catch (error) { console.error('Stream lookup failed:', error.message); res.status(502).json({ message: 'Streaming source is temporarily unavailable.' }); } };

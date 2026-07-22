const catalogue = require('../services/catalogueService');

exports.search = async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.status(400).json({ message: 'A search query is required.' });
  try { res.json(await catalogue.search(query, Math.min(Number(req.query.limit) || 20, 50))); }
  catch (error) { console.error('Catalogue search failed:', error.message); res.status(502).json({ message: 'Catalogue search is temporarily unavailable.' }); }
};
exports.getEpisodes = async (req, res) => { try { res.json(await catalogue.getEpisodes(Number(req.params.id))); } catch (error) { console.error('Episode lookup failed:', error.message); res.status(502).json({ message: 'Episodes are temporarily unavailable.' }); } };
exports.getStream = async (req, res) => { try { const stream = await catalogue.getStream(Number(req.params.id), req.params.episode); if (!stream?.video_url) return res.status(404).json({ message: 'No stream is currently available for this episode.' }); res.json(stream); } catch (error) { console.error('Stream lookup failed:', error.message); res.status(502).json({ message: 'Streaming source is temporarily unavailable.' }); } };

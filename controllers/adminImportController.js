const db = require('../config/db');
const catalogue = require('../services/catalogueService');
const { ConsumetProvider } = require('../services/consumetProvider');

const consumet = new ConsumetProvider();

// Protected by router.use(protect, adminOnly) in routes/adminRoutes.js.
exports.importAnime = async (req, res) => {
  const kitsuId = String(req.body?.kitsuId || '').trim();
  if (!kitsuId) return res.status(400).json({ message: 'kitsuId is required.' });

  try {
    // Step 1: Import anime metadata + resolve gogoanime mapping
    const result = await catalogue.importFromKitsu(kitsuId);
    const animeId = result.anime.id;
    const slug = result.mapping?.slug || null;

    let episodesInserted = 0;

    // Step 2: If slug is resolved and Consumet is configured, fetch & bulk-insert episodes
    if (slug && consumet.configured()) {
      try {
        // Fetch episode list from Consumet microservice
        const episodeList = await consumet.getEpisodes(slug);

        if (Array.isArray(episodeList) && episodeList.length > 0) {
          // Map to 2D array: (anime_id, episode_number, consumet_id, title)
          const values = episodeList.map((ep, index) => [
            animeId,
            ep.number || index + 1,
            ep.id || null,
            ep.title || `Episode ${ep.number || index + 1}`,
          ]);

          // Bulk insert all episodes in a single query (INSERT IGNORE skips duplicates)
          const [insertResult] = await db.query(
            'INSERT IGNORE INTO episodes (anime_id, episode_number, consumet_id, title) VALUES ?',
            [values]
          );
          episodesInserted = insertResult.affectedRows;
        }
      } catch (episodeError) {
        // Log episode fetch/insert error but do NOT fail the overall import
        console.error('Episode import warning (non-fatal):', episodeError.message);
      }
    }

    return res.status(201).json({
      success: true,
      anime: result.anime,
      mapping: result.mapping,
      episodes: {
        count: episodesInserted,
        source: 'consumet',
      },
    });
  } catch (error) {
    console.error('Kitsu anime import failed:', error.message);
    return res.status(502).json({ success: false, message: 'Unable to import anime metadata right now.' });
  }
};

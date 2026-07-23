const axios = require('axios');
const db = require('../config/db');
const catalogue = require('../services/catalogueService');

/**
 * Helper function to bulk-insert episodes into MySQL
 */
const bulkInsertEpisodes = async (animeId, episodes) => {
  if (!episodes || episodes.length === 0) return 0;

  // Format array for MySQL multi-row insert: [[anime_id, episode_number, title, consumet_id], ...]
  const values = episodes.map((ep) => [
    animeId,
    ep.number || null,
    ep.title || `Episode ${ep.number}`,
    ep.id || null
  ]);

  const sql = `
    INSERT IGNORE INTO episodes (anime_id, episode_number, title, consumet_id)
    VALUES ?
  `;

  const [result] = await db.query(sql, [values]);
  return result.affectedRows;
};

/**
 * Admin Import Anime & Bulk Episode Fetch Controller
 * Protected by router.use(protect, adminOnly) in routes/adminRoutes.js.
 */
exports.importAnime = async (req, res) => {
  const kitsuId = String(req.body?.kitsuId || '').trim();
  if (!kitsuId) return res.status(400).json({ message: 'kitsuId is required.' });

  try {
    console.log(`[IMPORT START] Processing Kitsu ID: ${kitsuId}`);

    // Step 1: Import anime metadata from Kitsu + resolve MalSync slug
    const result = await catalogue.importFromKitsu(kitsuId);
    const animeId = result.anime.id;

    console.log(`[IMPORT CHECKPOINT 1] Anime ID ${animeId} resolved.`);

    // Step 2: Fetch episodes directly from the official Kitsu API (no Cloudflare, always works)
    console.log(`[IMPORT FETCH] Bypassing Consumet. Fetching episodes directly from Kitsu API...`);

    const kitsuResponse = await axios.get(
      `https://kitsu.io/api/edge/anime/${kitsuId}/episodes?page[limit]=100`
    );

    if (!kitsuResponse.data || !kitsuResponse.data.data || kitsuResponse.data.data.length === 0) {
      throw new Error('Kitsu returned no episodes for this anime.');
    }

    // Map the Kitsu response to match the database bulk insert structure
    const episodes = kitsuResponse.data.data.map(ep => ({
      number: ep.attributes.number,
      title: ep.attributes.titles?.en_jp || ep.attributes.canonicalTitle || `Episode ${ep.attributes.number}`,
      id: null // Kept null for dynamic stream resolving later
    }));

    const episodesCount = episodes.length;
    console.log(`✅ [IMPORT SUCCESS] Fetched ${episodesCount} episodes safely from Kitsu API!`);

    // Step 3: Bulk Save Episodes to Database in a single query
    const insertedCount = await bulkInsertEpisodes(animeId, episodes);
    console.log(`[IMPORT SUCCESS] Saved ${insertedCount} new episodes to MySQL database.`);

    return res.status(201).json({
      success: true,
      message: `Successfully imported anime and saved ${insertedCount} episodes via Kitsu API.`,
      anime: result.anime,
      mapping: result.mapping,
      episodes: {
        count: insertedCount,
        total: episodesCount,
        source: 'kitsu'
      }
    });

  } catch (error) {
    console.error('[IMPORT ERROR]', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to complete anime import.',
      error: error.message
    });
  }
};


const axios = require('axios');
const db = require('../config/db');
const catalogue = require('../services/catalogueService');

/**
 * Helper function to bulk-insert episodes into MySQL
 */
async function bulkInsertEpisodes(animeId, episodes) {
  if (!episodes || episodes.length === 0) return;

  const sql = `
    INSERT IGNORE INTO episodes (anime_id, episode_number, title)
    VALUES ?
  `;

  const values = episodes.map(ep => [
    animeId,
    ep.number,
    ep.title
  ]);

  await db.query(sql, [values]);
}

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

    let allEpisodes = [];
    let nextUrl = `https://kitsu.io/api/edge/anime/${kitsuId}/episodes?page[limit]=20&page[offset]=0`;

    // Loop through Kitsu's paginated responses until all episodes are fetched
    while (nextUrl) {
      const kitsuResponse = await axios.get(nextUrl);

      if (!kitsuResponse.data || !kitsuResponse.data.data) {
        break;
      }

      // Map the current batch of episodes
      const episodesBatch = kitsuResponse.data.data.map(ep => ({
        number: ep.attributes.number,
        title: ep.attributes.titles?.en_jp || ep.attributes.canonicalTitle || `Episode ${ep.attributes.number}`,
        id: null // Kept null for dynamic stream resolving later
      }));

      allEpisodes = allEpisodes.concat(episodesBatch);

      // Check if Kitsu provided a URL for the next page of episodes
      nextUrl = kitsuResponse.data.links && kitsuResponse.data.links.next
        ? kitsuResponse.data.links.next
        : null;
    }

    if (allEpisodes.length === 0) {
      throw new Error('Kitsu returned no episodes for this anime.');
    }

    const episodes = allEpisodes;
    const episodesCount = episodes.length;
    console.log(`✅ [IMPORT SUCCESS] Fetched ${episodesCount} episodes safely from Kitsu API!`);

    // Step 3: Bulk Save Episodes to Database in a single query
    await bulkInsertEpisodes(animeId, episodes);
    console.log(`[IMPORT SUCCESS] Saved ${episodesCount} new episodes to MySQL database.`);

    return res.status(201).json({
      success: true,
      message: `Successfully imported anime and saved ${episodesCount} episodes via Kitsu API.`,
      anime: result.anime,
      mapping: result.mapping,
      episodes: {
        count: episodesCount,
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


const db = require('../config/db');
const catalogue = require('../services/catalogueService');

const consumet = require('@consumet/extensions');
// Fallback safely in case of export changes
const META = consumet.META || consumet.default?.META || consumet.PROVIDERS?.META;
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

if (!META || !META.Anilist || !ANIME || !ANIME.AnimePahe) {
  console.error('Available META providers:', Object.keys(META || {}));
  console.error('Available ANIME providers:', Object.keys(ANIME || {}));
  throw new Error('Failed to extract required providers (META.Anilist + ANIME.AnimePahe) from @consumet/extensions.');
}

console.log('✅ Successfully loaded META.Anilist with ANIME.AnimePahe fallback');

// Inject AnimePahe as the dedicated episode scraper for Anilist
// This prevents Consumet from defaulting to Hianime (which is blocked on Render)
const fallbackProvider = new ANIME.AnimePahe();
const anilist = new META.Anilist(fallbackProvider);

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
    ep.id || null // Consumet episode ID (e.g. "naruto-episode-1")
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
    const animeTitle = result.anime?.title;

    console.log(`[IMPORT CHECKPOINT 1] Anime ID ${animeId} resolved.`);
    console.log(`[IMPORT CHECKPOINT 2] Title: "${animeTitle}"`);

    // Step 2: Search Anilist by title to get the Anilist ID
    console.log(`[IMPORT MAPPER] Searching Anilist provider for title: "${animeTitle}"...`);
    const searchResults = await anilist.search(animeTitle);

    if (!searchResults || !searchResults.results || searchResults.results.length === 0) {
      throw new Error('Anilist search returned no results.');
    }

    const anilistId = searchResults.results[0].id;
    console.log(`[IMPORT MAPPER] Found Anilist ID: ${anilistId}`);

    // Step 3: Fetch episode list from Anilist aggregator (no Cloudflare issues)
    console.log(`[IMPORT FETCH] Scraping episode list via Anilist...`);
    const animeDetails = await anilist.fetchAnimeInfo(anilistId);

    if (!animeDetails || !animeDetails.episodes || animeDetails.episodes.length === 0) {
      throw new Error('Anilist returned no episodes for this ID.');
    }

    console.log(`[IMPORT FETCH] Found ${animeDetails.episodes.length} episodes.`);

    // Step 4: Bulk Save Episodes to Database in a single query
    const insertedCount = await bulkInsertEpisodes(animeId, animeDetails.episodes);
    console.log(`[IMPORT SUCCESS] Saved ${insertedCount} new episodes to MySQL database.`);

    return res.status(201).json({
      success: true,
      message: `Successfully imported anime and saved ${insertedCount} episodes via META.Anilist.`,
      anime: result.anime,
      mapping: result.mapping,
      episodes: {
        count: insertedCount,
        total: animeDetails.episodes.length,
        source: 'anilist'
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


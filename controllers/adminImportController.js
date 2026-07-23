const db = require('../config/db');
const catalogue = require('../services/catalogueService');

const consumet = require('@consumet/extensions');
// Fallback safely in case of export changes
const META = consumet.META || consumet.default?.META || consumet.PROVIDERS?.META;
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

if (!META || !META.Anilist || !ANIME) {
  console.error('Available META providers:', Object.keys(META || {}));
  console.error('Available ANIME providers:', Object.keys(ANIME || {}));
  throw new Error('Failed to extract required providers from @consumet/extensions.');
}

console.log('✅ Successfully loaded providers (META.Anilist + ANIME fallbacks)');

// Base Anilist instance for search operations (search uses Anilist GraphQL directly)
const anilist = new META.Anilist();

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

    // Step 3: Robust fallback loop — try injecting different ANIME providers into Anilist
    const fallbackProviderNames = ['AnimeSama', 'AnimeKai', 'AnimeUnity', 'AnimeSaturn'];
    let animeDetails = null;

    console.log(`[IMPORT FETCH] Starting robust Anilist episode fetch loop...`);

    for (const providerName of fallbackProviderNames) {
      if (!ANIME[providerName]) continue;

      try {
        console.log(`[IMPORT FETCH] Injecting ${providerName} into Anilist...`);
        const injectedProvider = new ANIME[providerName]();
        const anilistInstance = new META.Anilist(injectedProvider);

        const result = await anilistInstance.fetchAnimeInfo(anilistId);

        if (result && result.episodes && result.episodes.length > 0) {
          animeDetails = result;
          console.log(`✅ [IMPORT SUCCESS] Successfully scraped ${result.episodes.length} episodes using Anilist + ${providerName}!`);
          break; // Stop the loop, we got the episodes!
        }
      } catch (err) {
        console.log(`⚠️ [SCRAPER WARN] Anilist with ${providerName} failed: ${err.message}. Trying next...`);
      }
    }

    // Final Guard Clause
    if (!animeDetails || !animeDetails.episodes || animeDetails.episodes.length === 0) {
      throw new Error('All injected Anilist providers failed. Cloudflare or DNS is blocking all current scrapers.');
    }

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


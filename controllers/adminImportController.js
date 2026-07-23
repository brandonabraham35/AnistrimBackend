const db = require('../config/db');
const catalogue = require('../services/catalogueService');

// Robust import pattern for @consumet/extensions — handles CommonJS vs ESM mismatches
const consumet = require('@consumet/extensions');

// Safely resolve the ANIME object regardless of the package version / export structure.
// Latest versions may export under: consumet.ANIME, consumet.default.ANIME, or consumet.PROVIDERS.ANIME.
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

if (!ANIME || !ANIME.Gogoanime) {
  console.error('Consumet Export Object:', Object.keys(consumet));
  throw new Error(
    'Failed to extract ANIME.Gogoanime from @consumet/extensions. See logs above for available exports.'
  );
}

// Initialize the Gogoanime provider directly in memory
const gogoanime = new ANIME.Gogoanime();

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

    // Step 1: Import anime metadata from Kitsu + resolve gogoanime slug via MalSync
    const result = await catalogue.importFromKitsu(kitsuId);
    const animeId = result.anime.id;
    const slug = result.mapping?.slug || null;

    console.log(`[IMPORT CHECKPOINT 1] Anime ID ${animeId} resolved.`);
    console.log(`[IMPORT CHECKPOINT 2] Gogoanime slug: ${slug || 'NONE — will attempt fallback search'}`);

    // Step 2: Determine Gogoanime Slug — fallback: search Consumet by title
    let resolvedSlug = slug;
    if (!resolvedSlug && result.anime?.title) {
      console.log(`[IMPORT MAPPER] Searching Consumet provider for title: "${result.anime.title}"...`);
      const searchResults = await gogoanime.search(result.anime.title);
      if (searchResults && searchResults.results && searchResults.results.length > 0) {
        resolvedSlug = searchResults.results[0].id;
        console.log(`[IMPORT MAPPER] Fallback search matched slug: "${resolvedSlug}"`);
      }
    }

    // Guard Clause: If still no slug, skip episode scraping safely
    if (!resolvedSlug) {
      console.log(`[IMPORT CHECKPOINT 2] SKIPPING episode fetch – No valid Gogoanime slug found.`);
      return res.status(200).json({
        success: true,
        message: 'Anime imported successfully, but no episode mapping could be found.',
        anime: result.anime,
        mapping: result.mapping,
        episodes: { count: 0, source: 'consumet' }
      });
    }

    // Step 3: In-Memory Episode Scraping via Consumet (no HTTP fetch)
    console.log(`[IMPORT FETCH] Scraping episode list for slug: "${resolvedSlug}" directly in memory...`);
    const animeDetails = await gogoanime.fetchAnimeInfo(resolvedSlug);

    if (!animeDetails || !animeDetails.episodes || animeDetails.episodes.length === 0) {
      console.log(`[IMPORT FETCH] Provider returned 0 episodes for slug: "${resolvedSlug}"`);
      return res.status(200).json({
        success: true,
        message: 'Anime imported, but provider returned no episodes.',
        anime: result.anime,
        mapping: result.mapping,
        episodes: { count: 0, source: 'consumet' }
      });
    }

    console.log(`[IMPORT FETCH] Found ${animeDetails.episodes.length} episodes.`);

    // Step 4: Bulk Save Episodes to Database in a single query
    const insertedCount = await bulkInsertEpisodes(animeId, animeDetails.episodes);
    console.log(`[IMPORT SUCCESS] Saved ${insertedCount} new episodes to MySQL database.`);

    return res.status(201).json({
      success: true,
      message: `Successfully imported anime and saved ${insertedCount} episodes.`,
      anime: result.anime,
      mapping: result.mapping,
      episodes: {
        count: insertedCount,
        total: animeDetails.episodes.length,
        source: 'consumet'
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


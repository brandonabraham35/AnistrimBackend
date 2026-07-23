const db = require('../config/db');
const catalogue = require('../services/catalogueService');

const consumet = require('@consumet/extensions');
const ANIME = consumet.ANIME || consumet.default?.ANIME || consumet.PROVIDERS?.ANIME;

if (!ANIME || !ANIME.Hianime) {
  console.error('Available ANIME providers in package:', Object.keys(ANIME));
  throw new Error('Failed to extract ANIME.Hianime from @consumet/extensions.');
}

console.log('✅ Successfully mapped provider to: ANIME.Hianime');

// Multi-provider fallback array — providers tried in order until one succeeds
const providers = [
  { instance: new ANIME.Hianime(),      name: 'Hianime' },
  { instance: new ANIME.AnimePahe(),    name: 'AnimePahe' },
  { instance: new ANIME.KickAssAnime(), name: 'KickAssAnime' },
];

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
 * Try to resolve a slug and fetch episodes across all available providers.
 * Returns { slug, episodes, providerName } or null if all fail.
 */
async function scrapeEpisodesWithFallback(animeTitle, existingSlug) {
  // If a slug was already resolved via MalSync, try it directly first
  if (existingSlug) {
    for (const { instance, name } of providers) {
      try {
        console.log(`[SCRAPER] Trying ${name} with slug: "${existingSlug}"...`);
        const info = await instance.fetchAnimeInfo(existingSlug);
        if (info && info.episodes && info.episodes.length > 0) {
          console.log(`[SCRAPER] ${name} returned ${info.episodes.length} episodes.`);
          return { slug: existingSlug, episodes: info.episodes, providerName: name };
        }
      } catch (err) {
        console.warn(`[SCRAPER WARN] ${name} failed for slug "${existingSlug}": ${err.message}. Trying next provider...`);
      }
    }
  }

  // No slug or all providers failed with the given slug — try searching by title
  if (animeTitle) {
    for (const { instance, name } of providers) {
      try {
        console.log(`[SCRAPER] Searching ${name} for title: "${animeTitle}"...`);
        const searchResults = await instance.search(animeTitle);
        if (searchResults && searchResults.results && searchResults.results.length > 0) {
          const foundSlug = searchResults.results[0].id;
          console.log(`[SCRAPER] ${name} matched slug: "${foundSlug}"`);

          const info = await instance.fetchAnimeInfo(foundSlug);
          if (info && info.episodes && info.episodes.length > 0) {
            console.log(`[SCRAPER] ${name} returned ${info.episodes.length} episodes.`);
            return { slug: foundSlug, episodes: info.episodes, providerName: name };
          }
        }
      } catch (err) {
        console.warn(`[SCRAPER WARN] ${name} search failed: ${err.message}. Trying next provider...`);
      }
    }
  }

  // All providers exhausted
  return null;
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
    const slug = result.mapping?.slug || null;

    console.log(`[IMPORT CHECKPOINT 1] Anime ID ${animeId} resolved.`);
    console.log(`[IMPORT CHECKPOINT 2] MalSync slug: ${slug || 'NONE'}`);

    // Step 2: Multi-provider episode scraping with fallback
    const scraped = await scrapeEpisodesWithFallback(result.anime?.title, slug);

    if (!scraped) {
      console.log(`[IMPORT CHECKPOINT 3] All providers failed — returning metadata-only import.`);
      return res.status(200).json({
        success: true,
        message: 'Anime metadata imported successfully, but episode scraping timed out across all providers.',
        anime: result.anime,
        mapping: result.mapping,
        episodes: { count: 0, source: 'none', note: 'All scrapers timed out' }
      });
    }

    console.log(`[IMPORT FETCH] Using ${scraped.providerName} — ${scraped.episodes.length} episodes found for slug: "${scraped.slug}"`);

    // Step 3: Bulk Save Episodes to Database in a single query
    const insertedCount = await bulkInsertEpisodes(animeId, scraped.episodes);
    console.log(`[IMPORT SUCCESS] Saved ${insertedCount} new episodes to MySQL database.`);

    return res.status(201).json({
      success: true,
      message: `Successfully imported anime and saved ${insertedCount} episodes via ${scraped.providerName}.`,
      anime: result.anime,
      mapping: result.mapping,
      episodes: {
        count: insertedCount,
        total: scraped.episodes.length,
        source: scraped.providerName.toLowerCase()
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


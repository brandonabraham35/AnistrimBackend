const db = require('../config/db');
const catalogue = require('../services/catalogueService');
const { ConsumetProvider } = require('../services/consumetProvider');

const consumet = new ConsumetProvider();

// Protected by router.use(protect, adminOnly) in routes/adminRoutes.js.
exports.importAnime = async (req, res) => {
  const kitsuId = String(req.body?.kitsuId || '').trim();
  if (!kitsuId) return res.status(400).json({ message: 'kitsuId is required.' });

  try {
    // ============ CHECKPOINT 1: Anime & Mapping Insertion ============
    const result = await catalogue.importFromKitsu(kitsuId);
    const animeId = result.anime.id;
    const slug = result.mapping?.slug || null;
    console.log(`[IMPORT CHECKPOINT 1] Anime inserted — ID: ${animeId}, Title: "${result.anime.title}"`);
    console.log(`[IMPORT CHECKPOINT 1] Mapping resolved — Provider: ${result.mapping?.provider || 'none'}, Slug: "${slug}", Resolved: ${result.mapping?.resolved}`);

    let episodesInserted = 0;

    // ============ CHECKPOINT 2: Slug & Consumet Configuration Check ============
    if (!slug) {
      console.log(`[IMPORT CHECKPOINT 2] SKIPPING episode fetch — No gogoanime slug resolved for kitsuId ${kitsuId}`);
    } else if (!consumet.configured()) {
      console.log(`[IMPORT CHECKPOINT 2] SKIPPING episode fetch — Consumet is NOT configured (CONSUMET_BASE_URL missing)`);
    } else {
      console.log(`[IMPORT CHECKPOINT 2] PROCEEDING to fetch episodes — Slug: "${slug}", Consumet URL: ${process.env.CONSUMET_BASE_URL || 'http://localhost:3001'}`);

      // ============ CHECKPOINT 3: Fetch from Consumet ============
      let episodeList;
      try {
        episodeList = await consumet.getEpisodes(slug);
        console.log(`[IMPORT CHECKPOINT 3] Consumet returned ${Array.isArray(episodeList) ? episodeList.length : typeof episodeList} episodes`);
        if (!Array.isArray(episodeList)) {
          console.log(`[IMPORT CHECKPOINT 3] WARNING — expected array, got ${typeof episodeList}:`, JSON.stringify(episodeList).substring(0, 200));
        }
      } catch (fetchError) {
        console.error(`[IMPORT CHECKPOINT 3] FAILED to fetch episodes from Consumet:`, fetchError.message);
        console.error(`[IMPORT CHECKPOINT 3] Endpoint attempted: ${(process.env.CONSUMET_BASE_URL || 'http://localhost:3001')}/anime/gogoanime/${slug}`);
        throw fetchError; // Re-throw — we want to see this in the outer catch
      }

      if (Array.isArray(episodeList) && episodeList.length > 0) {
        // Map to 2D array: (anime_id, episode_number, consumet_id, title)
        const values = episodeList.map((ep, index) => {
          const epNum = ep.number || index + 1;
          const epId  = ep.id || null;
          const epTitle = ep.title || `Episode ${epNum}`;
          // Log first 3 episodes for debugging
          if (index < 3) {
            console.log(`[IMPORT DEBUG] Episode ${index + 1}: number=${epNum}, consumet_id="${epId}", title="${epTitle}"`);
          }
          return [animeId, epNum, epId, epTitle];
        });

        console.log(`[IMPORT CHECKPOINT 4] Mapped ${values.length} episodes for bulk insert — first row sample:`, JSON.stringify(values[0]));

        // ============ CHECKPOINT 5: Execute Bulk Insert ============
        try {
          const [insertResult] = await db.query(
            'INSERT IGNORE INTO episodes (anime_id, episode_number, consumet_id, title) VALUES ?',
            [values]
          );
          episodesInserted = insertResult.affectedRows;
          console.log(`[IMPORT CHECKPOINT 5] Bulk insert succeeded — affectedRows: ${insertResult.affectedRows}, insertId: ${insertResult.insertId}`);
        } catch (sqlError) {
          console.error(`[IMPORT CHECKPOINT 5] SQL Episode Insert Error:`, sqlError.message);
          console.error(`[IMPORT CHECKPOINT 5] SQL Error code:`, sqlError.code);
          console.error(`[IMPORT CHECKPOINT 5] SQL Error number:`, sqlError.errno);
          console.error(`[IMPORT CHECKPOINT 5] SQL State:`, sqlError.sqlState);
          console.error(`[IMPORT CHECKPOINT 5] SQL:`, sqlError.sql);
          // Do NOT re-throw — episode failure should not kill the anime import
        }
      } else {
        console.log(`[IMPORT CHECKPOINT 4] No episodes to insert — episodeList is ${Array.isArray(episodeList) ? 'empty array' : 'not an array'}`);
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

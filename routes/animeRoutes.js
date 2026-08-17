// routes/animeRoutes.js
const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const anime   = require('../controllers/animeController');
const catalogue = require('../controllers/catalogueController');
const { ConsumetProvider } = require('../services/consumetProvider');
const { protect } = require('../middleware/auth');
const { PUBLIC_EPISODE_FILTER } = require('../utils/contentVisibility');
const episodeAccess = require('../utils/episodeAccess');

const consumet = new ConsumetProvider();

// Optional auth — attaches user context if a valid token is present, but never
// rejects unauthenticated callers. Used for public-but-masked endpoints.
// Handles both new-format tokens (uid/sid/tv/roles) and legacy tokens (id).
function optionalAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET, { algorithms: ['HS256'] });
      req.user = decoded;
      // Map uid → userId/id for new-format tokens.
      if (decoded.uid) {
        req.user.userId = decoded.uid;
        req.user.id = decoded.uid;
      }
      // New-format tokens carry roles[]; map admin role to isAdmin.
      if (Array.isArray(decoded.roles) && decoded.roles.includes('admin')) {
        req.user.isAdmin = true;
      }
    } catch(_) {}
  }
  next();
}

/**
 * GET /api/anime/kitsu/:kitsuId/episodes
 * Fetches the episode list from Consumet (in-memory) using the saved MalSync slug.
 * Uses a distinct /kitsu/ prefix to avoid conflicting with the internal
 * :id/episodes route below that uses internal DB integer IDs.
 */
router.get('/kitsu/:kitsuId/episodes', async (req, res) => {
    try {
        const { kitsuId } = req.params;

        // 1. Find the Consumet slug from our mapping table
        const [mappings] = await pool.query(
            'SELECT provider_slug FROM anime_mappings WHERE kitsu_id = ? LIMIT 1',
            [kitsuId]
        );

        if (mappings.length === 0) {
            return res.status(404).json({ error: 'Anime mapping not found. Import it first.' });
        }

        const slug = mappings[0].provider_slug;

        // 2. Fetch episodes from Consumet (in-memory, no HTTP call)
        const episodes = await consumet.getEpisodes(slug);

        return res.json({
            success: true,
            episodes: episodes || []
        });

    } catch (error) {
        console.error('[Episode Fetch Error]:', error.message);
        return res.status(500).json({ error: 'Failed to fetch episodes' });
    }
});

/**
 * GET /api/anime/:animeId/episodes
 * Fetches the episode list from our local database.
 * P0-3: Applies PUBLIC_EPISODE_FILTER, masks video_url/cloudinary_public_id for
 * non-entitled callers, and returns effectiveTier + locked for UI gating.
 */
router.get('/:animeId/episodes', optionalAuth, async (req, res) => {
    try {
        const { animeId } = req.params;

        // Fetch only published + available episodes (Phase 5 publication filter).
        const [episodes] = await pool.query(
            `SELECT e.* FROM episodes e
             JOIN anime a ON a.id = e.anime_id
             WHERE e.anime_id = ? AND ${PUBLIC_EPISODE_FILTER}
             ORDER BY e.episode_number ASC`,
            [animeId]
        );

        // Map + mask each episode. maskEpisode nulls video_url/cloudinary_public_id
        // for non-entitled callers and sets locked/premium flags.
        const mapped = [];
        for (const ep of episodes) {
            const masked = await episodeAccess.maskEpisode(ep, req.user);
            const tier = await episodeAccess.effectiveAccess(ep.id);
            mapped.push({
                id: masked.id,
                number: masked.episode_number,
                season: masked.season || 1,
                title: masked.title,
                description: masked.description,
                thumbnail_url: masked.thumbnail_url,
                video_url: masked.video_url || null,
                duration_sec: masked.duration_sec,
                is_premium: masked.premium || Boolean(masked.is_premium),
                view_count: masked.view_count,
                locked: masked.locked,
                effectiveTier: tier,
            });
        }

        return res.json(mapped);
    } catch (error) {
        console.error('[Local Episode Fetch Error]:', error.message);
        return res.status(500).json({ error: 'Failed to fetch episodes from database' });
    }
});

// Public (but protect adds user context if token present — optional auth)
// The mobile catalogue is backed by AniStrim's own MySQL records.  Do not
// make the home screen depend on an external provider being online.
router.get('/trending', anime.getTrending);
router.get('/latest',   anime.getLatest);
router.get('/recent',   anime.getLatest);
router.get('/popular',  anime.getTrending);
router.get('/featured', anime.getFeatured);
router.get('/search',           anime.search);
router.get('/genres',           anime.getGenres);
router.get('/search/advanced',  catalogue.advancedSearch);
router.get('/recommendations/:id', anime.getRecommendations);
router.get('/resolve/stream', anime.resolveStream);

// P0-2: Gate the stream endpoint behind protect + canWatch.
// The frontend does not use this route (it uses /api/stream/:animeTitle/:ep),
// but it must not remain an unauthenticated video_url leak.
router.get('/:id/stream/:episode', protect, catalogue.getStream);

// Optional auth — episodes show video_url only for premium users
router.get('/:id', (req, res, next) => {
  const auth = req.headers.authorization;
  if (auth) {
    const jwt = require('jsonwebtoken');
    try { req.user = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET, { algorithms: ['HS256'] }); } catch(_) {}
  }
  next();
}, anime.getById);

module.exports = router;
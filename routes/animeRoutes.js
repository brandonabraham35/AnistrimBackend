// routes/animeRoutes.js
const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const anime   = require('../controllers/animeController');
const catalogue = require('../controllers/catalogueController');
const { ConsumetProvider } = require('../services/consumetProvider');
const { protect } = require('../middleware/auth');

const consumet = new ConsumetProvider();

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
 * GET /api/anime/stream/:episodeId
 * Fetches the raw .m3u8 streaming links for the video player (in-memory, no HTTP call)
 */
router.get('/stream/:episodeId', async (req, res) => {
    try {
        const { episodeId } = req.params;

        // Fetch streaming links directly from Consumet (in-memory)
        const sources = await consumet.getSources(episodeId);

        return res.json({
            success: true,
            sources: sources?.sources || []
        });

    } catch (error) {
        console.error('[Stream Fetch Error]:', error.message);
        return res.status(500).json({ error: 'Failed to fetch streaming links' });
    }
});

/**
 * GET /api/anime/:animeId/episodes
 * Fetches the episode list instantly from our local database.
 * This is the "Fast Lane" — no external Consumet calls.
 * Returns a plain array so the frontend can consume it directly.
 */
router.get('/:animeId/episodes', async (req, res) => {
    try {
        const { animeId } = req.params;

        // Fetch directly from MySQL, sorted Episode 1 upward
        const [episodes] = await pool.query(
            'SELECT * FROM episodes WHERE anime_id = ? ORDER BY episode_number ASC',
            [animeId]
        );

        // Map database columns to frontend-friendly keys
        const mapped = episodes.map(ep => ({
            id: ep.id,
            number: ep.episode_number,
            title: ep.title,
            description: ep.description,
            thumbnail_url: ep.thumbnail_url,
            video_url: ep.video_url,
            duration_sec: ep.duration_sec,
            is_premium: Boolean(ep.is_premium),
            view_count: ep.view_count,
        }));

        return res.json(mapped);
    } catch (error) {
        console.error('[Local Episode Fetch Error]:', error.message);
        return res.status(500).json({ error: 'Failed to fetch episodes from database' });
    }
});

// Public (but protect adds user context if token present — optional auth)
router.get('/trending', anime.getTrending);
router.get('/latest',   anime.getLatest);
router.get('/recent',   anime.getLatest);
router.get('/popular',  anime.getTrending);
router.get('/featured', anime.getFeatured);
router.get('/search',   catalogue.search);
router.get('/recommendations/:id', anime.getRecommendations);
router.get('/resolve/stream', anime.resolveStream);
router.get('/:id/stream/:episode', catalogue.getStream);

// Optional auth — episodes show video_url only for premium users
router.get('/:id', (req, res, next) => {
  const auth = req.headers.authorization;
  if (auth) {
    const jwt = require('jsonwebtoken');
    try { req.user = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET); } catch(_) {}
  }
  next();
}, anime.getById);

module.exports = router;

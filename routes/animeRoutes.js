// routes/animeRoutes.js
const express = require('express');
const axios   = require('axios');
const router  = express.Router();
const pool    = require('../config/db');
const anime   = require('../controllers/animeController');
const catalogue = require('../controllers/catalogueController');
const { protect } = require('../middleware/auth');

// Consumet microservice URL — set CONSUMET_BASE_URL in .env for production
const CONSUMET_URL = process.env.CONSUMET_BASE_URL || 'http://localhost:3001';

/**
 * GET /api/anime/kitsu/:kitsuId/episodes
 * Fetches the episode list from Consumet using the saved MalSync slug.
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

        // 2. Fetch episodes from Consumet
        const consumetRes = await axios.get(`${CONSUMET_URL}/anime/gogoanime/${slug}`);

        return res.json({
            success: true,
            episodes: consumetRes.data.episodes || []
        });

    } catch (error) {
        console.error('[Episode Fetch Error]:', error.message);
        return res.status(500).json({ error: 'Failed to fetch episodes' });
    }
});

/**
 * GET /api/anime/stream/:episodeId
 * Fetches the raw .m3u8 streaming links for the video player
 */
router.get('/stream/:episodeId', async (req, res) => {
    try {
        const { episodeId } = req.params;

        // Fetch streaming links directly from Consumet
        const consumetRes = await axios.get(`${CONSUMET_URL}/anime/gogoanime/watch/${episodeId}`);

        return res.json({
            success: true,
            sources: consumetRes.data.sources || []
        });

    } catch (error) {
        console.error('[Stream Fetch Error]:', error.message);
        return res.status(500).json({ error: 'Failed to fetch streaming links' });
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
router.get('/:id/episodes', catalogue.getEpisodes);
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

// routes/animeRoutes.js
const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const anime   = require('../controllers/animeController');
const catalogue = require('../controllers/catalogueController');
const { ConsumetProvider } = require('../services/consumetProvider');
const { protect, optionalAuth } = require('../middleware/auth');
const { PUBLIC_EPISODE_FILTER } = require('../utils/contentVisibility');
const episodeAccess = require('../utils/episodeAccess');
const { sendSuccess } = require('../utils/response');

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

        return sendSuccess(res, { episodes: episodes || [] });

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
        // Explicit column whitelist — never SELECT *, so provider/internal fields
        // (cloudinary_public_id, animeheaven_episode_key, etc.) cannot leak.
        const [episodes] = await pool.query(
            `SELECT e.id, e.anime_id, e.episode_number, e.season, e.season_number, e.title, e.description,
                    e.thumbnail_url, e.video_url, e.duration_sec, e.view_count, e.is_premium,
                    e.access_tier, e.premium_until, e.created_at, e.updated_at
             FROM episodes e
             JOIN anime a ON a.id = e.anime_id
             WHERE e.anime_id = ? AND ${PUBLIC_EPISODE_FILTER}
             ORDER BY e.episode_number ASC`,
            [animeId]
        );

        // Map + mask each episode. maskEpisodes nulls video_url/cloudinary_public_id
        // for non-entitled callers and sets locked/premium flags.
        // Prompt 6: emit effectiveTier, locked, availableAt, AND accessState so
        // the frontend can distinguish free / premium-required / subscription-
        // expired / in-grace / scheduled-release. The frontend reads ONLY these
        // fields — never is_premium, never localStorage, never a JWT claim.
        const masked = await episodeAccess.maskEpisodes(episodes, req.user);

        const mapped = masked.map(m => ({
            id: m.id,
            number: m.episode_number,
            season: m.season || m.season_number || 1,
            title: m.title,
            description: m.description,
            thumbnailUrl: m.thumbnail_url,
            thumbnail_url: m.thumbnail_url,
            videoUrl: m.video_url || null,
            video_url: m.video_url || null,
            durationSec: m.duration_sec,
            duration_sec: m.duration_sec,
            isPremium: m.premium || Boolean(m.is_premium),
            is_premium: m.premium || Boolean(m.is_premium),
            viewCount: m.view_count,
            view_count: m.view_count,
            locked: m.locked,
            effectiveTier: m.effectiveTier,
            availableAt: m.availableAt,
            accessState: m.accessState,
            accessTier: m.access_tier || 'inherit',
        }));

        return sendSuccess(res, mapped);
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
router.get('/:id', optionalAuth, anime.getById);

module.exports = router;
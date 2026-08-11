// routes/watchRoutes.js
// Protected routes for video playback progress tracking
const express   = require('express');
const router    = express.Router();
const watchCtrl = require('../controllers/watchController');
const { protect } = require('../middleware/auth');

// ─── Public Routes (no auth required) ──────────────────────

// GET /api/watch/next/:animeId/:currentEpisodeNumber
// Resolves the next episode for auto-play / binge-watching
router.get('/next/:animeId/:currentEpisodeNumber', watchCtrl.resolveNextEpisode);

// GET /api/watch/skip-times/:malId/:episodeNumber
// Fetches OP/ED skip timestamps from AniSkip for "Skip Intro" button
router.get('/skip-times/:malId/:episodeNumber', watchCtrl.getEpisodeSkipTimes);

// ─── Protected Routes (auth required) ──────────────────────
router.use(protect);

// Save/update video playback progress
router.post('/progress', watchCtrl.saveProgress);

// Get saved progress for a specific anime episode
router.get('/progress/:animeId/:episodeNumber', watchCtrl.getProgress);

// Get "Continue Watching" list (in-progress episodes)
router.get('/continue-watching', watchCtrl.getContinueWatching);

// Get batch progress for all episodes of an anime (for watched/unwatched state in sidebar)
router.get('/progress/batch/:animeId', watchCtrl.getBatchProgress);

module.exports = router;


// routes/watchRoutes.js
// Protected routes for the Phase 3 authoritative watch progress model.
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
// Body: { episodeId, positionSec, durationSec, event }
router.put('/progress', watchCtrl.saveProgress);

// Get saved progress for a specific episode (by episodeId)
router.get('/progress/:episodeId', watchCtrl.getProgress);

// Get resolved skip markers for an episode (Phase 4.4 / Item 11)
router.get('/markers/:episodeId', watchCtrl.getEpisodeMarkers);

// Get progress for all episodes of an anime → map { episodeId: {...} }
router.get('/anime/:animeId/progress', watchCtrl.getAnimeProgress);

// Get "Continue Watching" list (one card per anime)
router.get('/continue-watching', watchCtrl.getContinueWatching);

// Dismiss an anime from the continue-watching rail
router.delete('/continue-watching/:animeId', watchCtrl.dismissContinueWatching);

// "Start over" — reset progress for an anime
router.post('/restart/:animeId', watchCtrl.restartAnime);

// Watch history (paginated)
router.get('/history', watchCtrl.getHistory);

// Clear all watch history
router.delete('/history', watchCtrl.clearHistory);

// Get batch progress for all episodes of an anime (legacy, for sidebar state)
router.get('/progress/batch/:animeId', watchCtrl.getBatchProgress);

module.exports = router;
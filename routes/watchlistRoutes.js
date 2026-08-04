// routes/watchlistRoutes.js
// Protected routes for user anime watchlist management.
// Episode progress tracking routes live in routes/watchRoutes.js.
const express   = require('express');
const router    = express.Router();
const wl        = require('../controllers/watchlistController');
const { protect } = require('../middleware/auth');

// All watchlist routes require authentication
router.use(protect);

// Compatibility alias: legacy frontend/mobile contract
router.post('/add', wl.addLegacyWatchlist);

// Add or update an anime in the watchlist (UPSERT)
router.post('/', wl.addOrUpdateWatchlist);

// Compatibility alias: old continue-watching endpoint
router.get('/continue', wl.getLegacyContinueWatching);

// Get the user's watchlist (optional ?status= filter)
router.get('/', wl.getWatchlist);

// Compatibility alias: profile stats endpoint
router.get('/stats', wl.getWatchlistStats);

// Compatibility alias: legacy progress save endpoint
router.post('/progress', wl.saveLegacyProgress);

// Compatibility alias: legacy progress lookup endpoint
router.get('/progress/:epId', wl.getLegacyProgress);

// Remove an anime from the watchlist
router.delete('/:animeId', wl.removeFromWatchlist);

module.exports = router;


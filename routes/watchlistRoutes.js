// routes/watchlistRoutes.js
// Protected routes for user anime watchlist management.
// Episode progress tracking routes live in routes/watchRoutes.js.
const express   = require('express');
const router    = express.Router();
const wl        = require('../controllers/watchlistController');
const { protect } = require('../middleware/auth');

// All watchlist routes require authentication
router.use(protect);

// Add or update an anime in the watchlist (UPSERT)
router.post('/', wl.addOrUpdateWatchlist);

// Get the user's watchlist (optional ?status= filter)
router.get('/', wl.getWatchlist);

// Remove an anime from the watchlist
router.delete('/:animeId', wl.removeFromWatchlist);

module.exports = router;


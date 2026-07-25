// routes/watchRoutes.js
// Protected routes for video playback progress tracking
const express   = require('express');
const router    = express.Router();
const watchCtrl = require('../controllers/watchController');
const { protect } = require('../middleware/auth');

// All watch routes require authentication
router.use(protect);

// Save/update video playback progress
router.post('/progress', watchCtrl.saveProgress);

// Get saved progress for a specific anime episode
router.get('/progress/:animeId/:episodeNumber', watchCtrl.getProgress);

module.exports = router;


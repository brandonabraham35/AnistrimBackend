// watchlistRoutes.js
const express   = require('express');
const router    = express.Router();
const wl        = require('../controllers/watchlistController');
const { protect } = require('../middleware/auth');

router.use(protect);

router.get('/',                      wl.getWatchlist);
router.get('/continue',              wl.getContinueWatching);   // FIX 2
router.get('/progress/:episodeId',   wl.getProgress);            // FIX 2
router.post('/add',                  wl.addToWatchlist);
router.post('/progress',             wl.saveProgress);            // FIX 2
router.put('/:animeId',              wl.updateWatchlist);
router.delete('/:animeId',           wl.removeFromWatchlist);

module.exports = router;

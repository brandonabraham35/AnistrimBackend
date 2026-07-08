// routes/adminRoutes.js
const express = require('express');
const router  = express.Router();
const admin   = require('../controllers/adminController');
const { protect, adminOnly } = require('../middleware/auth');

router.use(protect, adminOnly);

// Dashboard
router.get('/stats',                        admin.getDashboardStats);
router.get('/dashboard/overview',           admin.getDashboardOverview);

// Users
router.get('/users',                        admin.getAllUsers);
router.put('/users/:id',                    admin.updateUser);
// Deprecated: keeping togglePremium for compatibility if needed, but updateUser covers it
router.put('/users/:id/premium',            admin.updateUser);

// Anime CMS
router.get('/anime',                        admin.getAllAnime);
router.post('/anime',                       admin.createAnime);
router.put('/anime/:id',                    admin.updateAnime);
router.delete('/anime/:id',                 admin.deleteAnime);

// Genres
router.get('/genres',                       admin.getAllGenres);
router.post('/genres',                      admin.createGenre);
router.delete('/genres/:id',                admin.deleteGenre);

// Episodes
router.post('/anime/:animeId/episodes',     admin.addEpisode);
router.put('/episodes/:id',                 admin.updateEpisode);
router.delete('/episodes/:id',              admin.deleteEpisode);

// Settings
router.get('/settings',                     admin.getSettings);
router.put('/settings',                     admin.updateSettings);

// Ads
router.get('/ads',                          admin.getAds);
router.post('/ads',                         admin.createAd);
router.put('/ads/:id',                      admin.updateAd);
router.delete('/ads/:id',                   admin.deleteAd);

// Payments
router.put('/payments/:id',                 admin.updatePaymentStatus);

// Videos
router.get('/videos/:videoId/status',       admin.getVideoStatus);

// Logs
router.get('/logs',                         admin.getActivityLogs);

module.exports = router;

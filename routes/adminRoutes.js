// routes/adminRoutes.js
const express = require('express');
const router  = express.Router();
const admin   = require('../controllers/adminController');
const imports = require('../controllers/adminImportController');
const { protect, adminOnly } = require('../middleware/auth');
const { adminLimiter } = require('../middleware/rateLimit');

router.use(protect, adminOnly, adminLimiter);

// Dashboard
router.get('/stats',                        admin.getDashboardStats);
router.get('/dashboard/overview',           admin.getDashboardOverview);
router.get('/dashboard/health',             admin.getDashboardHealth);
router.get('/dashboard/health/history',     admin.getHealthMetrics);
router.get('/dashboard/health/metrics',     admin.getHealthMetrics);
router.get('/dashboard/charts/:type',       admin.getChartData);
router.get('/dashboard/activity/recent',    admin.getRecentActivity);
router.get('/dashboard/ads-metrics',        admin.getAdsMetrics);

// Audit Log (Phase 5.3, read-only, filterable)
router.get('/audit',                        admin.getAuditLogs);

// Users
router.get('/users',                        admin.getAllUsers);
router.get('/users/:id',                    admin.getUser);
router.get('/users/:id/watch-history',      admin.getUserWatchHistory);
router.get('/users/:id/login-history',      admin.getUserLoginHistory);
router.put('/users/:id',                    admin.updateUser);
// Deprecated: keeping togglePremium for compatibility if needed, but updateUser covers it
router.put('/users/:id/premium',            admin.updateUser);
router.post('/users/bulk-delete',           admin.bulkDeleteUsers);

// Anime CMS — literal-segment routes MUST be registered before :id routes
// so /anime/bulk, /anime/bulk-delete, /anime/import/search, /anime/import
// are never captured by /anime/:id. All :id params are constrained to digits.
router.get('/anime',                        admin.getAllAnime);
router.post('/anime',                       admin.createAnime);
router.put('/anime/bulk',                   admin.bulkUpdateAnime);
router.post('/anime/bulk-delete',           admin.bulkDeleteAnime);
router.get('/anime/import/search',          imports.searchConsumet);
router.post('/anime/import',                imports.importConsumetAnime);
router.get('/anime/:id',                    admin.getAnimeById);
router.put('/anime/:id',                    admin.updateAnime);
router.delete('/anime/:id',                 admin.deleteAnime);
router.put('/anime/:id/sync',               imports.syncConsumetAnime);
router.post('/import-anime',                imports.importAnime);

// ── AnimeHeaven Import & Sync (Phase 6 & 7) ────────────────
router.get('/animeheaven/search',           imports.searchAnimeHeaven);
router.get('/animeheaven/preview/:identifier', imports.previewAnimeHeaven);
router.post('/animeheaven/import',          imports.importAnimeHeaven);
router.post('/animeheaven/sync/:animeId',   imports.syncAnimeHeaven);
router.get('/animeheaven/status/:animeId',  imports.getAnimeHeavenStatus);
router.get('/animeheaven/playback-ready/:animeId', imports.getAnimeHeavenPlaybackReady);

// ── AnimeHeaven Catalog Service (primary catalog provider) ─
router.get('/animeheaven/catalog/status',   imports.getAnimeHeavenCatalogStatus);
router.post('/animeheaven/bulk-import',     imports.bulkImportAnimeHeaven);
router.post('/animeheaven/bulk-sync',       imports.bulkSyncAnimeHeaven);
router.get('/animeheaven/missing',          imports.getAnimeHeavenMissing);
router.post('/animeheaven/daily-refresh',   imports.runAnimeHeavenDailyRefresh);

// Genres
router.get('/genres',                       admin.getAllGenres);
router.post('/genres',                      admin.createGenre);
router.put('/genres/:id',                   admin.updateGenre);
router.delete('/genres/:id',                admin.deleteGenre);

// Episodes
router.post('/anime/:animeId/episodes',     admin.addEpisode);
router.get('/anime/:animeId/episodes',      admin.getAnimeEpisodes);
router.get('/episodes',                     admin.getAllEpisodes);
router.get('/episodes/:id',                 admin.getEpisode);
router.put('/episodes/:id',                 admin.updateEpisode);
router.delete('/episodes/:id',              admin.deleteEpisode);
router.post('/episodes/bulk-delete',        admin.bulkDeleteEpisodes);
// Stream Diagnostic (Phase 6 — read-only cached stream inspection)
router.get('/streams/:episodeId/diagnostic', admin.getStreamDiagnostic);
// Stream Observation (Phase 6 — empirical URL lifetime tracking)
router.post('/streams/sync/:animeId', admin.syncStreamObservation);
router.get('/streams/observation/:episodeId', admin.getStreamObservationReport);

// Settings
router.get('/settings',                     admin.getSettings);
router.put('/settings',                     admin.updateSettings);

// Ads
router.get('/ads',                          admin.getAds);
router.post('/ads',                         admin.createAd);
router.put('/ads/:id',                      admin.updateAd);
router.delete('/ads/:id',                   admin.deleteAd);

// Payments
router.get('/payments',                     admin.getPayments);
router.put('/payments/:id',                 admin.updatePaymentStatus);

// Logs
router.get('/logs',                         admin.getActivityLogs);

module.exports = router;

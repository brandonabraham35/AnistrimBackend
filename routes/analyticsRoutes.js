// routes/analyticsRoutes.js — analytics event ingestion + admin analytics.
//
// Public event submission (authenticated):
//   POST /api/analytics/events
//
// Admin analytics (protect + adminOnly):
//   GET /api/admin/analytics/overview
//   GET /api/admin/analytics/views
//   GET /api/admin/analytics/searches
//   GET /api/admin/analytics/activity
//   GET /api/admin/analytics/users
const express = require('express');
const router = express.Router();
const analytics = require('../controllers/analyticsController');
const { protect, adminOnly } = require('../middleware/auth');
const { eventLimiter } = require('../middleware/rateLimit');

// Public event recording (rate-limited, authenticated)
router.post('/events', protect, eventLimiter, analytics.recordEvents);

// Admin analytics (all require admin role)
router.use(protect, adminOnly);
router.get('/overview', analytics.getOverview);
router.get('/views', analytics.getViews);
router.get('/searches', analytics.getSearches);
router.get('/activity', analytics.getActivity);
router.get('/users', analytics.getUsers);
router.get('/stream-cache', analytics.getStreamCacheMetrics);

module.exports = router;

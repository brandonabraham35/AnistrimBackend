// routes/homeShelfRoutes.js
const express = require('express');
const router = express.Router();
const homeShelf = require('../controllers/homeShelfController');
const recommendations = require('../controllers/recommendationController');
const { protect, adminOnly } = require('../middleware/auth');

/**
 * GET /api/home/sections
 * Public — returns the four categorized home sections (cached).
 */
router.get('/sections', homeShelf.getSections);

/**
 * GET /api/home/recommendations
 * Protected — returns the user's personalised "For You" shelf with reasons.
 * Cold-start: computes on demand if no materialised rows exist.
 */
router.get('/recommendations', protect, recommendations.getRecommendations);

/**
 * POST /api/home/recommendations/refresh
 * Protected — forces a recompute for the current user.
 */
router.post('/recommendations/refresh', protect, recommendations.refresh);

/**
 * POST /api/home/refresh
 * Admin only — forces a complete rebuild of all sections.
 */
router.post('/refresh', protect, adminOnly, homeShelf.refresh);

module.exports = router;

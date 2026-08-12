// routes/homeShelfRoutes.js
const express = require('express');
const router = express.Router();
const homeShelf = require('../controllers/homeShelfController');
const { protect, adminOnly } = require('../middleware/auth');

/**
 * GET /api/home/sections
 * Public — returns the four categorized home sections (cached).
 */
router.get('/sections', homeShelf.getSections);

/**
 * POST /api/home/refresh
 * Admin only — forces a complete rebuild of all sections.
 */
router.post('/refresh', protect, adminOnly, homeShelf.refresh);

module.exports = router;
// controllers/homeShelfController.js
//
// HTTP layer for the automatic home-page section builder.
// Exposes the four categorized sections (trending, popular, new releases,
// classics) as a single cached payload, plus an admin-only refresh endpoint.

const homeShelf = require('../services/homeShelfService');
const { sendSuccess } = require('../utils/response');

/**
 * GET /api/home/sections
 * Returns the four categorized home sections (cached).
 */
exports.getSections = async (req, res) => {
  try {
    const shelf = await homeShelf.getHomeShelf();
    return sendSuccess(res, shelf);
  } catch (error) {
    console.error('[HomeShelf] getSections error:', error.message);
    res.status(500).json({ message: 'Failed to load home sections.' });
  }
};

/**
 * POST /api/home/refresh
 * Forces a rebuild of the sections and refreshes the cache.
 * Intended for admin use (protected by the admin middleware in the route).
 */
exports.refresh = async (req, res) => {
  try {
    const shelf = await homeShelf.refreshHomeShelf();
    return sendSuccess(res, shelf, { message: 'Home sections refreshed.' });
  } catch (error) {
    console.error('[HomeShelf] refresh error:', error.message);
    res.status(500).json({ message: 'Failed to refresh home sections.' });
  }
};
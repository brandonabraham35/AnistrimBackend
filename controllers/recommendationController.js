// controllers/recommendationController.js — HTTP layer for the recommendation engine.
//
// GET /api/home/recommendations (protected) → getRecommendationsForUser(req.userId)
//   Returns the user's personalised "For You" shelf with each item's reason.
//   Cold-start: if the user has no materialised rows, computes on demand.

const recommendationService = require('../services/recommendationService');
const { sendSuccess } = require('../utils/response');

/**
 * GET /api/home/recommendations
 * Protected — returns the user's personalised recommendations.
 * Each item includes `reason` (e.g. "Because you watched Attack on Titan").
 */
exports.getRecommendations = async (req, res) => {
  try {
    const userId = req.userId ?? req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Not authenticated.' });

    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const items = await recommendationService.getRecommendationsForUser(userId, limit);

    return sendSuccess(res, { items, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[Recommendations] getRecommendations error:', error.message);
    res.status(500).json({ message: 'Failed to load recommendations.' });
  }
};

/**
 * POST /api/home/recommendations/refresh
 * Protected — forces a recompute for the current user (on-demand).
 */
exports.refresh = async (req, res) => {
  try {
    const userId = req.userId ?? req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Not authenticated.' });

    await recommendationService.computeRecommendationsForUser(userId);
    const items = await recommendationService.getRecommendationsForUser(userId, 20);

    return sendSuccess(res, { items, generatedAt: new Date().toISOString() }, { message: 'Recommendations refreshed.' });
  } catch (error) {
    console.error('[Recommendations] refresh error:', error.message);
    res.status(500).json({ message: 'Failed to refresh recommendations.' });
  }
};
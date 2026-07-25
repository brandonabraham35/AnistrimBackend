// controllers/watchlistController.js
// Category-based anime watchlist — save, categorize, and manage shows.
// Episode progress tracking has been moved to controllers/watchController.js.
const db = require('../config/db');

/**
 * POST /api/watchlist
 * Body: { animeId, animeTitle, animeCover, status }
 * Adds a show to the user's watchlist or updates its status/metadata.
 * Uses INSERT ... ON DUPLICATE KEY UPDATE for idempotent UPSERT.
 */
exports.addOrUpdateWatchlist = async (req, res) => {
  try {
    const userId = req.user.id;
    const { animeId, animeTitle, animeCover, status } = req.body;

    if (!animeId) {
      return res.status(400).json({ message: 'animeId is required.' });
    }

    const validStatuses = ['WATCHING', 'COMPLETED', 'ON_HOLD', 'DROPPED', 'PLAN_TO_WATCH'];
    const resolvedStatus = validStatuses.includes(status) ? status : 'PLAN_TO_WATCH';

    await db.query(
      `INSERT INTO user_watchlists (user_id, anime_id, anime_title, anime_cover, status)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status      = VALUES(status),
         anime_title = VALUES(anime_title),
         anime_cover = VALUES(anime_cover),
         updated_at  = CURRENT_TIMESTAMP`,
      [userId, animeId, animeTitle || null, animeCover || null, resolvedStatus]
    );

    res.json({ message: 'Watchlist updated successfully.' });
  } catch (err) {
    console.error('[WatchlistController] addOrUpdateWatchlist error:', err.message);
    res.status(500).json({ message: 'Failed to update watchlist.' });
  }
};

/**
 * GET /api/watchlist?status=WATCHING
 * Fetches the logged-in user's watchlist.
 * Optional query param: status — filter results by status value.
 * Ordered by most recently updated first.
 */
exports.getWatchlist = async (req, res) => {
  try {
    const userId = req.user.id;
    const { status } = req.query;

    let sql = `SELECT id, anime_id, anime_title, anime_cover, status, created_at, updated_at
               FROM user_watchlists
               WHERE user_id = ?`;
    const params = [userId];

    if (status) {
      const validStatuses = ['WATCHING', 'COMPLETED', 'ON_HOLD', 'DROPPED', 'PLAN_TO_WATCH'];
      const upper = status.toUpperCase();
      if (validStatuses.includes(upper)) {
        sql += ` AND status = ?`;
        params.push(upper);
      }
    }

    sql += ` ORDER BY updated_at DESC`;

    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('[WatchlistController] getWatchlist error:', err.message);
    res.status(500).json({ message: 'Failed to fetch watchlist.' });
  }
};

/**
 * DELETE /api/watchlist/:animeId
 * Removes a specific anime from the logged-in user's watchlist.
 */
exports.removeFromWatchlist = async (req, res) => {
  try {
    const userId = req.user.id;
    const { animeId } = req.params;

    if (!animeId) {
      return res.status(400).json({ message: 'animeId is required.' });
    }

    await db.query(
      `DELETE FROM user_watchlists WHERE user_id = ? AND anime_id = ?`,
      [userId, animeId]
    );

    res.json({ message: 'Removed from watchlist.' });
  } catch (err) {
    console.error('[WatchlistController] removeFromWatchlist error:', err.message);
    res.status(500).json({ message: 'Failed to remove from watchlist.' });
  }
};


// controllers/watchlistController.js
// Category-based anime watchlist — save, categorize, and manage shows.
// Episode progress tracking has been moved to controllers/watchController.js.
const db = require('../config/db');
const watchCtrl = require('./watchController');

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
 * POST /api/watchlist/add
 * Legacy compatibility wrapper for the old client contract.
 */
exports.addLegacyWatchlist = async (req, res) => {
  try {
    const { animeId } = req.body || {};
    if (!animeId) {
      return res.status(400).json({ message: 'animeId is required.' });
    }

    const [animeRows] = await db.query(
      'SELECT title, cover_image FROM anime WHERE id = ?',
      [animeId]
    );

    req.body = {
      animeId,
      animeTitle: animeRows[0]?.title || `Anime-${animeId}`,
      animeCover: animeRows[0]?.cover_image || null,
      status: req.body?.status || 'PLAN_TO_WATCH',
    };

    return exports.addOrUpdateWatchlist(req, res);
  } catch (err) {
    console.error('[WatchlistController] addLegacyWatchlist error:', err.message);
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

/**
 * GET /api/watchlist/stats
 * Compatibility endpoint for legacy profile UI.
 */
exports.getWatchlistStats = async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await db.query(
      `SELECT
         SUM(CASE WHEN status = 'WATCHING' THEN 1 ELSE 0 END) AS watching,
         SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'PLAN_TO_WATCH' THEN 1 ELSE 0 END) AS plan_to_watch,
         COUNT(*) AS total
       FROM user_watchlists
       WHERE user_id = ?`,
      [userId]
    );

    const statRow = rows[0] || {};
    res.json({
      watching: Number(statRow.watching || 0),
      completed: Number(statRow.completed || 0),
      plan_to_watch: Number(statRow.plan_to_watch || 0),
      total: Number(statRow.total || 0),
    });
  } catch (err) {
    console.error('[WatchlistController] getWatchlistStats error:', err.message);
    res.status(500).json({ message: 'Failed to fetch watchlist stats.' });
  }
};

/**
 * GET /api/watchlist/continue
 * Compatibility alias for the old legacy contract consumed by the frontend.
 */
exports.getLegacyContinueWatching = async (req, res) => {
  try {
    const legacyRows = [];
    const uaReq = { user: req.user, query: req.query, params: req.params };
    const canonicalResponse = await new Promise((resolve, reject) => {
      const fakeRes = {
        json: (payload) => resolve(payload),
        status: (code) => ({ json: (payload) => reject(Object.assign(new Error(`status:${code}`), { statusCode: code, payload })) }),
      };
      watchCtrl.getContinueWatching(uaReq, fakeRes);
    });

    for (const item of canonicalResponse || []) {
      legacyRows.push({
        anime_id: item.animeId,
        title: item.animeTitle,
        cover_image: item.animeCoverImage,
        rating: 0,
        episode_number: item.episodeNumber,
        progress_sec: item.progressSeconds || 0,
        duration_sec: item.totalDurationSeconds || 1440,
      });
    }

    return res.json(legacyRows);
  } catch (err) {
    console.error('[WatchlistController] getLegacyContinueWatching error:', err.message);
    res.status(500).json({ message: 'Failed to fetch continue watching list.' });
  }
};

/**
 * GET /api/watchlist/progress/:epId
 * Compatibility alias for the legacy progress contract.
 */
exports.getLegacyProgress = async (req, res) => {
  try {
    const { epId } = req.params;
    const [episodeRows] = await db.query(
      'SELECT anime_id, episode_number FROM episodes WHERE id = ?',
      [epId]
    );

    if (!episodeRows.length) {
      return res.status(404).json({ message: 'Episode not found.' });
    }

    const legacyReq = {
      user: req.user,
      params: {
        animeId: episodeRows[0].anime_id,
        episodeNumber: episodeRows[0].episode_number,
      },
    };

    const legacyRes = {
      json: (payload) => {
        const completed = Number(payload?.progressSeconds || 0) > 0 && payload?.totalDurationSeconds > 0 && Number(payload.progressSeconds) >= Number(payload.totalDurationSeconds)
          ? 1
          : 0;
        return res.json({
          progress_sec: Number(payload?.progressSeconds || 0),
          completed,
        });
      },
      status: (code) => ({ json: (payload) => res.status(code).json(payload) }),
    };

    return watchCtrl.getProgress(legacyReq, legacyRes);
  } catch (err) {
    console.error('[WatchlistController] getLegacyProgress error:', err.message);
    res.status(500).json({ message: 'Failed to fetch progress.' });
  }
};

/**
 * POST /api/watchlist/progress
 * Compatibility alias that accepts the legacy payload and delegates to the new controller.
 */
exports.saveLegacyProgress = async (req, res) => {
  try {
    const { episodeId, progressSec, completed, durationSec } = req.body || {};

    if (!episodeId) {
      return res.status(400).json({ message: 'episodeId is required.' });
    }

    const [episodeRows] = await db.query(
      'SELECT anime_id, episode_number, duration_sec FROM episodes WHERE id = ?',
      [episodeId]
    );

    if (!episodeRows.length) {
      return res.status(404).json({ message: 'Episode not found.' });
    }

    const progressSeconds = Number(progressSec || 0);
    const totalDurationSeconds = Number(durationSec || episodeRows[0].duration_sec || 0);

    req.body = {
      animeId: episodeRows[0].anime_id,
      episodeNumber: episodeRows[0].episode_number,
      episodeId: Number(episodeId),
      progressSeconds,
      totalDurationSeconds,
    };

    return watchCtrl.saveProgress(req, res);
  } catch (err) {
    console.error('[WatchlistController] saveLegacyProgress error:', err.message);
    res.status(500).json({ message: 'Failed to save progress.' });
  }
};

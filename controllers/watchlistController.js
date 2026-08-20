// controllers/watchlistController.js
// Category-based anime watchlist — save, categorize, and manage shows.
// Episode progress tracking has been moved to controllers/watchController.js.
const db = require('../config/db');
const { sendSuccess } = require('../utils/response');
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

    return sendSuccess(res, null, { message: 'Watchlist updated successfully.' });
  } catch (err) {
    console.error('[WatchlistController] addOrUpdateWatchlist error:', err.message);
    return res.status(500).json({ message: 'Failed to update watchlist.' });
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
    return res.status(500).json({ message: 'Failed to update watchlist.' });
  }
};

/**
 * POST /api/watchlist/:animeId
 * Optimistic My List toggle — adds (or updates status of) + removes.
 * Body: { status } optional (defaults to 'PLAN_TO_WATCH')
 * Returns { inList: bool, status } for optimistic UI rollback.
 */
exports.toggleWatchlist = async (req, res) => {
  try {
    const userId = req.user.id;
    const { animeId } = req.params;
    const { status } = req.body || {};

    if (!animeId) {
      return res.status(400).json({ message: 'animeId is required.' });
    }

    // If it's already in the list, remove it (toggle off).
    const [existing] = await db.query(
      'SELECT id FROM user_watchlists WHERE user_id = ? AND anime_id = ?',
      [userId, animeId]
    );
    if (existing.length) {
      await db.query('DELETE FROM user_watchlists WHERE user_id = ? AND anime_id = ?', [userId, animeId]);
      return sendSuccess(res, { inList: false, status: null }, { message: 'Removed from My List.' });
    }

    // Not in the list → add it.
    const [animeRows] = await db.query('SELECT title, cover_image FROM anime WHERE id = ?', [animeId]);
    const validStatuses = ['WATCHING', 'COMPLETED', 'ON_HOLD', 'DROPPED', 'PLAN_TO_WATCH'];
    const resolvedStatus = validStatuses.includes(status) ? status : 'PLAN_TO_WATCH';

    await db.query(
      `INSERT INTO user_watchlists (user_id, anime_id, anime_title, anime_cover, status)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), updated_at = CURRENT_TIMESTAMP`,
      [userId, animeId, animeRows[0]?.title || `Anime-${animeId}`, animeRows[0]?.cover_image || null, resolvedStatus]
    );

    return sendSuccess(res, { inList: true, status: resolvedStatus }, { message: 'Added to My List.' });
  } catch (err) {
    console.error('[WatchlistController] toggleWatchlist error:', err.message);
    return res.status(500).json({ message: 'Failed to toggle watchlist.' });
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

    // FIX 8 (Phase 3): return canonical camelCase field names that the
    // frontend actually reads: animeId, title, poster, status, episodesWatched,
    // totalEpisodes. Join watch_progress for real episode counts.
    const result = [];
    for (const row of rows) {
      const [countRows] = await db.query(
        `SELECT
           (SELECT COUNT(*) FROM episodes e WHERE e.anime_id = ?) AS total_episodes,
           (SELECT COUNT(*) FROM watch_progress wp WHERE wp.user_id = ? AND wp.anime_id = ? AND wp.completed = 1) AS episodes_watched`,
        [row.anime_id, userId, row.anime_id]
      );
      result.push({
        id: row.id,
        animeId: row.anime_id,
        title: row.anime_title,
        poster: row.anime_cover,
        status: row.status,
        episodesWatched: Number(countRows[0]?.episodes_watched || 0),
        totalEpisodes: Number(countRows[0]?.total_episodes || 0),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
    return sendSuccess(res, result);
  } catch (err) {
    console.error('[WatchlistController] getWatchlist error:', err.message);
    return res.status(500).json({ message: 'Failed to fetch watchlist.' });
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

    return sendSuccess(res, null, { message: 'Removed from watchlist.' });
  } catch (err) {
    console.error('[WatchlistController] removeFromWatchlist error:', err.message);
    return res.status(500).json({ message: 'Failed to remove from watchlist.' });
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
    return sendSuccess(res, {
      watching: Number(statRow.watching || 0),
      completed: Number(statRow.completed || 0),
      plan_to_watch: Number(statRow.plan_to_watch || 0),
      total: Number(statRow.total || 0),
    });
  } catch (err) {
    console.error('[WatchlistController] getWatchlistStats error:', err.message);
    return res.status(500).json({ message: 'Failed to fetch watchlist stats.' });
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

    // watchController.getContinueWatching now returns the standard envelope.
    const items = canonicalResponse && canonicalResponse.data !== undefined
      ? (Array.isArray(canonicalResponse.data) ? canonicalResponse.data : [])
      : (Array.isArray(canonicalResponse) ? canonicalResponse : []);

    for (const item of items) {
      legacyRows.push({
        anime_id: item.animeId,
        title: item.title || item.animeTitle,
        cover_image: item.poster || item.animeCoverImage,
        rating: 0,
        episode_number: item.episodeNumber,
        progress_sec: item.positionSec || item.progressSeconds || 0,
        duration_sec: item.durationSec || item.totalDurationSeconds || 1440,
      });
    }

    return sendSuccess(res, legacyRows);
  } catch (err) {
    console.error('[WatchlistController] getLegacyContinueWatching error:', err.message);
    return res.status(500).json({ message: 'Failed to fetch continue watching list.' });
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
        // watchController.getProgress now returns the standard envelope.
        const inner = (payload && payload.data !== undefined) ? payload.data : payload;
        const completed = Number(inner?.progressSeconds || 0) > 0 && inner?.totalDurationSeconds > 0 && Number(inner.progressSeconds) >= Number(inner.totalDurationSeconds)
          ? 1
          : 0;
        return sendSuccess(res, {
          progress_sec: Number(inner?.progressSeconds || 0),
          completed,
        });
      },
      status: (code) => ({ json: (payload) => res.status(code).json(payload) }),
    };

    return watchCtrl.getProgress(legacyReq, legacyRes);
  } catch (err) {
    console.error('[WatchlistController] getLegacyProgress error:', err.message);
    return res.status(500).json({ message: 'Failed to fetch progress.' });
  }
};

/**
 * POST /api/watchlist/progress
 * Compatibility alias that accepts the legacy payload and delegates to the new controller.
 */
exports.saveLegacyProgress = async (req, res) => {
  try {
    const { episodeId, progressSec, progressSeconds, completed, durationSec, totalDurationSeconds } = req.body || {};

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

    // FIX 1 (Phase 3): translate legacy field names to the canonical
    // positionSec / durationSec that watchController.saveProgress reads.
    // Without this, progressSeconds → positionSec = undefined → 0 → ignored.
    const positionSec = Number(progressSec ?? progressSeconds ?? 0);
    const durationSecFinal = Number(durationSec ?? totalDurationSeconds ?? episodeRows[0].duration_sec ?? 0);

    req.body = {
      animeId: episodeRows[0].anime_id,
      episodeNumber: episodeRows[0].episode_number,
      episodeId: Number(episodeId),
      positionSec,
      durationSec: durationSecFinal,
      event: 'heartbeat',
    };

    return watchCtrl.saveProgress(req, res);
  } catch (err) {
    console.error('[WatchlistController] saveLegacyProgress error:', err.message);
    return res.status(500).json({ message: 'Failed to save progress.' });
  }
};

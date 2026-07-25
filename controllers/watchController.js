// controllers/watchController.js
// Video playback progress tracking ("Resume Watching" feature)
const db = require('../config/db');

/**
 * POST /api/watch/progress
 * Body: { animeId, episodeNumber, progressSeconds, totalDurationSeconds }
 * Saves/upserts the user's playback progress for a specific anime episode.
 */
exports.saveProgress = async (req, res) => {
  try {
    const userId = req.user.id; // Set by auth.protect middleware
    const { animeId, episodeNumber, progressSeconds, totalDurationSeconds } = req.body;

    // Validate required fields
    if (!animeId || episodeNumber === undefined || episodeNumber === null) {
      return res.status(400).json({ message: 'animeId and episodeNumber are required.' });
    }

    await db.query(
      `INSERT INTO watch_history (user_id, anime_id, episode_number, progress_seconds, total_duration_seconds)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         progress_seconds        = VALUES(progress_seconds),
         total_duration_seconds  = VALUES(total_duration_seconds),
         updated_at              = NOW()`,
      [userId, animeId, episodeNumber, progressSeconds || 0, totalDurationSeconds || 0]
    );

    res.json({ message: 'Progress saved successfully.' });
  } catch (err) {
    console.error('[WatchController] saveProgress error:', err.message);
    res.status(500).json({ message: 'Failed to save progress.' });
  }
};

/**
 * GET /api/watch/progress/:animeId/:episodeNumber
 * Returns { progressSeconds, totalDurationSeconds } if a record exists,
 * or defaults to { progressSeconds: 0 } if not found.
 */
exports.getProgress = async (req, res) => {
  try {
    const userId = req.user.id; // Set by auth.protect middleware
    const { animeId, episodeNumber } = req.params;

    if (!animeId || episodeNumber === undefined || episodeNumber === null) {
      return res.status(400).json({ message: 'animeId and episodeNumber are required.' });
    }

    const [rows] = await db.query(
      `SELECT progress_seconds, total_duration_seconds
       FROM watch_history
       WHERE user_id = ? AND anime_id = ? AND episode_number = ?
       LIMIT 1`,
      [userId, animeId, parseInt(episodeNumber, 10)]
    );

    if (rows.length === 0) {
      return res.json({ progressSeconds: 0 });
    }

    res.json({
      progressSeconds: rows[0].progress_seconds,
      totalDurationSeconds: rows[0].total_duration_seconds,
    });
  } catch (err) {
    console.error('[WatchController] getProgress error:', err.message);
    res.status(500).json({ message: 'Failed to fetch progress.' });
  }
};


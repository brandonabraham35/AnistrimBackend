// watchlistController.js
const db = require('../config/db');

exports.getWatchlist = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT w.id, w.status AS watch_status, w.episodes_watched, w.added_at,
              a.id AS anime_id, a.title, a.cover_image, a.rating, a.year,
              a.status AS anime_status, a.is_premium,
              (SELECT COUNT(*) FROM episodes WHERE anime_id = a.id) AS total_episodes
       FROM watchlist w JOIN anime a ON w.anime_id = a.id
       WHERE w.user_id = ? ORDER BY w.updated_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: 'Failed to fetch watchlist.' }); }
};

exports.addToWatchlist = async (req, res) => {
  const { animeId, status = 'plan_to_watch' } = req.body;
  if (!animeId) return res.status(400).json({ message: 'animeId required.' });
  try {
    await db.query(
      `INSERT INTO watchlist (user_id, anime_id, status) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), updated_at = NOW()`,
      [req.user.id, animeId, status]
    );
    res.json({ message: 'Added to watchlist!' });
  } catch (err) { res.status(500).json({ message: 'Could not update watchlist.' }); }
};

exports.updateWatchlist = async (req, res) => {
  const { animeId } = req.params;
  const { status, episodes_watched } = req.body;
  try {
    await db.query(
      `UPDATE watchlist SET
         status = COALESCE(?, status),
         episodes_watched = COALESCE(?, episodes_watched),
         updated_at = NOW()
       WHERE user_id = ? AND anime_id = ?`,
      [status || null, episodes_watched ?? null, req.user.id, animeId]
    );
    res.json({ message: 'Updated.' });
  } catch (err) { res.status(500).json({ message: 'Update failed.' }); }
};

exports.removeFromWatchlist = async (req, res) => {
  const { animeId } = req.params;
  try {
    await db.query('DELETE FROM watchlist WHERE user_id = ? AND anime_id = ?', [req.user.id, animeId]);
    res.json({ message: 'Removed.' });
  } catch (err) { res.status(500).json({ message: 'Remove failed.' }); }
};

// FIX 2: Save video progress
exports.saveProgress = async (req, res) => {
  const { episodeId, progressSec, completed = false } = req.body;
  if (!episodeId) return res.status(400).json({ message: 'episodeId required.' });
  try {
    await db.query(
      `INSERT INTO watch_history (user_id, episode_id, progress_sec, completed)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         progress_sec = VALUES(progress_sec),
         completed    = VALUES(completed),
         watched_at   = NOW()`,
      [req.user.id, episodeId, progressSec || 0, completed ? 1 : 0]
    );
    res.json({ message: 'Progress saved.' });
  } catch (err) { res.status(500).json({ message: 'Progress save failed.' }); }
};

// FIX 2: Get saved progress for an episode
exports.getProgress = async (req, res) => {
  const { episodeId } = req.params;
  try {
    const [rows] = await db.query(
      `SELECT progress_sec, completed FROM watch_history
       WHERE user_id = ? AND episode_id = ?`,
      [req.user.id, episodeId]
    );
    res.json(rows[0] || { progress_sec: 0, completed: false });
  } catch (err) { res.status(500).json({ message: 'Could not fetch progress.' }); }
};

// FIX 2: Get "Continue Watching" list for home page
exports.getContinueWatching = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT wh.progress_sec, wh.watched_at,
              e.id AS episode_id, e.episode_number, e.title AS ep_title, e.duration_sec,
              a.id AS anime_id, a.title, a.cover_image, a.rating
       FROM watch_history wh
       JOIN episodes e ON wh.episode_id = e.id
       JOIN anime a    ON e.anime_id    = a.id
       WHERE wh.user_id = ? AND wh.completed = 0 AND wh.progress_sec > 10
       ORDER BY wh.watched_at DESC
       LIMIT 8`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: 'Failed.' }); }
};

// GET /api/watchlist/stats
exports.getStats = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT status, COUNT(*) AS n FROM watchlist WHERE user_id = ? GROUP BY status`,
      [req.user.id]
    );
    const out = { watching: 0, completed: 0, plan_to_watch: 0, dropped: 0, total: 0 };
    rows.forEach(r => { out[r.status] = parseInt(r.n); out.total += parseInt(r.n); });
    res.json(out);
  } catch(e) {
    res.status(500).json({ message: 'Could not fetch stats.' });
  }
};

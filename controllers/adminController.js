// controllers/adminController.js
const db = require('../config/db');
const bcrypt = require('bcryptjs');

// ─── UTILS ────────────────────────────────────────────────
async function logActivity(userId, action, targetType, targetId, details = '', req = null) {
  try {
    const ip = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress) : null;
    await db.query(
      'INSERT INTO activity_logs (user_id, action, target_type, target_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, action, targetType, targetId, details, ip]
    );
  } catch (err) { console.error('Logging failed:', err); }
}

// ─── DASHBOARD ────────────────────────────────────────────
exports.getDashboardStats = async (req, res) => {
  try {
    const [[users]] = await db.query(`SELECT COUNT(*) as total, SUM(is_premium) as premium FROM users`);
    const [[anime]] = await db.query(`SELECT COUNT(*) as total, SUM(view_count) as views FROM anime`);
    const [[episodes]] = await db.query(`SELECT COUNT(*) as total FROM episodes`);
    const [[revenue]] = await db.query(`SELECT COALESCE(SUM(amount),0) as total, COALESCE(SUM(CASE WHEN DATE(paid_at)=CURDATE() THEN amount END),0) as today FROM payments WHERE status='successful'`);

    const [recentUsers] = await db.query(`SELECT id, name, email, is_premium, created_at FROM users ORDER BY created_at DESC LIMIT 5`);
    const [recentPayments] = await db.query(`SELECT p.id, u.name, p.amount, p.status, p.created_at FROM payments p JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC LIMIT 5`);
    const [topAnime] = await db.query(`SELECT id, title, view_count FROM anime ORDER BY view_count DESC LIMIT 5`);

    res.json({
      users,
      anime: { total: anime.total, totalViews: anime.views },
      episodes: episodes.total,
      revenue,
      recentUsers,
      recentPayments,
      topAnime
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch stats.' });
  }
};

// ─── USERS ────────────────────────────────────────────────
exports.getAllUsers = async (req, res) => {
  const { q, role, status } = req.query;
  try {
    let sql = `SELECT id, name, email, is_premium, is_admin, status, created_at FROM users WHERE 1=1`;
    const params = [];

    if (q) { sql += ` AND (name LIKE ? OR email LIKE ?)`; params.push(`%${q}%`, `%${q}%`); }
    if (role === 'admin') sql += ` AND is_admin = 1`;
    if (role === 'premium') sql += ` AND is_premium = 1`;
    if (status) { sql += ` AND status = ?`; params.push(status); }

    sql += ` ORDER BY created_at DESC`;
    const [rows] = await db.query(sql, params);
    res.json({ users: rows });
  } catch (err) {
    res.status(500).json({ message: 'Could not retrieve users.' });
  }
};

exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const { is_admin, status, is_premium } = req.body;
  try {
    await db.query('UPDATE users SET is_admin = ?, status = ?, is_premium = ? WHERE id = ?', [is_admin, status, is_premium, id]);
    await logActivity(req.user.id, 'Updated user', 'user', id, `Admin: ${is_admin}, Status: ${status}`, req);
    res.json({ message: 'User updated.' });
  } catch (err) { res.status(500).json({ message: 'Update failed.' }); }
};

// ─── ANIME ────────────────────────────────────────────────
exports.getAllAnime = async (req, res) => {
  const { q, status, is_premium, is_featured } = req.query;
  try {
    let sql = `SELECT * FROM anime WHERE 1=1`;
    const params = [];
    if (q) { sql += ` AND title LIKE ?`; params.push(`%${q}%`); }
    if (status) { sql += ` AND status = ?`; params.push(status); }
    if (is_premium !== undefined) { sql += ` AND is_premium = ?`; params.push(is_premium); }
    if (is_featured !== undefined) { sql += ` AND is_featured = ?`; params.push(is_featured); }

    sql += ` ORDER BY created_at DESC`;
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: 'Failed to fetch anime.' }); }
};

exports.createAnime = async (req, res) => {
  const { title, title_japanese, description, year, status, studio, rating, is_premium, is_featured, cover_image, banner_image, genres, tags } = req.body;
  try {
    const [result] = await db.query(
      `INSERT INTO anime (title, title_japanese, description, year, status, studio, rating, is_premium, is_featured, cover_image, banner_image, tags) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [title, title_japanese, description, year, status, studio, rating, is_premium, is_featured, cover_image, banner_image, tags]
    );
    const animeId = result.insertId;
    if (genres && genres.length) {
      const vals = genres.map(gid => [animeId, gid]);
      await db.query('INSERT INTO anime_genres (anime_id, genre_id) VALUES ?', [vals]);
    }
    await logActivity(req.user.id, 'Created anime', 'anime', animeId, title, req);
    res.status(201).json({ id: animeId, message: 'Anime created.' });
  } catch (err) { res.status(500).json({ message: 'Failed to create.' }); }
};

exports.updateAnime = async (req, res) => {
  const { id } = req.params;
  const { title, title_japanese, description, year, status, studio, rating, is_premium, is_featured, cover_image, banner_image, genres, tags } = req.body;
  try {
    await db.query(
      `UPDATE anime SET title=?, title_japanese=?, description=?, year=?, status=?, studio=?, rating=?, is_premium=?, is_featured=?, cover_image=?, banner_image=?, tags=? WHERE id=?`,
      [title, title_japanese, description, year, status, studio, rating, is_premium, is_featured, cover_image, banner_image, tags, id]
    );
    await db.query('DELETE FROM anime_genres WHERE anime_id = ?', [id]);
    if (genres && genres.length) {
      const vals = genres.map(gid => [id, gid]);
      await db.query('INSERT INTO anime_genres (anime_id, genre_id) VALUES ?', [vals]);
    }
    await logActivity(req.user.id, 'Updated anime', 'anime', id, title, req);
    res.json({ message: 'Anime updated.' });
  } catch (err) { res.status(500).json({ message: 'Update failed.' }); }
};

exports.deleteAnime = async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM anime WHERE id = ?', [id]);
    await logActivity(req.user.id, 'Deleted anime', 'anime', id, '', req);
    res.json({ message: 'Anime deleted.' });
  } catch (err) { res.status(500).json({ message: 'Delete failed.' }); }
};

// ─── GENRES ───────────────────────────────────────────────
exports.getAllGenres = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM genres ORDER BY name ASC');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: 'Failed to fetch genres.' }); }
};

exports.createGenre = async (req, res) => {
  try {
    const { name } = req.body;
    const [result] = await db.query('INSERT INTO genres (name) VALUES (?)', [name]);
    await logActivity(req.user.id, 'Created genre', 'genre', result.insertId, name, req);
    res.status(201).json({ id: result.insertId });
  } catch (err) { res.status(500).json({ message: 'Failed.' }); }
};

exports.deleteGenre = async (req, res) => {
  try {
    await db.query('DELETE FROM genres WHERE id = ?', [req.params.id]);
    await logActivity(req.user.id, 'Deleted genre', 'genre', req.params.id, '', req);
    res.json({ message: 'Deleted.' });
  } catch (err) { res.status(500).json({ message: 'Failed.' }); }
};

// ─── EPISODES ─────────────────────────────────────────────
exports.addEpisode = async (req, res) => {
  const { animeId } = req.params;
  const { episode_number, title, description, duration_sec, is_premium, thumbnail_url, bunny_video_id, playback_url, embed_url, video_status } = req.body;
  try {
    const [result] = await db.query(
      `INSERT INTO episodes (anime_id, episode_number, title, description, duration_sec, is_premium, thumbnail_url, bunny_video_id, playback_url, embed_url, video_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [animeId, episode_number, title, description, duration_sec, is_premium, thumbnail_url, bunny_video_id, playback_url, embed_url, video_status || 'ready']
    );
    await logActivity(req.user.id, 'Added episode', 'episode', result.insertId, `Anime ${animeId} Ep ${episode_number}`, req);
    res.status(201).json({ id: result.insertId, message: 'Episode added.' });
  } catch (err) { res.status(500).json({ message: 'Failed to add episode.' }); }
};

exports.updateEpisode = async (req, res) => {
  const { id } = req.params;
  const { episode_number, title, description, duration_sec, is_premium, thumbnail_url, bunny_video_id, playback_url, embed_url, video_status } = req.body;
  try {
    await db.query(
      `UPDATE episodes SET episode_number=?, title=?, description=?, duration_sec=?, is_premium=?, thumbnail_url=?, bunny_video_id=?, playback_url=?, embed_url=?, video_status=? WHERE id=?`,
      [episode_number, title, description, duration_sec, is_premium, thumbnail_url, bunny_video_id, playback_url, embed_url, video_status, id]
    );
    await logActivity(req.user.id, 'Updated episode', 'episode', id, title, req);
    res.json({ message: 'Episode updated.' });
  } catch (err) { res.status(500).json({ message: 'Update failed.' }); }
};

exports.deleteEpisode = async (req, res) => {
  try {
    await db.query('DELETE FROM episodes WHERE id = ?', [req.params.id]);
    await logActivity(req.user.id, 'Deleted episode', 'episode', req.params.id, '', req);
    res.json({ message: 'Deleted.' });
  } catch (err) { res.status(500).json({ message: 'Failed.' }); }
};

// ─── SETTINGS & ADS ───────────────────────────────────────
exports.getSettings = async (req, res) => {
  const [rows] = await db.query('SELECT * FROM settings');
  res.json(rows.reduce((acc, r) => ({...acc, [r.key]: r.value}), {}));
};

exports.updateSettings = async (req, res) => {
  const settings = req.body;
  for (const [key, value] of Object.entries(settings)) {
    await db.query('INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?', [key, value, value]);
  }
  await logActivity(req.user.id, 'Updated settings', 'settings', null, '', req);
  res.json({ message: 'Settings updated.' });
};

exports.getAds = async (req, res) => {
  const [rows] = await db.query('SELECT * FROM ads ORDER BY created_at DESC');
  res.json(rows);
};

exports.createAd = async (req, res) => {
  const { title, type, image_url, video_url, target_url, frequency, is_active, target_free_only } = req.body;
  await db.query(
    'INSERT INTO ads (title, type, image_url, video_url, target_url, frequency, is_active, target_free_only) VALUES (?,?,?,?,?,?,?,?)',
    [title, type, image_url, video_url, target_url, frequency, is_active, target_free_only]
  );
  res.status(201).json({ message: 'Ad created.' });
};

exports.updateAd = async (req, res) => {
  const { id } = req.params;
  const { title, type, image_url, video_url, target_url, frequency, is_active, target_free_only } = req.body;
  await db.query(
    'UPDATE ads SET title=?, type=?, image_url=?, video_url=?, target_url=?, frequency=?, is_active=?, target_free_only=? WHERE id=?',
    [title, type, image_url, video_url, target_url, frequency, is_active, target_free_only, id]
  );
  res.json({ message: 'Ad updated.' });
};

exports.deleteAd = async (req, res) => {
  await db.query('DELETE FROM ads WHERE id = ?', [req.params.id]);
  res.json({ message: 'Ad deleted.' });
};

// ─── PAYMENTS ─────────────────────────────────────────────
exports.updatePaymentStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    await db.query('UPDATE payments SET status = ? WHERE id = ?', [status, id]);
    await logActivity(req.user.id, 'Updated payment status', 'payment', id, status, req);
    res.json({ message: 'Payment updated.' });
  } catch (err) { res.status(500).json({ message: 'Failed.' }); }
};

// ─── VIDEOS ───────────────────────────────────────────────
const bunnyStream = require('../utils/bunnyStream');
exports.getVideoStatus = async (req, res) => {
  try {
    const status = await bunnyStream.getVideoStatus(req.params.videoId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── LOGS ─────────────────────────────────────────────────
exports.getActivityLogs = async (req, res) => {
  const [rows] = await db.query('SELECT l.*, u.name as admin_name FROM activity_logs l JOIN users u ON l.user_id = u.id ORDER BY created_at DESC LIMIT 100');
  res.json(rows);
};

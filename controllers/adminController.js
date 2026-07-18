const db = require('../config/db');
const bunnyStream = require('../utils/bunnyStream');

const toBool = value => value === true || value === 1 || value === '1' || (Buffer.isBuffer(value) && value[0] === 1);
const numberOrNull = value => value === '' || value === undefined || value === null ? null : Number(value);
let schemaPromise;

async function getSchema() {
  if (!schemaPromise) {
    schemaPromise = db.query('SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name FROM information_schema.columns WHERE table_schema = DATABASE()')
      .then(([rows]) => rows.reduce((schema, row) => {
        if (!schema[row.table_name]) schema[row.table_name] = new Set();
        schema[row.table_name].add(row.column_name);
        return schema;
      }, {}))
      .catch(error => { schemaPromise = null; throw error; });
  }
  return schemaPromise;
}

const hasColumn = (schema, table, column) => Boolean(schema[table]?.has(column));

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim() || null;
}

async function logActivity(req, action, targetType = null, targetId = null, details = null) {
  try {
    await db.query(
      'INSERT INTO activity_logs (user_id, action, target_type, target_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, action, targetType, targetId, details, clientIp(req)]
    );
  } catch (error) {
    // Activity logging must never turn a completed admin operation into a failure.
    console.warn('Activity log was not recorded:', error.message);
  }
}

async function getSettingsObject() {
  const [rows] = await db.query('SELECT `key`, `value` FROM settings');
  return rows.reduce((settings, row) => ({ ...settings, [row.key]: row.value }), {});
}

function settingsResponse(settings) {
  return {
    ...settings,
    maintenance_mode: toBool(settings.maintenance_mode),
    premium_monthly_amount: settings.premium_price_monthly ?? settings.premium_monthly_amount ?? '',
    premium_yearly_amount: settings.premium_price_yearly ?? settings.premium_yearly_amount ?? '',
  };
}

const adminController = {
  async getDashboardOverview(req, res) {
    try {
      const schema = await getSchema();
      const usersSql = `SELECT COUNT(*) total, COALESCE(SUM(is_premium = 1 OR premium_expires_at > NOW()), 0) premium${hasColumn(schema, 'users', 'status') ? ', COALESCE(SUM(status = "banned"), 0) banned' : ', 0 banned'} FROM users`;
      const episodeSql = hasColumn(schema, 'episodes', 'bunny_video_id')
        ? `SELECT COUNT(*) totalEpisodes, COALESCE(SUM(view_count), 0) episodeViews, COUNT(bunny_video_id) videoCount,
             COALESCE(SUM(video_status = 'ready'), 0) bunnyReady, COALESCE(SUM(video_status IN ('queued','processing','encoding','resolving')), 0) bunnyProcessing, COALESCE(SUM(video_status = 'failed'), 0) bunnyFailed FROM episodes`
        : 'SELECT COUNT(*) totalEpisodes, COALESCE(SUM(view_count), 0) episodeViews, COALESCE(SUM(video_url IS NOT NULL AND video_url != ""), 0) videoCount, 0 bunnyReady, 0 bunnyProcessing, 0 bunnyFailed FROM episodes';
      const logsSql = schema.activity_logs
        ? 'SELECT l.action, l.created_at, l.ip_address, u.name user_name FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.created_at DESC LIMIT 10'
        : 'SELECT l.action, l.created_at, NULL ip_address, u.name user_name FROM admin_logs l LEFT JOIN users u ON u.id = l.admin_id ORDER BY l.created_at DESC LIMIT 10';
      const recentEpisodesSql = hasColumn(schema, 'episodes', 'video_status')
        ? 'SELECT e.id, e.episode_number, e.title, e.thumbnail_url, e.video_status, e.created_at, a.title anime_title FROM episodes e JOIN anime a ON a.id = e.anime_id ORDER BY e.created_at DESC LIMIT 5'
        : "SELECT e.id, e.episode_number, e.title, e.thumbnail_url, CASE WHEN e.video_url IS NULL OR e.video_url = '' THEN 'missing' ELSE 'available' END video_status, e.created_at, a.title anime_title FROM episodes e JOIN anime a ON a.id = e.anime_id ORDER BY e.created_at DESC LIMIT 5";
      const results = await Promise.all([
        db.query(usersSql),
        db.query('SELECT COUNT(*) totalAnime, COALESCE(SUM(view_count), 0) totalViews, COALESCE(AVG(rating), 0) avgRating FROM anime'),
        db.query(episodeSql),
        db.query('SELECT COUNT(DISTINCT user_id) activeToday, COUNT(*) dailyViews FROM watch_history WHERE DATE(watched_at) = CURDATE()'),
        db.query('SELECT id, title, cover_image, status, year AS release_year, created_at FROM anime ORDER BY created_at DESC LIMIT 5'),
        db.query(recentEpisodesSql),
        db.query(logsSql),
        db.query('SELECT id, title, cover_image, view_count FROM anime ORDER BY view_count DESC, created_at DESC LIMIT 5'),
        db.query('SELECT COALESCE(SUM(amount), 0) revenue FROM payments WHERE status = "successful"'),
        db.query('SELECT id, name, email, avatar_url, created_at FROM users ORDER BY created_at DESC LIMIT 5'),
      ]);
      const users = results[0][0][0];
      const content = results[1][0][0];
      const episodes = results[2][0][0];
      const activity = results[3][0][0];
      res.json({
        overview: {
          users: { total: Number(users.total) || 0, premium: Number(users.premium) || 0, activeToday: Number(activity.activeToday) || 0, banned: Number(users.banned) || 0 },
          content: { totalAnime: Number(content.totalAnime) || 0, totalEpisodes: Number(episodes.totalEpisodes) || 0, totalViews: (Number(content.totalViews) || 0) + (Number(episodes.episodeViews) || 0), dailyViews: Number(activity.dailyViews) || 0, avgRating: Number(content.avgRating) || 0 },
          // Bunny Stream does not expose stored-byte totals in this API. Do not invent an estimate.
          storage: { usageGB: null, videoCount: Number(episodes.videoCount) || 0 },
          bunny: { ready: Number(episodes.bunnyReady) || 0, processing: Number(episodes.bunnyProcessing) || 0, failed: Number(episodes.bunnyFailed) || 0 },
          revenue: Number(results[8][0][0].revenue) || 0,
        },
        recentAnime: results[4][0], recentEpisodes: results[5][0], activityLogs: results[6][0], topAnime: results[7][0], latestUsers: results[9][0],
      });
    } catch (error) {
      console.error('Dashboard overview error:', error);
      res.status(500).json({ message: 'Unable to load dashboard analytics.' });
    }
  },

  async getDashboardStats(req, res) {
    return adminController.getDashboardOverview(req, res);
  },

  async getAllAnime(req, res) {
    try {
      const filters = req.query || {};
      const params = [];
      const where = [];
      if (filters.q) { where.push('(a.title LIKE ? OR a.title_japanese LIKE ?)'); params.push(`%${filters.q}%`, `%${filters.q}%`); }
      if (filters.status) { where.push('a.status = ?'); params.push(filters.status); }
      const [anime] = await db.query(`SELECT a.*, COUNT(DISTINCT e.id) episode_count, GROUP_CONCAT(DISTINCT g.name ORDER BY g.name SEPARATOR ', ') genres
        FROM anime a LEFT JOIN episodes e ON e.anime_id = a.id LEFT JOIN anime_genres ag ON ag.anime_id = a.id LEFT JOIN genres g ON g.id = ag.genre_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY a.id ORDER BY a.created_at DESC`, params);
      res.json(anime.map(row => ({ ...row, is_premium: toBool(row.is_premium), is_featured: toBool(row.is_featured) })));
    } catch (error) { res.status(500).json({ message: error.message }); }
  },

  async createAnime(req, res) {
    const { title, title_japanese, description, cover_image, banner_image, trailer_url, rating, year, studio, status = 'completed', is_premium = 0, is_featured = 0, tags, genres = [] } = req.body;
    if (!title?.trim()) return res.status(400).json({ message: 'Anime title is required.' });
    try {
      const [result] = await db.query('INSERT INTO anime (title, title_japanese, description, cover_image, banner_image, trailer_url, rating, year, studio, status, is_premium, is_featured, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [title.trim(), title_japanese || null, description || null, cover_image || null, banner_image || null, trailer_url || null, numberOrNull(rating), numberOrNull(year), studio || null, status, toBool(is_premium) ? 1 : 0, toBool(is_featured) ? 1 : 0, tags || null]);
      await adminController.replaceGenres(result.insertId, genres);
      await logActivity(req, `Created anime: ${title.trim()}`, 'anime', result.insertId);
      res.status(201).json({ id: result.insertId, message: 'Anime created.' });
    } catch (error) { res.status(500).json({ message: error.message }); }
  },

  async updateAnime(req, res) {
    const { title, title_japanese, description, cover_image, banner_image, trailer_url, rating, year, studio, status, is_premium, is_featured, tags, genres } = req.body;
    try {
      const [existing] = await db.query('SELECT id FROM anime WHERE id = ?', [req.params.id]);
      if (!existing.length) return res.status(404).json({ message: 'Anime not found.' });
      await db.query('UPDATE anime SET title = COALESCE(?, title), title_japanese = ?, description = ?, cover_image = ?, banner_image = ?, trailer_url = ?, rating = ?, year = ?, studio = ?, status = COALESCE(?, status), is_premium = COALESCE(?, is_premium), is_featured = COALESCE(?, is_featured), tags = ? WHERE id = ?', [title?.trim() || null, title_japanese ?? null, description ?? null, cover_image ?? null, banner_image ?? null, trailer_url ?? null, numberOrNull(rating), numberOrNull(year), studio ?? null, status || null, is_premium === undefined ? null : (toBool(is_premium) ? 1 : 0), is_featured === undefined ? null : (toBool(is_featured) ? 1 : 0), tags ?? null, req.params.id]);
      if (Array.isArray(genres)) await adminController.replaceGenres(req.params.id, genres);
      await logActivity(req, `Updated anime #${req.params.id}`, 'anime', req.params.id);
      res.json({ message: 'Anime updated.' });
    } catch (error) { res.status(500).json({ message: error.message }); }
  },

  async deleteAnime(req, res) {
    try {
      const [result] = await db.query('DELETE FROM anime WHERE id = ?', [req.params.id]);
      if (!result.affectedRows) return res.status(404).json({ message: 'Anime not found.' });
      await logActivity(req, `Deleted anime #${req.params.id}`, 'anime', req.params.id);
      res.json({ message: 'Anime deleted.' });
    } catch (error) { res.status(500).json({ message: error.message }); }
  },

  async replaceGenres(animeId, genres) {
    await db.query('DELETE FROM anime_genres WHERE anime_id = ?', [animeId]);
    const ids = [...new Set((genres || []).map(Number).filter(Number.isInteger))];
    if (ids.length) await db.query('INSERT IGNORE INTO anime_genres (anime_id, genre_id) VALUES ?', [ids.map(id => [animeId, id])]);
  },

  async getAllGenres(req, res) { try { const [rows] = await db.query('SELECT id, name FROM genres ORDER BY name'); res.json(rows); } catch (error) { res.status(500).json({ message: error.message }); } },
  async createGenre(req, res) { if (!req.body.name?.trim()) return res.status(400).json({ message: 'Genre name is required.' }); try { const [r] = await db.query('INSERT INTO genres (name) VALUES (?)', [req.body.name.trim()]); await logActivity(req, `Created genre: ${req.body.name.trim()}`, 'genre', r.insertId); res.status(201).json({ id: r.insertId, name: req.body.name.trim() }); } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: error.code === 'ER_DUP_ENTRY' ? 'Genre already exists.' : error.message }); } },
  async deleteGenre(req, res) { try { const [r] = await db.query('DELETE FROM genres WHERE id = ?', [req.params.id]); if (!r.affectedRows) return res.status(404).json({ message: 'Genre not found.' }); await logActivity(req, `Deleted genre #${req.params.id}`, 'genre', req.params.id); res.json({ message: 'Genre deleted.' }); } catch (error) { res.status(500).json({ message: error.message }); } },

  async getAllEpisodes(req, res) { try { const [rows] = await db.query('SELECT e.*, a.title anime_title FROM episodes e JOIN anime a ON a.id = e.anime_id ORDER BY e.created_at DESC'); res.json(rows.map(row => ({ ...row, is_premium: toBool(row.is_premium) }))); } catch (error) { res.status(500).json({ message: error.message }); } },
  async getAnimeEpisodes(req, res) { try { const [rows] = await db.query('SELECT * FROM episodes WHERE anime_id = ? ORDER BY episode_number', [req.params.animeId]); res.json(rows.map(row => ({ ...row, is_premium: toBool(row.is_premium) }))); } catch (error) { res.status(500).json({ message: error.message }); } },
  async getEpisode(req, res) { try { const [rows] = await db.query('SELECT * FROM episodes WHERE id = ?', [req.params.id]); if (!rows.length) return res.status(404).json({ message: 'Episode not found.' }); res.json({ ...rows[0], is_premium: toBool(rows[0].is_premium) }); } catch (error) { res.status(500).json({ message: error.message }); } },
  async addEpisode(req, res) {
    const animeId = Number(req.params.animeId); const { episode_number, title, description, thumbnail_url, video_url, duration_sec, is_premium = 0, bunny_video_id, video_status, playback_url, embed_url } = req.body;
    if (!Number.isInteger(animeId) || !Number.isInteger(Number(episode_number))) return res.status(400).json({ message: 'A valid episode number is required.' });
    try { const [r] = await db.query('INSERT INTO episodes (anime_id, episode_number, title, description, thumbnail_url, video_url, duration_sec, is_premium, bunny_video_id, video_status, playback_url, embed_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, "ready"), ?, ?)', [animeId, Number(episode_number), title || null, description || null, thumbnail_url || null, video_url || null, numberOrNull(duration_sec), toBool(is_premium) ? 1 : 0, bunny_video_id || null, video_status || null, playback_url || null, embed_url || null]); await logActivity(req, `Created episode ${episode_number}`, 'episode', r.insertId); res.status(201).json({ id: r.insertId, message: 'Episode created.' }); } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: error.code === 'ER_DUP_ENTRY' ? 'This episode number already exists.' : error.message }); }
  },
  async updateEpisode(req, res) {
    const fields = ['episode_number', 'title', 'description', 'thumbnail_url', 'video_url', 'duration_sec', 'is_premium', 'bunny_video_id', 'video_status', 'playback_url', 'embed_url']; const updates = []; const values = [];
    for (const field of fields) if (Object.prototype.hasOwnProperty.call(req.body, field)) { updates.push(`${field} = ?`); values.push(field === 'is_premium' ? (toBool(req.body[field]) ? 1 : 0) : field === 'duration_sec' || field === 'episode_number' ? numberOrNull(req.body[field]) : req.body[field] || null); }
    if (!updates.length) return res.status(400).json({ message: 'No episode fields were supplied.' });
    try { const [r] = await db.query(`UPDATE episodes SET ${updates.join(', ')} WHERE id = ?`, [...values, req.params.id]); if (!r.affectedRows) return res.status(404).json({ message: 'Episode not found.' }); await logActivity(req, `Updated episode #${req.params.id}`, 'episode', req.params.id); res.json({ message: 'Episode updated.' }); } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: error.code === 'ER_DUP_ENTRY' ? 'This episode number already exists.' : error.message }); }
  },
  async deleteEpisode(req, res) { try { const [r] = await db.query('DELETE FROM episodes WHERE id = ?', [req.params.id]); if (!r.affectedRows) return res.status(404).json({ message: 'Episode not found.' }); await logActivity(req, `Deleted episode #${req.params.id}`, 'episode', req.params.id); res.json({ message: 'Episode deleted.' }); } catch (error) { res.status(500).json({ message: error.message }); } },

  async getAllUsers(req, res) {
    try {
      const schema = await getSchema();
      const status = hasColumn(schema, 'users', 'status') ? 'status' : "'unavailable' AS status";
      const [rows] = await db.query(`SELECT id, name, email, is_admin, is_premium, premium_expires_at, ${status}, created_at FROM users ORDER BY created_at DESC`);
      res.json(rows.map(row => ({ ...row, is_admin: toBool(row.is_admin), is_premium: toBool(row.is_premium) })));
    } catch (error) { res.status(500).json({ message: error.message }); }
  },
  async updateUser(req, res) { const allowed = ['status', 'is_premium', 'premium_expires_at']; const updates = []; const values = []; for (const field of allowed) if (Object.prototype.hasOwnProperty.call(req.body, field)) { updates.push(`${field} = ?`); values.push(field === 'is_premium' ? (toBool(req.body[field]) ? 1 : 0) : req.body[field]); } if (!updates.length) return res.status(400).json({ message: 'No editable user fields were supplied.' }); try { const [r] = await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, [...values, req.params.id]); if (!r.affectedRows) return res.status(404).json({ message: 'User not found.' }); await logActivity(req, `Updated user #${req.params.id}`, 'user', req.params.id); res.json({ message: 'User updated.' }); } catch (error) { res.status(500).json({ message: error.message }); } },

  async getSettings(req, res) { try { res.json(settingsResponse(await getSettingsObject())); } catch (error) { res.status(500).json({ message: error.message }); } },
  async updateSettings(req, res) { const aliases = { premium_monthly_amount: 'premium_price_monthly', premium_yearly_amount: 'premium_price_yearly' }; const allowed = new Set(['site_name', 'announcement', 'maintenance_mode', 'premium_price_monthly', 'premium_price_yearly', 'premium_monthly_amount', 'premium_yearly_amount', 'contact_email', 'bunny_cdn_hostname']); const entries = Object.entries(req.body).filter(([key]) => allowed.has(key)).map(([key, value]) => [aliases[key] || key, value === null || value === undefined ? '' : String(value)]); if (!entries.length) return res.status(400).json({ message: 'No settings were supplied.' }); try { await db.query('INSERT INTO settings (`key`, `value`) VALUES ? ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)', [entries]); await logActivity(req, 'Updated site settings', 'settings'); res.json(settingsResponse(await getSettingsObject())); } catch (error) { res.status(500).json({ message: error.message }); } },

  async getAds(req, res) { try { const [rows] = await db.query('SELECT * FROM ads ORDER BY created_at DESC'); res.json(rows.map(row => ({ ...row, banner_url: row.image_url, frequency_minutes: row.frequency, is_active: toBool(row.is_active), target_free_only: toBool(row.target_free_only) }))); } catch (error) { res.status(500).json({ message: error.message }); } },
  async createAd(req, res) { const { title, type = 'banner', image_url, banner_url, video_url, target_url, frequency, frequency_minutes, is_active = 1, target_free_only = 1 } = req.body; if (!title?.trim()) return res.status(400).json({ message: 'Ad title is required.' }); try { const [r] = await db.query('INSERT INTO ads (title, type, image_url, video_url, target_url, frequency, is_active, target_free_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [title.trim(), type, image_url || banner_url || null, video_url || null, target_url || null, Number(frequency ?? frequency_minutes) || 1, toBool(is_active) ? 1 : 0, toBool(target_free_only) ? 1 : 0]); await logActivity(req, `Created advertisement: ${title.trim()}`, 'ad', r.insertId); res.status(201).json({ id: r.insertId, message: 'Advertisement created.' }); } catch (error) { res.status(500).json({ message: error.message }); } },
  async updateAd(req, res) { const map = { banner_url: 'image_url', frequency_minutes: 'frequency' }; const allowed = new Set(['title', 'type', 'image_url', 'banner_url', 'video_url', 'target_url', 'frequency', 'frequency_minutes', 'is_active', 'target_free_only']); const updates = []; const values = []; for (const [key, value] of Object.entries(req.body)) if (allowed.has(key)) { const field = map[key] || key; updates.push(`${field} = ?`); values.push(['is_active', 'target_free_only'].includes(field) ? (toBool(value) ? 1 : 0) : field === 'frequency' ? Number(value) || 1 : value || null); } if (!updates.length) return res.status(400).json({ message: 'No advertisement fields were supplied.' }); try { const [r] = await db.query(`UPDATE ads SET ${updates.join(', ')} WHERE id = ?`, [...values, req.params.id]); if (!r.affectedRows) return res.status(404).json({ message: 'Advertisement not found.' }); await logActivity(req, `Updated advertisement #${req.params.id}`, 'ad', req.params.id); res.json({ message: 'Advertisement updated.' }); } catch (error) { res.status(500).json({ message: error.message }); } },
  async deleteAd(req, res) { try { const [r] = await db.query('DELETE FROM ads WHERE id = ?', [req.params.id]); if (!r.affectedRows) return res.status(404).json({ message: 'Advertisement not found.' }); await logActivity(req, `Deleted advertisement #${req.params.id}`, 'ad', req.params.id); res.json({ message: 'Advertisement deleted.' }); } catch (error) { res.status(500).json({ message: error.message }); } },

  async updatePaymentStatus(req, res) { const { status } = req.body; if (!['pending', 'successful', 'failed', 'refunded'].includes(status)) return res.status(400).json({ message: 'Invalid payment status.' }); try { const [r] = await db.query('UPDATE payments SET status = ?, paid_at = CASE WHEN ? = "successful" THEN COALESCE(paid_at, NOW()) ELSE paid_at END WHERE id = ?', [status, status, req.params.id]); if (!r.affectedRows) return res.status(404).json({ message: 'Payment not found.' }); await logActivity(req, `Updated payment #${req.params.id} to ${status}`, 'payment', req.params.id); res.json({ message: 'Payment updated.' }); } catch (error) { res.status(500).json({ message: error.message }); } },
  async getVideoStatus(req, res) { try { const status = await bunnyStream.getVideoStatus(req.params.videoId); res.json({ ...status, video_status: status.status, encodeProgress: status.progress ?? 0 }); } catch (error) { res.status(502).json({ message: error.message }); } },
  async getActivityLogs(req, res) {
    try {
      const schema = await getSchema();
      const sql = schema.activity_logs
        ? 'SELECT a.action, a.created_at, a.ip_address, u.name user_name FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 50'
        : 'SELECT a.action, a.created_at, NULL ip_address, u.name user_name FROM admin_logs a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.created_at DESC LIMIT 50';
      const [rows] = await db.query(sql);
      res.json(rows);
    } catch (error) { res.status(500).json({ message: error.message }); }
  },
};

module.exports = adminController;

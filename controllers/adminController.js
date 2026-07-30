const db = require('../config/db');
const cloudinaryVideo = require('../utils/bunnyStream');
const { deleteImage } = require('../utils/bunnyUpload');
const cache = require('../utils/cacheService');

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
const invalidateCatalogue = animeId => cache.delByPrefix('catalogue:').catch(error => console.warn('Catalogue cache invalidation failed:', error.message));

async function insertExistingColumns(table, values) {
  const schema = await getSchema();
  const entries = Object.entries(values).filter(([column]) => hasColumn(schema, table, column));
  const columns = entries.map(([column]) => column);
  const placeholders = columns.map(() => '?').join(', ');
  const [result] = await db.query(`INSERT INTO \`${table}\` (${columns.map(column => `\`${column}\``).join(', ')}) VALUES (${placeholders})`, entries.map(([, value]) => value));
  return result;
}

async function dashboardQuery(label, sql) {
  try {
    return await db.query(sql);
  } catch (error) {
    // Dashboard widgets are independent. An optional table that has not been
    // migrated must not make users/anime/episode analytics disappear as well.
    console.error(`Dashboard query failed (${label}):`, error.message);
    return [[]];
  }
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim() || null;
}

async function logActivity(req, action, targetType = null, targetId = null, details = null) {
  try {
    const schema = await getSchema();
    if (schema.activity_logs) {
      await db.query('INSERT INTO activity_logs (user_id, action, target_type, target_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)', [req.user.id, action, targetType, targetId, details, clientIp(req)]);
    } else if (schema.admin_logs) {
      await db.query('INSERT INTO admin_logs (admin_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)', [req.user.id, action, targetType, targetId, details]);
    }
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
      const episodeSql = 'SELECT COUNT(*) totalEpisodes, COALESCE(SUM(view_count), 0) episodeViews, COALESCE(SUM(video_url IS NOT NULL AND video_url != ""), 0) videoCount, 0 processingCount, 0 failedCount FROM episodes';
      const logsSql = schema.activity_logs
        ? 'SELECT l.action, l.created_at, l.ip_address, u.name user_name FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.created_at DESC LIMIT 10'
        : 'SELECT l.action, l.created_at, NULL ip_address, u.name user_name FROM admin_logs l LEFT JOIN users u ON u.id = l.admin_id ORDER BY l.created_at DESC LIMIT 10';
      const recentEpisodesSql = "SELECT e.id, e.episode_number, e.title, e.thumbnail_url, CASE WHEN e.video_url IS NULL OR e.video_url = '' THEN 'missing' ELSE 'available' END video_status, e.created_at, a.title anime_title FROM episodes e JOIN anime a ON a.id = e.anime_id ORDER BY e.created_at DESC LIMIT 5";
      const results = await Promise.all([
        dashboardQuery('users', usersSql),
        dashboardQuery('anime totals', 'SELECT COUNT(*) totalAnime, COALESCE(SUM(view_count), 0) totalViews, COALESCE(AVG(rating), 0) avgRating FROM anime'),
        dashboardQuery('episode totals', episodeSql),
        dashboardQuery('daily activity', 'SELECT COUNT(DISTINCT user_id) activeToday, COUNT(*) dailyViews FROM watch_history WHERE DATE(watched_at) = CURDATE()'),
        dashboardQuery('recent anime', 'SELECT id, title, cover_image, status, year AS release_year, created_at FROM anime ORDER BY created_at DESC LIMIT 5'),
        dashboardQuery('recent episodes', recentEpisodesSql),
        dashboardQuery('activity logs', logsSql),
        dashboardQuery('top anime', 'SELECT id, title, cover_image, view_count FROM anime ORDER BY view_count DESC, created_at DESC LIMIT 5'),
        dashboardQuery('revenue', `
          SELECT COALESCE(SUM(amount), 0) AS total,
                 COALESCE(SUM(CASE WHEN DATE(paid_at) = CURDATE() THEN amount ELSE 0 END), 0) AS today,
                 COALESCE(SUM(CASE WHEN YEAR(paid_at) = YEAR(CURDATE()) AND MONTH(paid_at) = MONTH(CURDATE()) THEN amount ELSE 0 END), 0) AS month
          FROM payments WHERE status = "successful"`),
        dashboardQuery('latest users', 'SELECT id, name, email, avatar_url, created_at FROM users ORDER BY created_at DESC LIMIT 5'),
      ]);
      const users = results[0][0][0] || {};
      const content = results[1][0][0] || {};
      const episodes = results[2][0][0] || {};
      const activity = results[3][0][0] || {};
      res.json({
        overview: {
          users: { total: Number(users.total) || 0, premium: Number(users.premium) || 0, activeToday: Number(activity.activeToday) || 0, banned: Number(users.banned) || 0 },
          content: { totalAnime: Number(content.totalAnime) || 0, totalEpisodes: Number(episodes.totalEpisodes) || 0, totalViews: (Number(content.totalViews) || 0) + (Number(episodes.episodeViews) || 0), dailyViews: Number(activity.dailyViews) || 0, avgRating: Number(content.avgRating) || 0 },
          storage: { usageGB: null, videoCount: Number(episodes.videoCount) || 0 },
          cloudinary: { ready: Number(episodes.videoCount) || 0, processing: Number(episodes.processingCount) || 0, failed: Number(episodes.failedCount) || 0 },
          revenue: results[8][0][0] || { total: 0, today: 0, month: 0 },
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
      const schema = await getSchema();

      // Search across title, title_japanese, studio, tags
      if (filters.q) {
        const searchClauses = ['a.title LIKE ?'];
        if (hasColumn(schema, 'anime', 'title_japanese')) searchClauses.push('a.title_japanese LIKE ?');
        if (hasColumn(schema, 'anime', 'studio')) searchClauses.push('a.studio LIKE ?');
        if (hasColumn(schema, 'anime', 'tags')) searchClauses.push('a.tags LIKE ?');
        where.push(`(${searchClauses.join(' OR ')})`);
        const q = `%${filters.q}%`;
        searchClauses.forEach(() => params.push(q));
      }
      if (filters.status) { where.push('a.status = ?'); params.push(filters.status); }
      if (filters.premium !== undefined && filters.premium !== '') {
        where.push('a.is_premium = ?');
        params.push(filters.premium === '1' || filters.premium === 'true' ? 1 : 0);
      }
      if (filters.featured !== undefined && filters.featured !== '') {
        where.push('a.is_featured = ?');
        params.push(filters.featured === '1' || filters.featured === 'true' ? 1 : 0);
      }
      if (filters.media_type) { where.push('a.media_type = ?'); params.push(filters.media_type); }
      if (filters.year) { where.push('a.year = ?'); params.push(Number(filters.year)); }

      // Genre filter via join
      let genreJoin = '';
      if (filters.genre) {
        genreJoin = ' JOIN anime_genres ag ON a.id = ag.anime_id JOIN genres g ON ag.genre_id = g.id';
        where.push('g.name = ?');
        params.push(filters.genre);
      }

      // Sorting
      const sortField = filters.sort || 'created_at';
      const sortOrder = filters.order === 'asc' ? 'ASC' : 'DESC';
      const sortMap = {
        title: 'a.title',
        newest: 'a.created_at',
        oldest: 'a.created_at',
        views: 'a.view_count',
        episodes: 'episode_count',
        alphabetical: 'a.title',
        updated: 'a.updated_at',
        rating: 'a.rating',
      };
      const sortColumn = sortMap[sortField] || 'a.created_at';
      const sortDirection = (sortField === 'oldest' || sortField === 'title' || sortField === 'alphabetical') ? 'ASC' : sortOrder;

      // Pagination
      const page = Math.max(1, Number(filters.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(filters.limit) || 15));
      const offset = (page - 1) * limit;

      // Count total matching rows
      const [countResult] = await db.query(
        `SELECT COUNT(DISTINCT a.id) AS total
         FROM anime a${genreJoin}
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
        params
      );
      const total = countResult[0]?.total || 0;

      // Fetch page
      const [anime] = await db.query(
        `SELECT a.*,
            (SELECT COUNT(*) FROM episodes e WHERE e.anime_id = a.id) AS episode_count
         FROM anime a${genreJoin}
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ${sortColumn} ${sortDirection}, a.id DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      // Attach genres to each anime
      const ids = anime.map(a => a.id);
      let genreMap = {};
      if (ids.length) {
        const [genreRows] = await db.query(
          `SELECT ag.anime_id, g.name FROM anime_genres ag
           JOIN genres g ON ag.genre_id = g.id
           WHERE ag.anime_id IN (?)`, [ids]
        );
        genreRows.forEach(r => {
          if (!genreMap[r.anime_id]) genreMap[r.anime_id] = [];
          genreMap[r.anime_id].push(r.name);
        });
      }

      const data = anime.map(row => ({
        ...row,
        genres: genreMap[row.id] || [],
        is_premium: toBool(row.is_premium),
        is_featured: toBool(row.is_featured),
      }));

      res.json({
        data,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) { res.status(500).json({ message: error.message }); }
  },

  async getAnimeById(req, res) {
    try {
      const schema = await getSchema();
      const [rows] = await db.query('SELECT * FROM anime WHERE id = ?', [req.params.id]);
      if (!rows.length) return res.status(404).json({ message: 'Anime not found.' });

      const anime = rows[0];

      // Get genres
      const [genreRows] = await db.query(
        `SELECT g.name FROM anime_genres ag JOIN genres g ON ag.genre_id = g.id WHERE ag.anime_id = ?`,
        [anime.id]
      );
      anime.genres = genreRows.map(r => r.name);

      // Get episode count
      const [epCount] = await db.query('SELECT COUNT(*) AS count FROM episodes WHERE anime_id = ?', [anime.id]);
      anime.episode_count = epCount[0]?.count || 0;

      // Get total episode views
      const [epViews] = await db.query('SELECT COALESCE(SUM(view_count), 0) AS views FROM episodes WHERE anime_id = ?', [anime.id]);
      anime.total_episode_views = epViews[0]?.views || 0;

      res.json({
        ...anime,
        is_premium: toBool(anime.is_premium),
        is_featured: toBool(anime.is_featured),
      });
    } catch (error) { res.status(500).json({ message: error.message }); }
  },

  async createAnime(req, res) {
    const { title, title_japanese, description, cover_image, banner_image, cover_public_id, banner_public_id, trailer_url, rating, year, studio, status = 'completed', is_premium = 0, is_featured = 0, tags, genres = [] } = req.body;
    if (!title?.trim()) return res.status(400).json({ message: 'Anime title is required.' });
    try {
      const result = await insertExistingColumns('anime', { title: title.trim(), title_japanese: title_japanese || null, description: description || null, cover_image: cover_image || null, banner_image: banner_image || null, cover_public_id: cover_public_id || null, banner_public_id: banner_public_id || null, trailer_url: trailer_url || null, rating: numberOrNull(rating), year: numberOrNull(year), studio: studio || null, status, is_premium: toBool(is_premium) ? 1 : 0, is_featured: toBool(is_featured) ? 1 : 0, tags: tags || null });
       await adminController.replaceGenres(result.insertId, genres);
       invalidateCatalogue(result.insertId);
      await logActivity(req, `Created anime: ${title.trim()}`, 'anime', result.insertId);
      res.status(201).json({ id: result.insertId, message: 'Anime created.' });
    } catch (error) { res.status(500).json({ message: error.message }); }
  },

  async updateAnime(req, res) {
    const { title, title_japanese, description, cover_image, banner_image, cover_public_id, banner_public_id, trailer_url, rating, year, studio, status, is_premium, is_featured, tags, genres } = req.body;
    try {
      const [existing] = await db.query('SELECT id FROM anime WHERE id = ?', [req.params.id]);
      if (!existing.length) return res.status(404).json({ message: 'Anime not found.' });
      const schema = await getSchema();
      const values = { title: title?.trim(), title_japanese, description, cover_image, banner_image, cover_public_id, banner_public_id, trailer_url, rating: numberOrNull(rating), year: numberOrNull(year), studio, status, is_premium: is_premium === undefined ? undefined : (toBool(is_premium) ? 1 : 0), is_featured: is_featured === undefined ? undefined : (toBool(is_featured) ? 1 : 0), tags };
      const entries = Object.entries(values).filter(([field, value]) => hasColumn(schema, 'anime', field) && value !== undefined);
      if (entries.length) await db.query(`UPDATE anime SET ${entries.map(([field]) => `\`${field}\` = ?`).join(', ')} WHERE id = ?`, [...entries.map(([, value]) => value), req.params.id]);
       if (Array.isArray(genres)) await adminController.replaceGenres(req.params.id, genres);
       invalidateCatalogue(req.params.id);
      await logActivity(req, `Updated anime #${req.params.id}`, 'anime', req.params.id);
      res.json({ message: 'Anime updated.' });
    } catch (error) { res.status(500).json({ message: error.message }); }
  },

  async deleteAnime(req, res) {
    try {
      const schema = await getSchema();
      const fields = [hasColumn(schema, 'anime', 'cover_public_id') ? 'cover_public_id' : 'NULL AS cover_public_id', hasColumn(schema, 'anime', 'banner_public_id') ? 'banner_public_id' : 'NULL AS banner_public_id'];
      const [assets] = await db.query(`SELECT ${fields.join(', ')} FROM anime WHERE id = ?`, [req.params.id]);
      const videoIdColumn = hasColumn(schema, 'episodes', 'cloudinary_public_id') ? 'cloudinary_public_id' : null;
      const thumbnailIdColumn = hasColumn(schema, 'episodes', 'thumbnail_public_id') ? 'thumbnail_public_id' : null;
      const [episodeAssets] = (videoIdColumn || thumbnailIdColumn) ? await db.query(`SELECT ${videoIdColumn || 'NULL AS video_public_id'}, ${thumbnailIdColumn || 'NULL AS thumbnail_public_id'} FROM episodes WHERE anime_id = ?`, [req.params.id]) : [[]];
      const [result] = await db.query('DELETE FROM anime WHERE id = ?', [req.params.id]);
      if (!result.affectedRows) return res.status(404).json({ message: 'Anime not found.' });
      for (const publicId of [assets[0]?.cover_public_id, assets[0]?.banner_public_id]) if (publicId) deleteImage(publicId).catch(error => console.error('Cloudinary image cleanup failed:', error.message));
      for (const asset of episodeAssets) { if (asset.video_public_id) cloudinaryVideo.deleteVideo(asset.video_public_id).catch(error => console.error('Cloudinary video cleanup failed:', error.message)); if (asset.thumbnail_public_id) deleteImage(asset.thumbnail_public_id).catch(error => console.error('Cloudinary thumbnail cleanup failed:', error.message)); }
       await logActivity(req, `Deleted anime #${req.params.id}`, 'anime', req.params.id);
       invalidateCatalogue(req.params.id);
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
    const animeId = Number(req.params.animeId); const { episode_number, title, description, thumbnail_url, thumbnail_public_id, video_url, duration_sec, is_premium = 0, public_id, cloudinary_public_id, intro_start_time, intro_end_time } = req.body;
    if (!Number.isInteger(animeId) || !Number.isInteger(Number(episode_number))) return res.status(400).json({ message: 'A valid episode number is required.' });
    try { const r = await insertExistingColumns('episodes', { anime_id: animeId, episode_number: Number(episode_number), title: title || null, description: description || null, thumbnail_url: thumbnail_url || null, thumbnail_public_id: thumbnail_public_id || null, video_url: video_url || null, duration_sec: numberOrNull(duration_sec), is_premium: toBool(is_premium) ? 1 : 0, cloudinary_public_id: cloudinary_public_id || public_id || null, intro_start_time: numberOrNull(intro_start_time), intro_end_time: numberOrNull(intro_end_time) }); await logActivity(req, `Created episode ${episode_number}`, 'episode', r.insertId); invalidateCatalogue(animeId); res.status(201).json({ id: r.insertId, message: 'Episode created.' }); } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: error.code === 'ER_DUP_ENTRY' ? 'This episode number already exists.' : error.message }); }
  },
  async updateEpisode(req, res) {
    const schema = await getSchema(); const fields = ['episode_number', 'title', 'description', 'thumbnail_url', 'thumbnail_public_id', 'video_url', 'duration_sec', 'is_premium', 'cloudinary_public_id', 'intro_start_time', 'intro_end_time']; const updates = []; const values = [];
    for (const field of fields) if (hasColumn(schema, 'episodes', field) && Object.prototype.hasOwnProperty.call(req.body, field)) { updates.push(`${field} = ?`); values.push(field === 'is_premium' ? (toBool(req.body[field]) ? 1 : 0) : ['duration_sec', 'episode_number', 'intro_start_time', 'intro_end_time'].includes(field) ? numberOrNull(req.body[field]) : req.body[field] || null); }
    if (!updates.length) return res.status(400).json({ message: 'No episode fields were supplied.' });
    try { const [r] = await db.query(`UPDATE episodes SET ${updates.join(', ')} WHERE id = ?`, [...values, req.params.id]); if (!r.affectedRows) return res.status(404).json({ message: 'Episode not found.' }); await logActivity(req, `Updated episode #${req.params.id}`, 'episode', req.params.id); invalidateCatalogue(); res.json({ message: 'Episode updated.' }); } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: error.code === 'ER_DUP_ENTRY' ? 'This episode number already exists.' : error.message }); }
  },
  async deleteEpisode(req, res) { try { const schema = await getSchema(); const videoColumn = hasColumn(schema, 'episodes', 'cloudinary_public_id') ? 'cloudinary_public_id' : null; const thumbnailColumn = hasColumn(schema, 'episodes', 'thumbnail_public_id') ? 'thumbnail_public_id' : null; const [rows] = await db.query(`SELECT ${videoColumn || 'NULL AS video_public_id'}, ${thumbnailColumn || 'NULL AS thumbnail_public_id'} FROM episodes WHERE id = ?`, [req.params.id]); if (!rows.length) return res.status(404).json({ message: 'Episode not found.' }); await db.query('DELETE FROM episodes WHERE id = ?', [req.params.id]); if (rows[0].video_public_id) cloudinaryVideo.deleteVideo(rows[0].video_public_id).catch(error => console.error('Cloudinary video cleanup failed:', error.message)); if (rows[0].thumbnail_public_id) deleteImage(rows[0].thumbnail_public_id).catch(error => console.error('Cloudinary thumbnail cleanup failed:', error.message)); await logActivity(req, `Deleted episode #${req.params.id}`, 'episode', req.params.id); invalidateCatalogue(); res.json({ message: 'Episode deleted.' }); } catch (error) { res.status(500).json({ message: error.message }); } },

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
  async updateSettings(req, res) { const aliases = { premium_monthly_amount: 'premium_price_monthly', premium_yearly_amount: 'premium_price_yearly' }; const allowed = new Set(['site_name', 'announcement', 'maintenance_mode', 'premium_price_monthly', 'premium_price_yearly', 'premium_monthly_amount', 'premium_yearly_amount', 'contact_email', 'cloudinary_cloud_name']); const entries = Object.entries(req.body).filter(([key]) => allowed.has(key)).map(([key, value]) => [aliases[key] || key, value === null || value === undefined ? '' : String(value)]); if (!entries.length) return res.status(400).json({ message: 'No settings were supplied.' }); try { await db.query('INSERT INTO settings (`key`, `value`) VALUES ? ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)', [entries]); await logActivity(req, 'Updated site settings', 'settings'); res.json(settingsResponse(await getSettingsObject())); } catch (error) { res.status(500).json({ message: error.message }); } },

  async getAds(req, res) { try { const [rows] = await db.query('SELECT * FROM ads ORDER BY created_at DESC'); res.json(rows.map(row => ({ ...row, banner_url: row.image_url, frequency_minutes: row.frequency, is_active: toBool(row.is_active), target_free_only: toBool(row.target_free_only) }))); } catch (error) { res.status(500).json({ message: error.message }); } },
  async createAd(req, res) { const { title, type = 'banner', image_url, banner_url, video_url, target_url, frequency, frequency_minutes, is_active = 1, target_free_only = 1 } = req.body; if (!title?.trim()) return res.status(400).json({ message: 'Ad title is required.' }); try { const [r] = await db.query('INSERT INTO ads (title, type, image_url, video_url, target_url, frequency, is_active, target_free_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [title.trim(), type, image_url || banner_url || null, video_url || null, target_url || null, Number(frequency ?? frequency_minutes) || 1, toBool(is_active) ? 1 : 0, toBool(target_free_only) ? 1 : 0]); await logActivity(req, `Created advertisement: ${title.trim()}`, 'ad', r.insertId); res.status(201).json({ id: r.insertId, message: 'Advertisement created.' }); } catch (error) { res.status(500).json({ message: error.message }); } },
  async updateAd(req, res) { const map = { banner_url: 'image_url', frequency_minutes: 'frequency' }; const allowed = new Set(['title', 'type', 'image_url', 'banner_url', 'video_url', 'target_url', 'frequency', 'frequency_minutes', 'is_active', 'target_free_only']); const updates = []; const values = []; for (const [key, value] of Object.entries(req.body)) if (allowed.has(key)) { const field = map[key] || key; updates.push(`${field} = ?`); values.push(['is_active', 'target_free_only'].includes(field) ? (toBool(value) ? 1 : 0) : field === 'frequency' ? Number(value) || 1 : value || null); } if (!updates.length) return res.status(400).json({ message: 'No advertisement fields were supplied.' }); try { const [r] = await db.query(`UPDATE ads SET ${updates.join(', ')} WHERE id = ?`, [...values, req.params.id]); if (!r.affectedRows) return res.status(404).json({ message: 'Advertisement not found.' }); await logActivity(req, `Updated advertisement #${req.params.id}`, 'ad', req.params.id); res.json({ message: 'Advertisement updated.' }); } catch (error) { res.status(500).json({ message: error.message }); } },
  async deleteAd(req, res) { try { const [r] = await db.query('DELETE FROM ads WHERE id = ?', [req.params.id]); if (!r.affectedRows) return res.status(404).json({ message: 'Advertisement not found.' }); await logActivity(req, `Deleted advertisement #${req.params.id}`, 'ad', req.params.id); res.json({ message: 'Advertisement deleted.' }); } catch (error) { res.status(500).json({ message: error.message }); } },

  async updatePaymentStatus(req, res) { const { status } = req.body; if (!['pending', 'successful', 'failed', 'refunded'].includes(status)) return res.status(400).json({ message: 'Invalid payment status.' }); try { const [r] = await db.query('UPDATE payments SET status = ?, paid_at = CASE WHEN ? = "successful" THEN COALESCE(paid_at, NOW()) ELSE paid_at END WHERE id = ?', [status, status, req.params.id]); if (!r.affectedRows) return res.status(404).json({ message: 'Payment not found.' }); await logActivity(req, `Updated payment #${req.params.id} to ${status}`, 'payment', req.params.id); res.json({ message: 'Payment updated.' }); } catch (error) { res.status(500).json({ message: error.message }); } },
  async getVideoStatus(req, res) { try { const video = await cloudinaryVideo.getVideo(req.params.videoId); res.json({ success: true, ...video, status: 'ready', video_status: 'ready', encodeProgress: 100 }); } catch (error) { res.status(502).json({ message: error.message }); } },

  // ─── Bulk Update Operations ─────────────────────────────────────

  async bulkUpdateAnime(req, res) {
    const { ids, action } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No anime IDs provided.' });
    if (!action) return res.status(400).json({ message: 'No action specified.' });

    const validActions = {
      mark_premium: { is_premium: 1 },
      remove_premium: { is_premium: 0 },
      feature: { is_featured: 1 },
      unfeature: { is_featured: 0 },
      publish: { status: 'completed' },
      unpublish: { status: 'upcoming' },
    };

    const updates = validActions[action];
    if (!updates) return res.status(400).json({ message: `Invalid action: ${action}` });

    try {
      const setClauses = Object.keys(updates).map(key => `\`${key}\` = ?`).join(', ');
      const values = Object.values(updates);
      values.push(ids);

      const [result] = await db.query(
        `UPDATE anime SET ${setClauses} WHERE id IN (?)`,
        values
      );

      await logActivity(req, `Bulk ${action} on ${result.affectedRows} anime`, 'anime', null, JSON.stringify(ids));
      invalidateCatalogue();

      res.json({ success: true, message: `Updated ${result.affectedRows} anime.`, affectedRows: result.affectedRows });
    } catch (error) {
      console.error('Bulk update anime error:', error);
      res.status(500).json({ message: error.message });
    }
  },

  // ─── Bulk Delete Operations ─────────────────────────────────────

  async bulkDeleteAnime(req, res) {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No anime IDs provided.' });
    try {
      const schema = await getSchema();

      // 1. Collect Cloudinary assets for cleanup
      const coverField = hasColumn(schema, 'anime', 'cover_public_id') ? 'cover_public_id' : 'NULL AS cover_public_id';
      const bannerField = hasColumn(schema, 'anime', 'banner_public_id') ? 'banner_public_id' : 'NULL AS banner_public_id';
      const [animeAssets] = await db.query(`SELECT id, ${coverField}, ${bannerField} FROM anime WHERE id IN (?)`, [ids]);

      const videoIdColumn = hasColumn(schema, 'episodes', 'cloudinary_public_id') ? 'cloudinary_public_id' : null;
      const thumbIdColumn = hasColumn(schema, 'episodes', 'thumbnail_public_id') ? 'thumbnail_public_id' : null;
      const [episodeAssets] = (videoIdColumn || thumbIdColumn)
        ? await db.query(`SELECT ${videoIdColumn || 'NULL AS video_public_id'}, ${thumbIdColumn || 'NULL AS thumbnail_public_id'} FROM episodes WHERE anime_id IN (?)`, [ids])
        : [[]];

      // 2. Delete episodes (foreign key safety)
      await db.query('DELETE FROM episodes WHERE anime_id IN (?)', [ids]);

      // 3. Delete anime
      const [result] = await db.query('DELETE FROM anime WHERE id IN (?)', [ids]);

      // 4. Cloudinary cleanup (async, non-blocking)
      for (const asset of animeAssets) {
        if (asset.cover_public_id) deleteImage(asset.cover_public_id).catch(err => console.error('Cover cleanup failed:', err.message));
        if (asset.banner_public_id) deleteImage(asset.banner_public_id).catch(err => console.error('Banner cleanup failed:', err.message));
      }
      for (const asset of (episodeAssets || [])) {
        if (asset.video_public_id) cloudinaryVideo.deleteVideo(asset.video_public_id).catch(err => console.error('Video cleanup failed:', err.message));
        if (asset.thumbnail_public_id) deleteImage(asset.thumbnail_public_id).catch(err => console.error('Thumbnail cleanup failed:', err.message));
      }

      // 5. Log activity
      await logActivity(req, `Bulk deleted ${result.affectedRows} anime`, 'anime', null, JSON.stringify(ids));
      invalidateCatalogue();

      res.json({ success: true, message: `Successfully deleted ${result.affectedRows} anime.` });
    } catch (error) {
      console.error('Bulk delete anime error:', error);
      res.status(500).json({ message: error.message });
    }
  },

  async bulkDeleteEpisodes(req, res) {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No episode IDs provided.' });
    try {
      const schema = await getSchema();
      const videoIdColumn = hasColumn(schema, 'episodes', 'cloudinary_public_id') ? 'cloudinary_public_id' : null;
      const thumbIdColumn = hasColumn(schema, 'episodes', 'thumbnail_public_id') ? 'thumbnail_public_id' : null;

      // 1. Fetch assets for cleanup
      const [assets] = await db.query(`SELECT ${videoIdColumn || 'NULL AS video_public_id'}, ${thumbIdColumn || 'NULL AS thumbnail_public_id'} FROM episodes WHERE id IN (?)`, [ids]);

      // 2. Delete episodes
      const [result] = await db.query('DELETE FROM episodes WHERE id IN (?)', [ids]);

      // 3. Cloudinary cleanup
      for (const asset of assets) {
        if (asset.video_public_id) cloudinaryVideo.deleteVideo(asset.video_public_id).catch(err => console.error('Video cleanup failed:', err.message));
        if (asset.thumbnail_public_id) deleteImage(asset.thumbnail_public_id).catch(err => console.error('Thumbnail cleanup failed:', err.message));
      }

      // 4. Log activity
      await logActivity(req, `Bulk deleted ${result.affectedRows} episodes`, 'episode', null, JSON.stringify(ids));
      invalidateCatalogue();

      res.json({ success: true, message: `Successfully deleted ${result.affectedRows} episodes.` });
    } catch (error) {
      console.error('Bulk delete episodes error:', error);
      res.status(500).json({ message: error.message });
    }
  },

  async bulkDeleteUsers(req, res) {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No user IDs provided.' });
    try {
      // Prevent admin from deleting themselves
      const safeIds = ids.filter(id => Number(id) !== Number(req.user.id));
      if (safeIds.length === 0) return res.status(400).json({ message: 'Cannot delete your own account. No other valid users selected.' });

      const [result] = await db.query('DELETE FROM users WHERE id IN (?)', [safeIds]);

      await logActivity(req, `Bulk deleted ${result.affectedRows} users`, 'user', null, JSON.stringify(safeIds));

      res.json({ success: true, message: `Successfully deleted ${result.affectedRows} user(s).` });
    } catch (error) {
      console.error('Bulk delete users error:', error);
      res.status(500).json({ message: error.message });
    }
  },
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

  // ─── Live Dashboard: Health Check ──────────────────────────────────
  async getDashboardHealth(req, res) {
    try {
      const schema = await getSchema();
      const start = Date.now();

      // Database health
      let dbStatus = 'healthy';
      let dbLatency = 0;
      try {
        const dbStart = Date.now();
        await db.query('SELECT 1');
        dbLatency = Date.now() - dbStart;
      } catch (e) {
        dbStatus = 'error';
      }

      // Provider health — check consumet or kitsu availability
      let providerStatus = 'unknown';
      try {
        const { default: kitsuProvider } = require('../services/kitsuProvider');
        if (kitsuProvider && typeof kitsuProvider.checkHealth === 'function') {
          const healthy = await kitsuProvider.checkHealth();
          providerStatus = healthy ? 'healthy' : 'degraded';
        } else {
          providerStatus = 'healthy'; // Assume healthy if no check
        }
      } catch (e) {
        providerStatus = 'degraded';
      }

      // API status (self-check)
      const apiLatency = Date.now() - start;

      // Server uptime
      const uptimeSeconds = Math.floor(process.uptime());
      const uptimeFormatted = uptimeSeconds >= 86400
        ? `${Math.floor(uptimeSeconds / 86400)}d ${Math.floor((uptimeSeconds % 86400) / 3600)}h`
        : uptimeSeconds >= 3600
        ? `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`
        : `${Math.floor(uptimeSeconds / 60)}m ${uptimeSeconds % 60}s`;

      // Storage usage (approximate from episodes table)
      let storageUsage = null;
      try {
        const [storageRows] = await db.query('SELECT COALESCE(SUM(LENGTH(video_url)), 0) AS total_bytes FROM episodes WHERE video_url IS NOT NULL');
        storageUsage = Math.round((Number(storageRows[0]?.total_bytes || 0) / (1024 * 1024 * 1024)) * 100) / 100;
      } catch (e) { /* non-critical */ }

      res.json({
        status: dbStatus === 'healthy' ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        checks: {
          database: { status: dbStatus, latency: `${dbLatency}ms` },
          streaming_providers: { status: providerStatus },
          api: { status: 'healthy', latency: `${apiLatency}ms` },
          server_uptime: { status: 'healthy', uptime: uptimeFormatted, seconds: uptimeSeconds },
          storage: { status: storageUsage !== null ? 'healthy' : 'unknown', usage_gb: storageUsage },
        }
      });
    } catch (error) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  },

  // ─── Live Dashboard: Chart Data ────────────────────────────────────
  async getChartData(req, res) {
    const { type } = req.params;
    const days = Math.min(parseInt(req.query.days) || 30, 90);

    try {
      switch (type) {
        case 'daily-users': {
          const [rows] = await db.query(`
            SELECT DATE(watched_at) AS date, COUNT(DISTINCT user_id) AS count
            FROM watch_history
            WHERE watched_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            GROUP BY DATE(watched_at)
            ORDER BY date ASC
          `, [days]);
          res.json({ labels: rows.map(r => r.date), values: rows.map(r => r.count) });
          break;
        }

        case 'revenue': {
          const [rows] = await db.query(`
            SELECT DATE_FORMAT(paid_at, '%Y-%m') AS month, COALESCE(SUM(amount), 0) AS total
            FROM payments WHERE status = 'successful' AND paid_at >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
            GROUP BY DATE_FORMAT(paid_at, '%Y-%m')
            ORDER BY month ASC
          `, [Math.ceil(days / 30)]);
          res.json({ labels: rows.map(r => r.month), values: rows.map(r => r.total) });
          break;
        }

        case 'anime-growth': {
          const [rows] = await db.query(`
            SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COUNT(*) AS count
            FROM anime
            WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
            GROUP BY DATE_FORMAT(created_at, '%Y-%m')
            ORDER BY month ASC
          `, [Math.ceil(days / 30)]);
          // Cumulative
          let cumulative = 0;
          const values = rows.map(r => { cumulative += Number(r.count); return cumulative; });
          res.json({ labels: rows.map(r => r.month), values });
          break;
        }

        case 'episode-views': {
          const [rows] = await db.query(`
            SELECT DATE(watched_at) AS date, COUNT(*) AS views
            FROM watch_history
            WHERE watched_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            GROUP BY DATE(watched_at)
            ORDER BY date ASC
          `, [days]);
          res.json({ labels: rows.map(r => r.date), values: rows.map(r => r.views) });
          break;
        }

        case 'genre-distribution': {
          const [rows] = await db.query(`
            SELECT g.name, COUNT(ag.anime_id) AS count
            FROM genres g
            JOIN anime_genres ag ON ag.genre_id = g.id
            GROUP BY g.id, g.name
            ORDER BY count DESC
            LIMIT 10
          `);
          res.json({ labels: rows.map(r => r.name), values: rows.map(r => r.count) });
          break;
        }

        case 'provider-usage': {
          const [rows] = await db.query(`
            SELECT COALESCE(video_source, 'direct') AS provider, COUNT(*) AS count
            FROM episodes
            GROUP BY provider
            ORDER BY count DESC
          `);
          res.json({ labels: rows.map(r => r.provider), values: rows.map(r => r.count) });
          break;
        }

        default:
          res.status(400).json({ message: `Unknown chart type: ${type}` });
      }
    } catch (error) {
      console.error(`[Charts] Error fetching ${type}:`, error.message);
      // Return empty data on error so the frontend can handle it gracefully
      res.json({ labels: [], values: [] });
    }
  },

  // ─── Live Dashboard: Recent Activity ───────────────────────────────
  async getRecentActivity(req, res) {
    try {
      const schema = await getSchema();
      const limit = Math.min(parseInt(req.query.limit) || 20, 50);

      // Combine recent anime, users, payments, and admin actions into a unified timeline
      const queries = [];

      // Recent anime additions
      queries.push(
        db.query(`
          SELECT 'anime' AS type, id, title AS label, NULL AS detail, created_at
          FROM anime ORDER BY created_at DESC LIMIT ?
        `, [limit])
      );

      // Recent user registrations
      queries.push(
        db.query(`
          SELECT 'user' AS type, id, name AS label, email AS detail, created_at
          FROM users ORDER BY created_at DESC LIMIT ?
        `, [limit])
      );

      // Recent payments
      if (hasColumn(await getSchema(), 'payments', 'paid_at')) {
        queries.push(
          db.query(`
            SELECT 'payment' AS type, id, name AS label, CONCAT(plan, ' - ', status) AS detail, paid_at AS created_at
            FROM payments WHERE paid_at IS NOT NULL ORDER BY paid_at DESC LIMIT ?
          `, [limit])
        );
      }

      // Recent admin actions
      const logTable = schema.activity_logs ? 'activity_logs' : 'admin_logs';
      const userIdCol = schema.activity_logs ? 'user_id' : 'admin_id';
      queries.push(
        db.query(`
          SELECT 'admin_action' AS type, l.id, l.action AS label, l.target_type AS detail, l.created_at
          FROM \`${logTable}\` l ORDER BY l.created_at DESC LIMIT ?
        `, [limit])
      );

      const results = await Promise.all(queries);
      const activities = results.flatMap(([rows]) => rows);

      // Sort by created_at descending
      activities.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      res.json(activities.slice(0, limit));
    } catch (error) {
      console.error('[Activity] Error fetching recent activity:', error.message);
      res.json([]);
    }
  },
};

module.exports = adminController;

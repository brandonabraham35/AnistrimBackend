const db = require('../config/db');
const cloudinaryVideo = require('../utils/bunnyStream');
const { deleteImage } = require('../utils/bunnyUpload');
const cache = require('../utils/cacheService');
const { sendSuccess, sendPaginated } = require('../utils/response');
const DTO = require('../services/adminDtoService');
const apiDto = require('../services/apiDtoService');

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

// Application anime access tiers (the inheritance source for episodes).
// Episodes support 'inherit' | 'free' | 'premium'; at the anime level only
// 'free' | 'premium' are valid targets for inheritance resolution.
const ANIME_ACCESS_TIERS = ['free', 'premium'];

// Reconcile an optional access_tier body value with is_premium so the two
// fields never contradict. access_tier is authoritative when supplied and
// valid; otherwise it is derived from is_premium.
function resolveAnimeAccessTier(bodyIsPremium, bodyAccessTier) {
  const rawTier = typeof bodyAccessTier === 'string' ? bodyAccessTier.toLowerCase() : '';
  const validTier = ANIME_ACCESS_TIERS.includes(rawTier) ? rawTier : null;
  const premiumFromFlag = toBool(bodyIsPremium) ? 1 : 0;
  if (validTier) return { is_premium: validTier === 'premium' ? 1 : 0, access_tier: validTier };
  return { is_premium: premiumFromFlag, access_tier: premiumFromFlag ? 'premium' : 'free' };
}
const invalidateCatalogue = animeId => {
  const jobs = [cache.delByPrefix('catalogue:')];
  // Keep the automatic home-shelf sections in sync whenever an admin
  // creates/updates/deletes anime OR an episode (publish/unpublish,
  // availability-window changes). Every episode mutation handler below
  // (createEpisode, updateEpisode, deleteEpisode, bulk delete) calls this
  // function so new content is never invisible for 6 hours. Failure is non-fatal.
  try {
    const homeShelf = require('../services/homeShelfService');
    jobs.push(homeShelf.invalidate());
  } catch (error) {
    console.warn('Home shelf invalidation failed:', error.message);
  }
  return Promise.all(jobs).catch(error => console.warn('Catalogue cache invalidation failed:', error.message));
};

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

const { logAdminAction } = require('../utils/auditLogger');

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
      const userNameExpr = hasColumn(schema, 'users', 'name') ? 'u.name' : 'u.email';
      const logsSql = schema.activity_logs
        ? `SELECT l.action, l.created_at, l.ip_address, ${userNameExpr} user_name FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.created_at DESC LIMIT 10`
        : `SELECT l.action, l.created_at, NULL ip_address, ${userNameExpr} user_name FROM admin_logs l LEFT JOIN users u ON u.id = l.admin_id ORDER BY l.created_at DESC LIMIT 10`;
      const recentEpisodesSql = "SELECT e.id, e.episode_number, e.title, e.thumbnail_url, CASE WHEN e.video_url IS NULL OR e.video_url = '' THEN 'missing' ELSE 'available' END video_status, e.created_at, a.title anime_title FROM episodes e JOIN anime a ON a.id = e.anime_id ORDER BY e.created_at DESC LIMIT 5";
      const results = await Promise.all([
        dashboardQuery('users', usersSql),
        dashboardQuery('anime totals', 'SELECT COUNT(*) totalAnime, COALESCE(SUM(view_count), 0) totalViews, COALESCE(AVG(rating), 0) avgRating FROM anime'),
        dashboardQuery('episode totals', episodeSql),
        dashboardQuery('daily activity', 'SELECT COUNT(DISTINCT user_id) activeToday, COUNT(*) dailyViews FROM watch_progress WHERE DATE(updated_at) = CURDATE()'),
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
        // Platform breakdown from analytics_events (if table exists)
        dashboardQuery('platform breakdown', `
          SELECT client_platform, COUNT(*) AS views
          FROM analytics_events
          WHERE event_type IN ('anime_view','episode_view','watch_start')
            AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
          GROUP BY client_platform`),
      ]);
      const users = results[0][0][0] || {};
      const content = results[1][0][0] || {};
      const episodes = results[2][0][0] || {};
      const activity = results[3][0][0] || {};
      const platformBreakdown = (results[11] && results[11][0] ? results[11][0] : []).map(r => ({ platform: r.client_platform, views: r.views }));
      return sendSuccess(res, {
        overview: {
          users: { total: Number(users.total) || 0, premium: Number(users.premium) || 0, activeToday: Number(activity.activeToday) || 0, banned: Number(users.banned) || 0 },
          content: { totalAnime: Number(content.totalAnime) || 0, totalEpisodes: Number(episodes.totalEpisodes) || 0, totalViews: (Number(content.totalViews) || 0) + (Number(episodes.episodeViews) || 0), dailyViews: Number(activity.dailyViews) || 0, avgRating: Number(content.avgRating) || 0 },
          storage: { usageGB: null, videoCount: Number(episodes.videoCount) || 0 },
          cloudinary: { ready: Number(episodes.videoCount) || 0, processing: Number(episodes.processingCount) || 0, failed: Number(episodes.failedCount) || 0 },
          revenue: results[8][0][0] || { total: 0, today: 0, month: 0 },
        },
        platformBreakdown,
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

      const data = anime.map(row => ({ ...DTO.animeDto(row), genres: genreMap[row.id] || [] }));

      return sendPaginated(res, data, { page, perPage: limit, totalItems: total });
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

      return sendSuccess(res, DTO.animeDto(anime));
    } catch (error) { res.status(500).json({ message: error.message }); }
  },

  async createAnime(req, res) {
    const { title, title_japanese, description, cover_image, banner_image, cover_public_id, banner_public_id, trailer_url, rating, year, studio, status = 'completed', is_premium = 0, is_featured = 0, tags, genres = [], access_tier } = req.body;
    if (!title?.trim()) return res.status(400).json({ message: 'Anime title is required.' });
    try {
      // access_tier is the single source of truth for episode inheritance
      // (utils/episodeAccess.js). Keep is_premium and access_tier consistent —
      // access_tier is authoritative when provided; otherwise derived from
      // is_premium so marking a title premium actually locks its episodes.
      const tier = resolveAnimeAccessTier(is_premium, access_tier);
      const result = await insertExistingColumns('anime', { title: title.trim(), title_japanese: title_japanese || null, description: description || null, cover_image: cover_image || null, banner_image: banner_image || null, cover_public_id: cover_public_id || null, banner_public_id: banner_public_id || null, trailer_url: trailer_url || null, rating: numberOrNull(rating), year: numberOrNull(year), studio: studio || null, status, is_premium: tier.is_premium, access_tier: tier.access_tier, is_featured: toBool(is_featured) ? 1 : 0, tags: tags || null });
       await adminController.replaceGenres(result.insertId, genres);
       invalidateCatalogue(result.insertId);
      await logActivity(req, `Created anime: ${title.trim()}`, 'anime', result.insertId);
      return sendSuccess(res, { id: result.insertId }, { message: 'Anime created.' }, 201);
    } catch (error) { res.status(500).json({ message: error.message }); }
  },

  async updateAnime(req, res) {
    const { title, title_japanese, description, cover_image, banner_image, cover_public_id, banner_public_id, trailer_url, rating, year, studio, status, is_premium, is_featured, tags, genres, access_tier } = req.body;
    try {
      const [existing] = await db.query('SELECT * FROM anime WHERE id = ?', [req.params.id]);
      if (!existing.length) return res.status(404).json({ message: 'Anime not found.' });
      const before = existing[0];
      const schema = await getSchema();
      // access_tier is the single source of truth for episode inheritance.
      // Reconcile is_premium + access_tier so they never contradict (access_tier
      // is authoritative when provided and valid; otherwise derived from
      // is_premium). (Issue 2 fix.)
      const tier = resolveAnimeAccessTier(is_premium, access_tier);
      const premiumVal = is_premium === undefined && access_tier === undefined ? undefined : tier.is_premium;
      const accessTierVal = is_premium === undefined && access_tier === undefined ? undefined : tier.access_tier;
      const values = { title: title?.trim(), title_japanese, description, cover_image, banner_image, cover_public_id, banner_public_id, trailer_url, rating: numberOrNull(rating), year: numberOrNull(year), studio, status, is_premium: premiumVal, access_tier: accessTierVal, is_featured: is_featured === undefined ? undefined : (toBool(is_featured) ? 1 : 0), tags };
      const entries = Object.entries(values).filter(([field, value]) => hasColumn(schema, 'anime', field) && value !== undefined);
      if (entries.length) await db.query(`UPDATE anime SET ${entries.map(([field]) => `\`${field}\` = ?`).join(', ')} WHERE id = ?`, [...entries.map(([, value]) => value), req.params.id]);
       if (Array.isArray(genres)) await adminController.replaceGenres(req.params.id, genres);
       invalidateCatalogue(req.params.id);
      await logActivity(req, `Updated anime #${req.params.id}`, 'anime', req.params.id);
      // Phase 5.3 — record the before/after audit trail via logAdminAction.
      await logAdminAction(req, { action: 'anime.update', entityType: 'anime', entityId: req.params.id, before, after: values });
      return sendSuccess(res, null, { message: 'Anime updated.' });
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
      return sendSuccess(res, null, { message: 'Anime deleted.' });
    } catch (error) { res.status(500).json({ message: error.message }); }
  },

  async replaceGenres(animeId, genres) {
    await db.query('DELETE FROM anime_genres WHERE anime_id = ?', [animeId]);
    const ids = [...new Set((genres || []).map(Number).filter(Number.isInteger))];
    if (ids.length) await db.query('INSERT IGNORE INTO anime_genres (anime_id, genre_id) VALUES ?', [ids.map(id => [animeId, id])]);
  },

  async getAllGenres(req, res) { try { const [rows] = await db.query('SELECT id, name FROM genres ORDER BY name'); return sendSuccess(res, rows); } catch (error) { res.status(500).json({ message: error.message }); } },
  async createGenre(req, res) { if (!req.body.name?.trim()) return res.status(400).json({ message: 'Genre name is required.' }); try { const [r] = await db.query('INSERT INTO genres (name) VALUES (?)', [req.body.name.trim()]); await logActivity(req, `Created genre: ${req.body.name.trim()}`, 'genre', r.insertId); return sendSuccess(res, { id: r.insertId, name: req.body.name.trim() }, null, 201); } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: error.code === 'ER_DUP_ENTRY' ? 'Genre already exists.' : error.message }); } },
  async deleteGenre(req, res) { try { const [r] = await db.query('DELETE FROM genres WHERE id = ?', [req.params.id]); if (!r.affectedRows) return res.status(404).json({ message: 'Genre not found.' }); await logActivity(req, `Deleted genre #${req.params.id}`, 'genre', req.params.id); return sendSuccess(res, null, { message: 'Genre deleted.' }); } catch (error) { res.status(500).json({ message: error.message }); } },

  async getAllEpisodes(req, res) {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const offset = (page - 1) * limit;

      const [countResult] = await db.query(
        'SELECT COUNT(*) AS total FROM episodes'
      );
      const total = countResult[0]?.total || 0;

      const [rows] = await db.query(
        'SELECT e.*, a.title anime_title FROM episodes e JOIN anime a ON a.id = e.anime_id ORDER BY e.created_at DESC LIMIT ? OFFSET ?',
        [limit, offset]
      );
      return sendPaginated(res, rows.map(DTO.episodeDto), { page, perPage: limit, totalItems: total });
    } catch (error) { res.status(500).json({ message: error.message }); }
  },
  async getAnimeEpisodes(req, res) {
    try {
      const animeId = req.params.animeId;
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const offset = (page - 1) * limit;

      const [countResult] = await db.query(
        'SELECT COUNT(*) AS total FROM episodes WHERE anime_id = ?',
        [animeId]
      );
      const total = countResult[0]?.total || 0;

      const [rows] = await db.query(
        'SELECT * FROM episodes WHERE anime_id = ? ORDER BY episode_number LIMIT ? OFFSET ?',
        [animeId, limit, offset]
      );
      return sendPaginated(res, rows.map(DTO.episodeDto), { page, perPage: limit, totalItems: total });
    } catch (error) { res.status(500).json({ message: error.message }); }
  },
  async getEpisode(req, res) { try { const [rows] = await db.query('SELECT * FROM episodes WHERE id = ?', [req.params.id]); if (!rows.length) return res.status(404).json({ message: 'Episode not found.' }); return sendSuccess(res, DTO.episodeDto(rows[0])); } catch (error) { res.status(500).json({ message: error.message }); } },
  // P2: server-side premium timing. Maps an admin-chosen duration label to a
  // premium_until timestamp (server clock, not device clock). 'permanent'/null
  // means null (permanent).
  resolvePremiumUntil(accessTier, duration, customUntil) {
    if (accessTier !== 'premium') return null;
    if (customUntil) return new Date(customUntil);
    if (!duration || duration === 'permanent') return null;
    const hours = { '24h': 24, '48h': 48, '72h': 72, '7d': 7 * 24 }[String(duration)];
    if (!hours) return null;
    const d = new Date(Date.now() + hours * 60 * 60 * 1000);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  },
  async addEpisode(req, res) {
    const animeId = Number(req.params.animeId); const { episode_number, title, description, thumbnail_url, thumbnail_public_id, video_url, manual_video_url, duration_sec, is_premium = 0, public_id, cloudinary_public_id, intro_start_time, intro_end_time, access_tier, premium_duration, premium_until } = req.body;
    if (!Number.isInteger(animeId) || !Number.isInteger(Number(episode_number))) return res.status(400).json({ message: 'A valid episode number is required.' });
    try {
      const resolvedTier = ['inherit', 'free', 'premium'].includes(access_tier) ? access_tier : 'inherit';
      const resolvedUntil = adminController.resolvePremiumUntil(resolvedTier, premium_duration, premium_until);
      const r = await insertExistingColumns('episodes', { anime_id: animeId, episode_number: Number(episode_number), title: title || null, description: description || null, thumbnail_url: thumbnail_url || null, thumbnail_public_id: thumbnail_public_id || null, video_url: video_url || null, manual_video_url: manual_video_url || null, duration_sec: numberOrNull(duration_sec), is_premium: toBool(is_premium) ? 1 : 0, access_tier: resolvedTier, premium_until: resolvedUntil, cloudinary_public_id: cloudinary_public_id || public_id || null, intro_start_time: numberOrNull(intro_start_time), intro_end_time: numberOrNull(intro_end_time) });
      await logActivity(req, `Created episode ${episode_number}`, 'episode', r.insertId); invalidateCatalogue(animeId);
      return sendSuccess(res, { id: r.insertId }, { message: 'Episode created.' }, 201);
    } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: error.code === 'ER_DUP_ENTRY' ? 'This episode number already exists.' : error.message }); }
  },
  async updateEpisode(req, res) {
    const schema = await getSchema(); const fields = ['episode_number', 'title', 'description', 'thumbnail_url', 'thumbnail_public_id', 'video_url', 'manual_video_url', 'duration_sec', 'is_premium', 'cloudinary_public_id', 'intro_start_time', 'intro_end_time', 'access_tier', 'premium_until']; const updates = []; const values = [];
    const hasReq = k => Object.prototype.hasOwnProperty.call(req.body, k);
    if (hasReq('access_tier')) { updates.push('access_tier = ?'); values.push(['inherit','free','premium'].includes(req.body.access_tier) ? req.body.access_tier : 'inherit'); }
    if (hasReq('premium_duration') || hasReq('premium_until')) {
      const tier = hasReq('access_tier') ? req.body.access_tier : (req.body.access_tier || 'inherit');
      updates.push('premium_until = ?'); values.push(adminController.resolvePremiumUntil(tier, req.body.premium_duration, req.body.premium_until));
    }
    for (const field of fields) if (!['access_tier','premium_until'].includes(field) && hasColumn(schema, 'episodes', field) && hasReq(field)) { updates.push(`${field} = ?`); values.push(field === 'is_premium' ? (toBool(req.body[field]) ? 1 : 0) : ['duration_sec', 'episode_number', 'intro_start_time', 'intro_end_time'].includes(field) ? numberOrNull(req.body[field]) : req.body[field] || null); }
    if (!updates.length) return res.status(400).json({ message: 'No episode fields were supplied.' });
    try { const [r] = await db.query(`UPDATE episodes SET ${updates.join(', ')} WHERE id = ?`, [...values, req.params.id]); if (!r.affectedRows) return res.status(404).json({ message: 'Episode not found.' }); await logActivity(req, `Updated episode #${req.params.id}`, 'episode', req.params.id); invalidateCatalogue(); return sendSuccess(res, null, { message: 'Episode updated.' }); } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: error.code === 'ER_DUP_ENTRY' ? 'This episode number already exists.' : error.message }); }
  },
  async deleteEpisode(req, res) { try { const schema = await getSchema(); const videoColumn = hasColumn(schema, 'episodes', 'cloudinary_public_id') ? 'cloudinary_public_id' : null; const thumbnailColumn = hasColumn(schema, 'episodes', 'thumbnail_public_id') ? 'thumbnail_public_id' : null; const [rows] = await db.query(`SELECT ${videoColumn || 'NULL AS video_public_id'}, ${thumbnailColumn || 'NULL AS thumbnail_public_id'} FROM episodes WHERE id = ?`, [req.params.id]); if (!rows.length) return res.status(404).json({ message: 'Episode not found.' }); await db.query('DELETE FROM episodes WHERE id = ?', [req.params.id]); if (rows[0].video_public_id) cloudinaryVideo.deleteVideo(rows[0].video_public_id).catch(error => console.error('Cloudinary video cleanup failed:', error.message)); if (rows[0].thumbnail_public_id) deleteImage(rows[0].thumbnail_public_id).catch(error => console.error('Cloudinary thumbnail cleanup failed:', error.message)); await logActivity(req, `Deleted episode #${req.params.id}`, 'episode', req.params.id); invalidateCatalogue(); return sendSuccess(res, null, { message: 'Episode deleted.' }); } catch (error) { res.status(500).json({ message: error.message }); } },

  async getAllUsers(req, res) {
    try {
      const schema = await getSchema();
      const status = hasColumn(schema, 'users', 'status') ? 'status' : "'unavailable' AS status";
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const offset = (page - 1) * limit;
      const [countRows] = await db.query('SELECT COUNT(*) AS total FROM users');
      const total = countRows[0]?.total || 0;
      const [rows] = await db.query(
        `SELECT id, name, email, is_admin, is_premium, premium_expires_at, ${status}, created_at, updated_at, avatar_url
         FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [limit, offset]
      );
      return sendPaginated(res, rows.map(DTO.userDto), { page, perPage: limit, totalItems: total });
    } catch (error) { res.status(500).json({ message: error.message }); }
  },
  async updateUser(req, res) {
    const allowed = ['name', 'email', 'status', 'is_admin', 'is_premium', 'premium_expires_at'];
    const updates = [];
    const values = [];
    let adminChange = null;
    let premiumChange = null;
    let premiumExpiresAt = null;
    for (const field of allowed) if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      updates.push(`${field} = ?`);
      const coerced = field === 'is_premium' || field === 'is_admin' ? (toBool(req.body[field]) ? 1 : 0) : req.body[field];
      values.push(coerced);
      if (field === 'is_admin') adminChange = coerced === 1;
      if (field === 'is_premium') premiumChange = coerced === 1;
      if (field === 'premium_expires_at') premiumExpiresAt = coerced;
    }
    if (!updates.length) return res.status(400).json({ message: 'No editable user fields were supplied.' });
    try {
      const [r] = await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, [...values, req.params.id]);
      if (!r.affectedRows) return res.status(404).json({ message: 'User not found.' });
      // P1: keep the dedicated user_roles table authoritative for admin.
      if (adminChange !== null) {
        const role = require('../utils/hasRole');
        if (adminChange) await role.grantRole(req.params.id, 'admin');
        else await role.revokeRole(req.params.id, 'admin');
      }
      // Prompt 5: Admin premium grant/revoke must create/terminate a real
      // subscription row with source='admin_grant', state='active', an explicit
      // ends_at, and a payment_events audit entry. This prevents
      // premiumScheduler.sweepSubscriptions() from wiping the grant every 10 min.
      if (premiumChange !== null) {
        const userId = req.params.id;
        if (premiumChange) {
          // Grant: create an admin_grant subscription.
          const endsAt = premiumExpiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // default 1 year
          const [subResult] = await db.query(
            `INSERT INTO subscriptions
              (user_id, reference, amount, currency, status, plan, plan_id, starts_at, ends_at, state, source)
             VALUES (?, ?, 0, 'UGX', 'COMPLETED', 'admin_grant', NULL, NOW(), ?, 'active', 'admin_grant')`,
            [userId, `ADMIN-GRANT-${userId}-${Date.now()}`, endsAt]
          );
          // Audit entry.
          try {
            await db.query(
              `INSERT INTO payment_events (subscription_id, reference, event, payload)
               VALUES (?, ?, 'admin_grant', ?)`,
              [subResult.insertId, `ADMIN-GRANT-${userId}-${Date.now()}`, JSON.stringify({ by: req.user?.id || null, ends_at: endsAt })]
            );
          } catch (e) { console.warn('[Admin] payment_events write failed:', e.message); }
        } else {
          // Revoke: terminate all active admin_grant subscriptions.
          await db.query(
            `UPDATE subscriptions SET state = 'cancelled', status = 'CANCELLED'
             WHERE user_id = ? AND source = 'admin_grant' AND state IN ('active','grace','trialing')`,
            [userId]
          );
          // Audit entry.
          try {
            await db.query(
              `INSERT INTO payment_events (subscription_id, reference, event, payload)
               VALUES (NULL, ?, 'admin_revoke', ?)`,
              [`ADMIN-REVOKE-${userId}-${Date.now()}`, JSON.stringify({ by: req.user?.id || null })]
            );
          } catch (e) { console.warn('[Admin] payment_events write failed:', e.message); }
        }
        // Refresh the derived users.is_premium cache from subscriptions.
        try {
          const { refreshUserPremiumCache } = require('../controllers/paymentController');
          await refreshUserPremiumCache(userId);
        } catch (e) { console.warn('[Admin] premium cache refresh failed:', e.message); }
      }
      await logActivity(req, `Updated user #${req.params.id}`, 'user', req.params.id);
      return sendSuccess(res, null, { message: 'User updated.' });
    } catch (error) { res.status(500).json({ message: error.message }); }
  },

  async getSettings(req, res) { try { return sendSuccess(res, settingsResponse(await getSettingsObject())); } catch (error) { res.status(500).json({ message: error.message }); } },
  async updateSettings(req, res) { const aliases = { premium_monthly_amount: 'premium_price_monthly', premium_yearly_amount: 'premium_price_yearly' }; const allowed = new Set(['site_name', 'announcement', 'maintenance_mode', 'premium_price_monthly', 'premium_price_yearly', 'premium_monthly_amount', 'premium_yearly_amount', 'contact_email', 'cloudinary_cloud_name']); const entries = Object.entries(req.body).filter(([key]) => allowed.has(key)).map(([key, value]) => [aliases[key] || key, value === null || value === undefined ? '' : String(value)]); if (!entries.length) return res.status(400).json({ message: 'No settings were supplied.' }); try { await db.query('INSERT INTO settings (`key`, `value`) VALUES ? ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)', [entries]); await logActivity(req, 'Updated site settings', 'settings'); return sendSuccess(res, settingsResponse(await getSettingsObject())); } catch (error) { res.status(500).json({ message: error.message }); } },

  async getAds(req, res) { try { const [rows] = await db.query('SELECT * FROM ads ORDER BY created_at DESC'); return sendSuccess(res, rows.map(DTO.adDto)); } catch (error) { res.status(500).json({ message: error.message }); } },
  async createAd(req, res) { const { title, type = 'banner', image_url, banner_url, video_url, target_url, frequency, frequency_minutes, is_active = 1, target_free_only = 1 } = req.body; if (!title?.trim()) return res.status(400).json({ message: 'Ad title is required.' }); try { const [r] = await db.query('INSERT INTO ads (title, type, image_url, video_url, target_url, frequency, is_active, target_free_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [title.trim(), type, image_url || banner_url || null, video_url || null, target_url || null, Number(frequency ?? frequency_minutes) || 1, toBool(is_active) ? 1 : 0, toBool(target_free_only) ? 1 : 0]); await logActivity(req, `Created advertisement: ${title.trim()}`, 'ad', r.insertId); return sendSuccess(res, { id: r.insertId }, { message: 'Advertisement created.' }, 201); } catch (error) { res.status(500).json({ message: error.message }); } },
  async updateAd(req, res) { const map = { banner_url: 'image_url', frequency_minutes: 'frequency' }; const allowed = new Set(['title', 'type', 'image_url', 'banner_url', 'video_url', 'target_url', 'frequency', 'frequency_minutes', 'is_active', 'target_free_only']); const updates = []; const values = []; for (const [key, value] of Object.entries(req.body)) if (allowed.has(key)) { const field = map[key] || key; updates.push(`${field} = ?`); values.push(['is_active', 'target_free_only'].includes(field) ? (toBool(value) ? 1 : 0) : field === 'frequency' ? Number(value) || 1 : value || null); } if (!updates.length) return res.status(400).json({ message: 'No advertisement fields were supplied.' }); try { const [r] = await db.query(`UPDATE ads SET ${updates.join(', ')} WHERE id = ?`, [...values, req.params.id]); if (!r.affectedRows) return res.status(404).json({ message: 'Advertisement not found.' }); await logActivity(req, `Updated advertisement #${req.params.id}`, 'ad', req.params.id); return sendSuccess(res, null, { message: 'Advertisement updated.' }); } catch (error) { res.status(500).json({ message: error.message }); } },
  async deleteAd(req, res) { try { const [r] = await db.query('DELETE FROM ads WHERE id = ?', [req.params.id]); if (!r.affectedRows) return res.status(404).json({ message: 'Advertisement not found.' }); await logActivity(req, `Deleted advertisement #${req.params.id}`, 'ad', req.params.id); return sendSuccess(res, null, { message: 'Advertisement deleted.' }); } catch (error) { res.status(500).json({ message: error.message }); } },

  // ── GET /api/admin/dashboard/ads-metrics ────────────────────
  // Per-slot, per-day ad_events breakdown for the last 30 days, plus fill-rate
  // = impressions / (impressions + fail + timeout). Makes the ad_events write
  // path verifiable in the admin dashboard.
  async getAdsMetrics(req, res) {
    try {
      const [rows] = await db.query(
        `SELECT
           DATE(created_at) AS day,
           slot,
           SUM(event = 'impression') AS impressions,
           SUM(event = 'click')      AS clicks,
           SUM(event = 'fail')       AS fails,
           SUM(event = 'skip')       AS skips,
           SUM(event = 'timeout')    AS timeouts
         FROM ad_events
         WHERE created_at >= CURDATE() - INTERVAL 30 DAY
         GROUP BY DATE(created_at), slot
         ORDER BY day ASC, slot ASC`
      );

      // Build a per-day map keyed by slot for the chart.
      const days = [];
      const bySlot = {};
      const slotSet = new Set();
      for (const r of rows) {
        const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
        if (!days.includes(day)) days.push(day);
        const slot = r.slot || 'unknown';
        slotSet.add(slot);
        if (!bySlot[slot]) bySlot[slot] = {};
        bySlot[slot][day] = {
          impressions: Number(r.impressions) || 0,
          clicks: Number(r.clicks) || 0,
          fails: Number(r.fails) || 0,
          skips: Number(r.skips) || 0,
          timeouts: Number(r.timeouts) || 0,
        };
      }

      // Fill-rate per slot per day: impressions / (impressions + fail + timeout).
      const slots = Array.from(slotSet).sort();
      const series = slots.map(slot => {
        const perDay = days.map(day => {
          const d = bySlot[slot] && bySlot[slot][day];
          const imp = d ? d.impressions : 0;
          const fail = d ? d.fails : 0;
          const timeout = d ? d.timeouts : 0;
          const denominator = imp + fail + timeout;
          return {
            day,
            impressions: imp,
            clicks: d ? d.clicks : 0,
            fails: fail,
            skips: d ? d.skips : 0,
            timeouts: timeout,
            fillRate: denominator > 0 ? Number(((imp / denominator) * 100).toFixed(1)) : 0,
          };
        });
        return { slot, perDay };
      });

      return sendSuccess(res, { days, slots, series });
    } catch (error) {
      console.error('[Admin] getAdsMetrics error:', error.message);
      return res.status(500).json({ message: 'Unable to load ads metrics.' });
    }
  },

  async updatePaymentStatus(req, res) { const { status } = req.body; if (!['pending', 'successful', 'failed', 'refunded'].includes(status)) return res.status(400).json({ message: 'Invalid payment status.' }); try { const [r] = await db.query('UPDATE payments SET status = ?, paid_at = CASE WHEN ? = "successful" THEN COALESCE(paid_at, NOW()) ELSE paid_at END WHERE id = ?', [status, status, req.params.id]); if (!r.affectedRows) return res.status(404).json({ message: 'Payment not found.' }); await logActivity(req, `Updated payment #${req.params.id} to ${status}`, 'payment', req.params.id); return sendSuccess(res, null, { message: 'Payment updated.' }); } catch (error) { res.status(500).json({ message: error.message }); } },
  async uploadEpisodeVideo(req, res) {
    const episodeId = Number(req.params.id);
    if (!Number.isInteger(episodeId)) return res.status(400).json({ message: 'Invalid episode ID.' });
    const file = req.file;
    if (!file) return res.status(400).json({ message: 'No video file uploaded.' });
    try {
      const video = await cloudinaryVideo.uploadVideo(file.path);
      const videoUrl = video.secure_url;
      const schema = await getSchema();
      if (hasColumn(schema, 'episodes', 'manual_video_url')) {
        await db.query('UPDATE episodes SET manual_video_url = ? WHERE id = ?', [videoUrl, episodeId]);
      } else {
        await db.query('UPDATE episodes SET video_url = ? WHERE id = ?', [videoUrl, episodeId]);
      }
      await logActivity(req, `Uploaded video for episode #${episodeId}`, 'episode', episodeId);
      return sendSuccess(res, { url: videoUrl, public_id: video.public_id, duration: video.duration, manual_video_url: videoUrl }, { message: 'Video uploaded and linked to episode.' }, 201);
    } catch (error) {
      console.error('[Admin] uploadEpisodeVideo error:', error.message);
      return res.status(502).json({ message: error.message || 'Video upload failed.' });
    } finally {
      if (file.path) require('fs').promises.unlink(file.path).catch(() => {});
    }
  },

  // ─── Bulk Update Operations ─────────────────────────────────────

  async bulkUpdateAnime(req, res) {
    const { ids, action } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No anime IDs provided.' });
    if (!action) return res.status(400).json({ message: 'No action specified.' });

    // Validate all ids are integers — reject anything else.
    if (!ids.every(id => Number.isInteger(Number(id)) && Number(id) > 0)) {
      return res.status(400).json({ message: 'All anime IDs must be positive integers.' });
    }
    const cleanIds = ids.map(id => Number(id));

    const validActions = {
      // is_premium + access_tier stay synchronized so the access authority
      // (anime.access_tier) matches the display flag. (Issue 2 fix.)
      mark_premium: { is_premium: 1, access_tier: 'premium' },
      remove_premium: { is_premium: 0, access_tier: 'free' },
      feature: { is_featured: 1 },
      unfeature: { is_featured: 0 },
      publish: { is_published: 1 },
      unpublish: { is_published: 0 },
    };

    const updates = validActions[action];
    if (!updates) return res.status(400).json({ message: `Invalid action: ${action}` });

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const setClauses = Object.keys(updates).map(key => `\`${key}\` = ?`).join(', ');
      const values = Object.values(updates);
      values.push(cleanIds);

      const [result] = await conn.query(
        `UPDATE anime SET ${setClauses} WHERE id IN (?)`,
        values
      );

      await conn.commit();

      // Audit via logAdminAction (entity_type/entity_id/before/after).
      const { logAdminAction } = require('../utils/auditLogger');
      await logAdminAction({
        action: `bulk_${action}`,
        entityType: 'anime',
        entityId: cleanIds.join(','),
        before: null,
        after: updates,
        req,
      });

      invalidateCatalogue();

      return sendSuccess(res, { affectedRows: result.affectedRows }, { message: `Updated ${result.affectedRows} anime.` });
    } catch (error) {
      try { await conn.rollback(); } catch (e) {}
      console.error('Bulk update anime error:', error);
      res.status(500).json({ message: error.message });
    } finally {
      conn.release();
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

      return sendSuccess(res, { affectedRows: result.affectedRows }, { message: `Successfully deleted ${result.affectedRows} anime.` });
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

      return sendSuccess(res, { affectedRows: result.affectedRows }, { message: `Successfully deleted ${result.affectedRows} episodes.` });
    } catch (error) {
      console.error('Bulk delete episodes error:', error);
      res.status(500).json({ message: error.message });
    }
  },

async getPayments(req, res) {
    try {
      const schema = await getSchema();
      const { page = 1, limit = 25, search, status, from, to, sort = 'created_at', order = 'desc' } = req.query;
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
      const offset = (pageNum - 1) * limitNum;
      const params = [];
      const where = [];

      if (status) { where.push('p.status = ?'); params.push(status); }
      if (from) { where.push('p.created_at >= ?'); params.push(from); }
      if (to) { where.push('p.created_at <= ?'); params.push(to); }
if (search) {
        const userNameColumn = hasColumn(schema, 'users', 'name') ? 'u.name' : 'u.email';
        where.push(`(${userNameColumn} LIKE ? OR u.email LIKE ? OR p.flw_tx_ref LIKE ?)`);
        const q = `%${search}%`;
        params.push(q, q, q);
      }

      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const sortColumn = ['created_at', 'amount', 'status', 'paid_at'].includes(sort) ? sort : 'created_at';
      const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

      const [countResult] = await db.query(
        `SELECT COUNT(*) AS total FROM payments p LEFT JOIN users u ON u.id = p.user_id ${whereClause}`,
        params
      );
      const total = countResult[0]?.total || 0;

      const userNameColumn = hasColumn(schema, 'users', 'name') ? 'u.name' : 'u.email';
      const [rows] = await db.query(
        `SELECT p.*, ${userNameColumn} AS name, u.email FROM payments p LEFT JOIN users u ON u.id = p.user_id ${whereClause} ORDER BY p.${sortColumn} ${sortOrder} LIMIT ? OFFSET ?`,
        [...params, limitNum, offset]
      );

      return sendPaginated(res, rows.map(DTO.paymentDto), { page: pageNum, perPage: limitNum, totalItems: total }, { summary: { total } });
    } catch (error) {
      console.error('getPayments error:', error);
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

      return sendSuccess(res, { affectedRows: result.affectedRows }, { message: `Successfully deleted ${result.affectedRows} user(s).` });
    } catch (error) {
      console.error('Bulk delete users error:', error);
      res.status(500).json({ message: error.message });
    }
  },
async updateGenre(req, res) {
    if (!req.body.name?.trim()) return res.status(400).json({ message: 'Genre name is required.' });
    try {
      const [r] = await db.query('UPDATE genres SET name = ? WHERE id = ?', [req.body.name.trim(), req.params.id]);
      if (!r.affectedRows) return res.status(404).json({ message: 'Genre not found.' });
      await logActivity(req, `Updated genre #${req.params.id} to: ${req.body.name.trim()}`, 'genre', req.params.id);
      return sendSuccess(res, { id: parseInt(req.params.id), name: req.body.name.trim() }, { message: 'Genre updated.' });
    } catch (error) {
      res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: error.code === 'ER_DUP_ENTRY' ? 'Genre name already exists.' : error.message });
    }
  },

  async getUser(req, res) {
    try {
      const schema = await getSchema();
      const status = hasColumn(schema, 'users', 'status') ? 'status' : "'active' AS status";
      const [rows] = await db.query(
        `SELECT id, name, email, is_admin, is_premium, premium_expires_at, ${status}, created_at, updated_at, avatar_url FROM users WHERE id = ?`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ message: 'User not found.' });
      return sendSuccess(res, DTO.userDto(rows[0]));
    } catch (error) { res.status(500).json({ message: error.message }); }
  },

  async getUserWatchHistory(req, res) {
    try {
      const schema = await getSchema();
      if (!hasColumn(schema, 'watch_progress', 'user_id')) {
        return sendSuccess(res, []);
      }
      const [rows] = await db.query(
        `SELECT wh.id, wh.episode_id, wh.position_sec AS progress_sec, wh.completed, wh.updated_at AS watched_at,
                e.episode_number, e.title AS episode_title, a.title AS anime_title, a.id AS anime_id
         FROM watch_progress wh
         JOIN episodes e ON e.id = wh.episode_id
         JOIN anime a ON a.id = e.anime_id
         WHERE wh.user_id = ?
         ORDER BY wh.updated_at DESC
         LIMIT 50`,
        [req.params.id]
      );
      return sendSuccess(res, rows);
    } catch (error) { res.status(500).json({ message: error.message }); }
  },

  async getUserLoginHistory(req, res) {
    try {
      const schema = await getSchema();
      if (!hasColumn(schema, 'users', 'last_login')) {
        const [rows] = await db.query(
          `SELECT id, created_at AS login_time, 'signup' AS method FROM users WHERE id = ?
           UNION ALL
           SELECT id, updated_at AS login_time, 'update' AS method FROM users WHERE id = ? AND updated_at != created_at
           ORDER BY login_time DESC LIMIT 20`,
          [req.params.id, req.params.id]
        );
        return sendSuccess(res, rows);
      } else {
        const [rows] = await db.query(
          `SELECT last_login AS login_time, 'login' AS method FROM users WHERE id = ? AND last_login IS NOT NULL
           ORDER BY login_time DESC LIMIT 20`,
          [req.params.id]
        );
        return sendSuccess(res, rows);
      }
    } catch (error) { res.status(500).json({ message: error.message }); }
  },

  async getActivityLogs(req, res) {
    try {
      const schema = await getSchema();
      const userNameExpr = hasColumn(schema, 'users', 'name') ? 'u.name' : 'u.email';
      const sql = schema.activity_logs
        ? `SELECT a.action, a.created_at, a.ip_address, ${userNameExpr} user_name FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 50`
        : `SELECT a.action, a.created_at, NULL ip_address, ${userNameExpr} user_name FROM admin_logs a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.created_at DESC LIMIT 50`;
      const [rows] = await db.query(sql);
      return sendSuccess(res, rows.map(DTO.logDto));
    } catch (error) { res.status(500).json({ message: error.message }); }
  },

  // ─── Live Dashboard: Health Check (Phase 9 / item 20) ───────────────
  // Probes API, DB, cache, streaming, payments, email, Google OAuth, storage —
  // each { status, latencyMs, lastError, checkedAt } — 30 s cached, sampled to
  // health_samples for sparklines. Admin-only, 30 s cache.
  async getDashboardHealth(req, res) {
    try {
      const healthService = require('../services/healthService');
      const snapshot = await healthService.getHealthSnapshot();

      // Server uptime (kept alongside the probe grid).
      const uptimeSeconds = Math.floor(process.uptime());
      const uptimeFormatted = uptimeSeconds >= 86400
        ? `${Math.floor(uptimeSeconds / 86400)}d ${Math.floor((uptimeSeconds % 86400) / 3600)}h`
        : uptimeSeconds >= 3600
        ? `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`
        : `${Math.floor(uptimeSeconds / 60)}m ${uptimeSeconds % 60}s`;

      // Standardize overall status on the 'up'|'degraded'|'down' vocabulary.
      // Critical components (api, database): any down → overall down.
      // Any component down or degraded → overall degraded. Else → up.
      const { api: apiCheck, database: dbCheck } = snapshot;
      let overall = 'up';
      if (apiCheck?.status === 'down' || dbCheck?.status === 'down') {
        overall = 'down';
      } else {
        const anyDownOrDegraded = Object.entries(snapshot)
          .filter(([k, v]) => k !== 'checkedAt' && v && typeof v === 'object' && v.status)
          .some(([, v]) => v.status === 'down' || v.status === 'degraded');
        if (anyDownOrDegraded) overall = 'degraded';
      }

      return sendSuccess(res, {
        status: overall,
        timestamp: new Date().toISOString(),
        checks: {
          api: snapshot.api,
          database: snapshot.database,
          cache: snapshot.cache,
          streaming_providers: snapshot.streaming,
          payments: snapshot.payments,
          email: snapshot.email,
          google_oauth: snapshot.google_oauth,
          storage: snapshot.storage,
        },
        server_uptime: { status: 'up', uptime: uptimeFormatted, seconds: uptimeSeconds },
      });
    } catch (error) {
      console.error('[Admin] getDashboardHealth error:', error.message);
      res.status(500).json({ status: 'error', message: 'Unable to load health snapshot.' });
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
            SELECT DATE(updated_at) AS date, COUNT(DISTINCT user_id) AS count
            FROM watch_progress
            WHERE updated_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            GROUP BY DATE(updated_at)
            ORDER BY date ASC
          `, [days]);
          return sendSuccess(res, { labels: rows.map(r => r.date), values: rows.map(r => r.count) });
        }

        case 'revenue': {
          const [rows] = await db.query(`
            SELECT DATE_FORMAT(paid_at, '%Y-%m') AS month, COALESCE(SUM(amount), 0) AS total
            FROM payments WHERE status = 'successful' AND paid_at >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
            GROUP BY DATE_FORMAT(paid_at, '%Y-%m')
            ORDER BY month ASC
          `, [Math.ceil(days / 30)]);
          return sendSuccess(res, { labels: rows.map(r => r.month), values: rows.map(r => r.total) });
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
          return sendSuccess(res, { labels: rows.map(r => r.month), values });
        }

        case 'episode-views': {
          const [rows] = await db.query(`
            SELECT DATE(updated_at) AS date, COUNT(*) AS views
            FROM watch_progress
            WHERE updated_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            GROUP BY DATE(updated_at)
            ORDER BY date ASC
          `, [days]);
          return sendSuccess(res, { labels: rows.map(r => r.date), values: rows.map(r => r.views) });
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
          return sendSuccess(res, { labels: rows.map(r => r.name), values: rows.map(r => r.count) });
        }

case 'provider-usage': {
          // Count episodes with video_url (those with a provider source)
          const [rows] = await db.query(`
            SELECT COALESCE(video_url IS NOT NULL AND video_url != '', 0) AS has_video, COUNT(*) AS count
            FROM episodes
            GROUP BY has_video
          `);
          const hasVideo = rows.find(r => r.has_video == 1);
          const noVideo = rows.find(r => r.has_video == 0);
          return sendSuccess(res, {
            labels: ['With Video Source', 'No Video Source'],
            values: [(hasVideo?.count || 0), (noVideo?.count || 0)]
          });
        }

        default:
          res.status(400).json({ message: `Unknown chart type: ${type}` });
      }
    } catch (error) {
      console.error(`[Charts] Error fetching ${type}:`, error.message);
      // Return empty data on error so the frontend can handle it gracefully
      return sendSuccess(res, { labels: [], values: [] });
    }
  },

  // ─── Health & Reliability Metrics (admin widgets) ─────────────────
  // Aggregated health history, p50/p95 latency, 5xx rate, stream failures,
  // payment failures and email failures. All queries are defensive (table/column
  // schema-gated) so a not-yet-migrated table returns an empty source instead
  // of erroring. Endpoints are admin-only (see routes/adminRoutes.js).
  async getHealthMetrics(req, res) {
    try {
      const metrics = require('../services/adminHealthMetrics');
      const hours = req.query.hours;
      const component = req.query.component || null;

      const [history, latency, fivexx, stream, payments, email, streamCache] = await Promise.all([
        metrics.getHealthHistory({ component, hours }),
        metrics.getLatencyPercentiles({ hours }),
        metrics.get5xxRate({ hours }),
        metrics.getStreamFailures({ hours }),
        metrics.getPaymentFailures({ hours }),
        metrics.getEmailFailures({ hours }),
        metrics.getStreamCacheMetrics(),
      ]);

      // Compute "degraded since <ts>" for the requested component (if any) or
      // the overall point set.
      const degradedSince = metrics.degradedSince(history.points, component);

      return sendSuccess(res, {
        health: { ...history, degradedSince },
        latency: { p50: latency.p50, p95: latency.p95, samples: latency.samples, source: latency.source, hours: latency.hours },
        fivexx: { buckets: fivexx.buckets, source: fivexx.source, hours: fivexx.hours },
        stream: { byProvider: stream.byProvider, topEpisodes: stream.topEpisodes, liveProvider: stream.liveProvider, source: stream.source, hours: stream.hours },
        payments: { buckets: payments.buckets, source: payments.source, hours: payments.hours },
        email: { buckets: email.buckets, source: email.source, hours: email.hours },
        streamCache: {
          redisHits: streamCache.redisHits,
          mysqlHits: streamCache.mysqlHits,
          cacheMisses: streamCache.cacheMisses,
          resolverCalls: streamCache.resolverCalls,
          animeHeavenCalls: streamCache.animeHeavenCalls,
          consumetCalls: streamCache.consumetCalls,
          verificationSuccesses: streamCache.verificationSuccesses,
          verificationFailures: streamCache.verificationFailures,
          playbackReportedFailures: streamCache.playbackReportedFailures,
          activeCachedSources: streamCache.activeCachedSources,
          knownExpirySources: streamCache.knownExpirySources,
          unknownExpirySources: streamCache.unknownExpirySources,
          averageSourceLifetimeMs: streamCache.averageSourceLifetimeMs,
        },
      });
    } catch (error) {
      console.error('[Admin] getHealthMetrics error:', error.message);
      res.status(500).json({ message: 'Unable to load health metrics.' });
    }
  },

  // ─── Live Dashboard: Recent Activity ───────────────────────────────
  // ─── Audit Log (Phase 5.3 / Item 24) ──────────────────────────────
  // Read-only, filterable audit trail from admin_logs. The UI must NEVER
  // allow deletion of these rows.
  async getAuditLogs(req, res) {
    try {
      const schema = await getSchema();
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
      const offset = (page - 1) * limit;
      const params = [];
      const where = [];

      if (req.query.action) { where.push('l.action LIKE ?'); params.push(`%${req.query.action}%`); }
      if (req.query.entityType) { where.push('l.entity_type = ?'); params.push(req.query.entityType); }
      if (req.query.entityId) { where.push('l.entity_id = ?'); params.push(String(req.query.entityId)); }
      if (req.query.adminId) { where.push('l.admin_id = ?'); params.push(Number(req.query.adminId)); }

      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

      // If the audit columns don't exist yet, fall back to the legacy shape.
      if (!hasColumn(schema, 'admin_logs', 'entity_type')) {
        const [rows] = await db.query(
          `SELECT id, admin_id, action, target_type AS entity_type, target_id AS entity_id, NULL AS before_json, NULL AS after_json, NULL AS ip_hash, detail, created_at
           FROM admin_logs l ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
          [limit, offset]
        );
        const [countRows] = await db.query('SELECT COUNT(*) AS total FROM admin_logs');
        return sendPaginated(res, rows.map(DTO.auditDto), { page, perPage: limit, totalItems: countRows[0]?.total || 0 });
      }

      const userNameExpr = hasColumn(schema, 'users', 'name') ? 'u.name' : 'u.email';
      const [rows] = await db.query(
        `SELECT l.id, l.admin_id, l.action, l.entity_type, l.entity_id, l.before_json, l.after_json, l.ip_hash, l.created_at, ${userNameExpr} AS admin_name
         FROM admin_logs l LEFT JOIN users u ON u.id = l.admin_id
         ${whereClause} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      const [countRows] = await db.query(
        `SELECT COUNT(*) AS total FROM admin_logs l ${whereClause}`,
        params
      );
      return sendPaginated(res, rows.map(DTO.auditDto), { page, perPage: limit, totalItems: countRows[0]?.total || 0 });
    } catch (error) {
      console.error('[Admin] getAuditLogs error:', error.message);
      res.status(500).json({ message: error.message });
    }
  },

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
      const userNameColumn = hasColumn(schema, 'users', 'name') ? 'name' : 'email';
      queries.push(
        db.query(`
          SELECT 'user' AS type, id, ${userNameColumn} AS label, email AS detail, created_at
          FROM users ORDER BY created_at DESC LIMIT ?
        `, [limit])
      );

      // Recent payments
      if (hasColumn(await getSchema(), 'payments', 'paid_at')) {
        queries.push(
          db.query(`
            SELECT 'payment' AS type, id, flw_tx_ref AS label, CONCAT(plan, ' - ', status) AS detail, paid_at AS created_at
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

      return sendSuccess(res, activities.slice(0, limit));
    } catch (error) {
      console.error('[Activity] Error fetching recent activity:', error.message);
      return sendSuccess(res, []);
    }
  },
  /**
   * GET /api/admin/streams/:episodeId/diagnostic
   * Read-only cached stream diagnostic for authenticated admins.
   *
   * NEVER:
   *   - Resolves a new stream (no AnimeHeaven / Thordata call)
   *   - Modifies the cache
   *   - Deletes cache rows
   *   - Returns cookies, credentials, or proxy secrets
   *   - Consumes Thordata traffic
   */
  async getStreamDiagnostic(req, res) {
    const streamCacheService = require('../services/streamCacheService');
    const streamCacheConfig = require('../config/streamCache');

    const episodeId = Number(req.params.episodeId);
    if (!Number.isInteger(episodeId) || episodeId < 1) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAM', message: 'Invalid episode ID.' } });
    }

    try {
      const [epRows] = await db.query('SELECT id, episode_number, anime_id FROM episodes WHERE id = ?', [episodeId]);
      if (!epRows || !epRows[0]) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Episode not found.' } });
      }
      const episode = epRows[0];

      const provider = streamCacheConfig.provider;
      const cached = await streamCacheService.findCachedStream(episodeId, provider);

      const diagnostic = {
        episodeId,
        episodeNumber: episode.episode_number,
        animeId: episode.anime_id,
        provider,
        cacheExists: !!cached.row,
        cacheState: cached.state,
      };

      if (cached.row) {
        const row = cached.row;
        diagnostic.cacheRowId = row.id;
        diagnostic.streamType = row.stream_type || null;
        diagnostic.expiresAt = row.expires_at || null;
        diagnostic.detectedExpiresAt = row.detected_expires_at || null;
        diagnostic.expirySource = row.expiry_source || 'unknown';
        diagnostic.verificationStatus = row.verification_status || 'unknown';
        diagnostic.lastVerifiedAt = row.last_verified_at || null;
        diagnostic.lastUsedAt = row.last_used_at || null;
        diagnostic.resolvedAt = row.resolved_at || null;
        diagnostic.redisKey = streamCacheService.buildRedisKey(episodeId, provider);
        diagnostic.cacheTtlMinutes = streamCacheConfig.ttlMinutes;

        const data = row.stream_data || {};
        const sources = Array.isArray(data.sources) ? data.sources : [];
        diagnostic.sourceCount = sources.length;
        diagnostic.sourceQualities = sources.map(s => s.quality || 'auto').filter(Boolean);

        const primaryUrl = data.streamUrl || (sources.length > 0 ? sources[0].url : null);
        if (primaryUrl) {
          try {
            const u = new URL(primaryUrl);
            diagnostic.urlHost = u.host;
            diagnostic.urlPath = u.pathname;
            diagnostic.urlQueryParamNames = [...u.searchParams.keys()];
            const redactedParams = new URLSearchParams();
            for (const [k, v] of u.searchParams) {
              if (/expires|expiry|exp|expires_at|expiration|expire|token_expires|token_expiry/i.test(k)) {
                redactedParams.set(k, v);
              } else {
                redactedParams.set(k, '[REDACTED]');
              }
            }
            const qs = redactedParams.toString();
            diagnostic.urlRedacted = u.protocol + '//' + u.host + u.pathname + (qs ? '?' + qs : '');
          } catch (_) { diagnostic.urlRedacted = '[invalid URL]'; }

          const sourceExpiry = streamCacheService.detectSourceExpiry({
            streamUrl: primaryUrl,
            sources: sources.map(s => ({ url: s.url })),
          });
          diagnostic.detectedUrlExpiry = sourceExpiry.detectedExpiresAt ? sourceExpiry.detectedExpiresAt.toISOString() : null;
          diagnostic.detectedUrlExpirySource = sourceExpiry.expirySource;

          const verifyContext = {};
          if (sources.length > 0) {
            if (sources[0].referer) verifyContext.referer = sources[0].referer;
            if (sources[0].origin) verifyContext.origin = sources[0].origin;
          }
          const verification = await streamCacheService.verifySource(primaryUrl, verifyContext);
          diagnostic.verification = { alive: verification.alive, status: verification.status, contentType: verification.contentType, skipProxy: true, thordataUsed: false };
        }
      }

      logActivity(req, 'Stream diagnostic for episode #' + episodeId, 'episode', episodeId).catch(() => {});
      return sendSuccess(res, diagnostic);
    } catch (error) {
      console.error('[Admin] getStreamDiagnostic error:', error.message);
      return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to retrieve stream diagnostic.' } });
    }
},

  /**
   * POST /api/admin/streams/sync/:animeId
   * Sync stream observation for all episodes of an anime.
   * Observes current URLs, refreshes only confirmed-dead sources.
   * Admin-only, rate-limited.
   */
  async syncStreamObservation(req, res) {
    const animeId = Number(req.params.animeId);
    if (!Number.isInteger(animeId) || animeId < 1) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAM', message: 'Invalid anime ID.' } });
    }
    try {
      const streamObservationService = require('../services/streamObservationService');
      const forceRefresh = req.query.force === '1' || req.query.force === 'true';
      const report = await streamObservationService.syncAnime(animeId, { forceRefresh: forceRefresh });
      logActivity(req, 'Stream sync for anime #' + animeId, 'anime', animeId).catch(function() {});
      return res.status(200).json({ success: true, report: report });
    } catch (error) {
      console.error('[Admin] syncStreamObservation error:', error.message);
      return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Stream sync failed.' } });
    }
  },

  /**
   * GET /api/admin/streams/observation/:episodeId
   * Get observation report for a single episode.
   */
  async getStreamObservationReport(req, res) {
    const episodeId = Number(req.params.episodeId);
    if (!Number.isInteger(episodeId) || episodeId < 1) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAM', message: 'Invalid episode ID.' } });
    }
    try {
      const streamCacheService = require('../services/streamCacheService');
      const streamCacheConfig = require('../config/streamCache');
      const provider = streamCacheConfig.provider;
      const cached = await streamCacheService.findCachedStream(episodeId, provider);
      if (!cached.row) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No cached stream for this episode.' } });
      }
      const row = cached.row;
      const report = {
        episodeId: episodeId,
        provider: provider,
        streamType: row.stream_type || null,
        expiresAt: row.expires_at || null,
        detectedExpiresAt: row.detected_expires_at || null,
        expirySource: row.expiry_source || 'unknown',
        verificationStatus: row.verification_status || 'unknown',
        classification: row.url_classification || 'UNKNOWN',
        classificationConfidence: row.classification_confidence || 'LOW',
        classificationReason: row.classification_reason || null,
        lastDirectCheckAt: row.last_direct_check_at || null,
        lastDirectStatus: row.last_direct_status || null,
        lastProxyCheckAt: row.last_proxy_check_at || null,
        lastProxyStatus: row.last_proxy_status || null,
        lastCheckPath: row.last_check_path || null,
        lastCheckDurationMs: row.last_check_duration_ms || null,
        lastCheckContentType: row.last_check_content_type || null,
        lastVerifiedAt: row.last_verified_at || null,
        lastFailedAt: row.last_failed_at || null,
        failureCount: row.failure_count || 0,
        urlObservedLifetimeSeconds: row.url_observed_lifetime_seconds || null,
        urlFirstFailureAt: row.url_first_failure_at || null,
        urlLastFailureAt: row.url_last_failure_at || null,
        urlFailureCount: row.url_failure_count || 0,
        probePlaybackMatchCount: row.probe_playback_match_count || 0,
        probeFalsePositiveCount: row.probe_false_positive_count || 0,
        probeFalseNegativeCount: row.probe_false_negative_count || 0,
        rotationCount: row.rotation_count || 0,
        originalHost: row.original_host || null,
        currentHost: row.current_host || null,
        hostChangedAt: row.host_changed_at || null,
        tokenChangedAt: row.token_changed_at || null,
        observedLifetimeSeconds: row.observed_lifetime_seconds || null,
        observedFirstSuccessAt: row.observed_first_success_at || null,
        observedLastSuccessAt: row.observed_last_success_at || null,
        observedFirstFailureAt: row.observed_first_failure_at || null,
      };
      logActivity(req, 'Stream observation for episode #' + episodeId, 'episode', episodeId).catch(function() {});
      return res.status(200).json({ success: true, report: report });
    } catch (error) {
      console.error('[Admin] getStreamObservationReport error:', error.message);
      return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to retrieve observation report.' } });
    }
  },
};
module.exports = adminController;

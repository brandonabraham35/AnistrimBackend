// controllers/animeController.js
const db = require('../config/db');

// Keep the public catalogue contract stable for both the current client
// (cover_image) and older React clients (poster_url/thumbnail_url).
function publicAnime(anime) {
  const cover = anime.cover_image || anime.poster_url || anime.thumbnail_url || null;
  return {
    ...anime,
    cover_image: cover,
    poster_url: cover,
    thumbnail_url: cover,
    banner_url: anime.banner_image || null,
  };
}

// Helper — fetch genres for a list of anime IDs
async function attachGenres(animeList) {
  if (!animeList.length) return animeList;
  const ids = animeList.map(a => a.id);
  const [rows] = await db.query(
    `SELECT ag.anime_id, g.name FROM anime_genres ag
     JOIN genres g ON ag.genre_id = g.id
     WHERE ag.anime_id IN (?)`, [ids]
  );
  const map = {};
  rows.forEach(r => {
    if (!map[r.anime_id]) map[r.anime_id] = [];
    map[r.anime_id].push(r.name);
  });
  return animeList.map(a => publicAnime({ ...a, genres: map[a.id] || [] }));
}

// GET /api/anime/trending  — returns all anime (used as main feed)
exports.getTrending = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, title, title_japanese, description, cover_image, banner_image,
              rating, year, studio, status, is_premium, is_featured, view_count, created_at
       FROM anime ORDER BY rating DESC, view_count DESC, created_at DESC`
    );
    const result = await attachGenres(rows);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch anime.' });
  }
};

// GET /api/anime/latest — newest administrator uploads, independent of rating,
// status, or featured state. This is the source for the homepage Latest Uploads row.
exports.getLatest = async (req, res) => {
  try {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 10, 1), 50);
    const [rows] = await db.query(
      `SELECT id, title, title_japanese, description, cover_image, banner_image,
              rating, year, studio, status, is_premium, is_featured, view_count, created_at
       FROM anime ORDER BY created_at DESC, id DESC LIMIT ?`,
      [limit]
    );
    res.json(await attachGenres(rows));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch latest anime.' });
  }
};

// GET /api/anime/recommendations/:id — local recommendations use overlapping
// genres first and fall back to popular catalogue titles.
exports.getRecommendations = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid anime id.' });
    const [rows] = await db.query(
      `SELECT DISTINCT a.id, a.title, a.title_japanese, a.description, a.cover_image, a.banner_image,
              a.rating, a.year, a.studio, a.status, a.is_premium, a.is_featured, a.view_count, a.created_at,
              COUNT(ag2.genre_id) AS matching_genres
       FROM anime a
       LEFT JOIN anime_genres ag2 ON ag2.anime_id = a.id
       WHERE a.id <> ? AND (NOT EXISTS (SELECT 1 FROM anime_genres WHERE anime_id = ?) OR ag2.genre_id IN (SELECT genre_id FROM anime_genres WHERE anime_id = ?))
       GROUP BY a.id
       ORDER BY matching_genres DESC, a.rating DESC, a.view_count DESC, a.created_at DESC
       LIMIT 12`,
      [id, id, id]
    );
    res.json(await attachGenres(rows));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch recommendations.' });
  }
};

// GET /api/anime/featured  — hero slider only
exports.getFeatured = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, title, title_japanese, description, cover_image, banner_image,
              rating, year, studio, status, is_premium, is_featured
       FROM anime WHERE is_featured = 1 ORDER BY rating DESC LIMIT 6`
    );
    const result = await attachGenres(rows);
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch featured anime.' });
  }
};

// GET /api/anime/search?q=query&genre=Action&status=airing
exports.search = async (req, res) => {
  const { q, genre, status } = req.query;
  try {
    let sql = `SELECT a.id, a.title, a.cover_image, a.rating, a.year, a.status, a.is_premium
               FROM anime a`;
    const params = [];

    if (genre) {
      sql += ` JOIN anime_genres ag ON a.id = ag.anime_id
               JOIN genres g ON ag.genre_id = g.id AND g.name = ?`;
      params.push(genre);
    }
    sql += ` WHERE 1=1`;
    if (q) { sql += ` AND MATCH(a.title, a.description) AGAINST(? IN BOOLEAN MODE)`; params.push(`${q}*`); }
    if (status) { sql += ` AND a.status = ?`; params.push(status); }
    sql += ` ORDER BY a.rating DESC LIMIT 50`;

    const [rows] = await db.query(sql, params);
    const result = await attachGenres(rows);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Search failed.' });
  }
};

// ─── Stream Resolver: Search by title + episode number ────────────────
// GET /api/anime/resolve/stream?animeTitle=...&episodeNumber=...
exports.resolveStream = async (req, res) => {
  const { animeTitle, episodeNumber } = req.query;
  if (!animeTitle || !episodeNumber) {
    return res.status(400).json({ error: 'Both animeTitle and episodeNumber query parameters are required.' });
  }

  // Smart Cache: reduce external API calls, prevent rate-limiting
  const cache = require('../utils/cacheService');
  const cacheKey = `stream:${animeTitle.toLowerCase().replace(/\s+/g, '-')}:ep${episodeNumber}`;
  const STREAM_CACHE_TTL = 300; // 5 minutes

  try {
    const cached = await cache.get(cacheKey);
    if (cached) {
      console.log(`[resolveStream CACHE HIT] ${animeTitle} Episode ${episodeNumber}`);
      return res.json(cached);
    }

    console.log(`[resolveStream CACHE MISS] ${animeTitle} Episode ${episodeNumber} — fetching from provider...`);
    const { ConsumetProvider } = require('../services/consumetProvider');
    const consumet = new ConsumetProvider();
    const result = await consumet.resolveStreamUrl(animeTitle, episodeNumber);

    // Store in cache before responding
    await cache.set(cacheKey, result, STREAM_CACHE_TTL);
    console.log(`[resolveStream CACHED] ${animeTitle} Episode ${episodeNumber} for ${STREAM_CACHE_TTL}s`);

    res.json(result);
  } catch (err) {
    console.error('[resolveStream Error]:', err.message);
    res.status(502).json({ error: `Stream resolution failed: ${err.message}` });
  }
};

// GET /api/anime/:id  — single anime with episodes
exports.getById = async (req, res) => {
  try {
    const animeId = Number(req.params.id);
    if (!Number.isInteger(animeId)) return res.status(400).json({ error: 'Invalid anime ID' });

    // 1. Fetch the anime details
    const [animeRows] = await db.query('SELECT * FROM anime WHERE id = ?', [animeId]);
    if (animeRows.length === 0) return res.status(404).json({ error: 'Anime not found' });
    const [anime] = await attachGenres(animeRows);

    // 2. Increment view counters (lifetime + daily for Viral Threshold premium automation)
    await db.query('UPDATE anime SET view_count = view_count + 1, daily_views = daily_views + 1 WHERE id = ?', [animeId]);

    // 3. FETCH THE EPISODES from the local database
    const [episodeRows] = await db.query(
      'SELECT * FROM episodes WHERE anime_id = ? ORDER BY episode_number ASC',
      [animeId]
    );

    // 4. Map the database columns to safe frontend keys
    anime.episodes = episodeRows.map(ep => ({
      id: ep.id,
      number: ep.episode_number,
      title: ep.title,
      description: ep.description,
      thumbnail_url: ep.thumbnail_url,
      video_url: (ep.is_premium && !req.user?.isPremium && !req.user?.isAdmin) ? null : ep.video_url,
      duration_sec: ep.duration_sec,
      is_premium: Boolean(ep.is_premium),
      view_count: ep.view_count,
    }));

    // 5. Send the combined payload
    res.json(anime);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch anime details.' });
  }
};

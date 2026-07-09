// controllers/animeController.js
const db = require('../config/db');

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
  return animeList.map(a => ({ ...a, genres: map[a.id] || [] }));
}

// GET /api/anime/trending  — returns all anime (used as main feed)
exports.getTrending = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, title, title_japanese, description, cover_image, banner_image,
              rating, year, studio, status, is_premium, is_featured, view_count
       FROM anime ORDER BY rating DESC, view_count DESC`
    );
    const result = await attachGenres(rows);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch anime.' });
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

// GET /api/anime/:id  — single anime with episodes
exports.getById = async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await db.query('SELECT * FROM anime WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ message: 'Anime not found.' });
    const [anime] = await attachGenres(rows);

    // Increment view counter
    await db.query('UPDATE anime SET view_count = view_count + 1 WHERE id = ?', [id]);

    // Fetch episodes — hide video_url for premium eps if user not premium
    const isPremium = req.user?.isPremium || req.user?.isAdmin;
    const [episodes] = await db.query(
      `SELECT id, episode_number, title, description, thumbnail_url,
              duration_sec, is_premium, view_count,
              ${isPremium ? 'video_url' : 'IF(is_premium=0, video_url, NULL) AS video_url'}
       FROM episodes WHERE anime_id = ? ORDER BY episode_number`,
      [id]
    );

    res.json({ ...anime, episodes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch anime details.' });
  }
};

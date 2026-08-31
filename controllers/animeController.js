// controllers/animeController.js
const db = require('../config/db');
const { PUBLIC_ANIME_FILTER, PUBLIC_EPISODE_FILTER } = require('../utils/contentVisibility');
const { internal, notFound, badRequest } = require('../utils/apiError');
const { sendSuccess, sendPaginated } = require('../utils/response');
const dto = require('../services/apiDtoService');

// PUBLIC_ANIME_COLUMNS — explicit whitelist for public anime rows. Never SELECT *,
// so internal/provider fields (cover_public_id, banner_public_id, anime_mappings,
// mal_id, consumet_id, etc.) can never leak into the response.
const PUBLIC_ANIME_COLUMNS = [
  'id', 'title', 'title_japanese', 'description', 'cover_image', 'banner_image',
  'rating', 'year', 'studio', 'status', 'is_premium', 'is_featured', 'view_count',
  'created_at', 'updated_at', 'media_type', 'tags', 'access_tier',
];

// Keep the public catalogue contract stable for both the current client
// (cover_image) and older React clients (poster_url/thumbnail_url), while also
// emitting the canonical camelCase fields (coverImage). Only safe public fields
// are returned — internal/sensitive fields are stripped.
function publicAnime(anime) {
  const cover = anime.cover_image || anime.poster_url || anime.thumbnail_url || null;
  return {
    ...anime,
    // Canonical camelCase
    coverImage: cover,
    posterUrl: cover,
    thumbnailUrl: cover,
    bannerUrl: anime.banner_image || anime.banner_url || null,
    // Legacy snake_case aliases
    cover_image: cover,
    poster_url: cover,
    thumbnail_url: cover,
    banner_url: anime.banner_image || anime.banner_url || null,
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
  return animeList.map(a => {
    const row = publicAnime({ ...a, genres: map[a.id] || [] });
    // Phase 4 (BUG-3): expose explicit content-classification fields derived
    // from the authorization source of truth (anime.access_tier). These are
    // CLASSIFICATION only — they never express whether the current user is
    // locked (per-episode `locked`/`accessState` remain the caller-specific
    // concepts). `is_premium` stays for legacy card consumers and is kept in
    // sync with access_tier by the admin write path (resolveAnimeAccessTier).
    row.accessTier = row.access_tier || 'free';
    row.isPremiumContent = row.accessTier === 'premium';
    return row;
  });
}

// GET /api/anime/genres — active genres, ordered (Bug 3).
// Returns the list of genre names the onboarding genre picker uses. Only
// genres that are actually attached to catalogue titles are surfaced.
exports.getGenres = async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT DISTINCT g.name
       FROM genres g
       JOIN anime_genres ag ON g.id = ag.genre_id
       ORDER BY g.name ASC`
    );
    const names = rows.map(r => r.name).filter(Boolean);
    return sendSuccess(res, names);
  } catch (error) {
    console.error('[AnimeController] getGenres error:', error.message);
    return next(internal('ANIME_GENRES_FETCH_FAILED', 'Failed to fetch genres.'));
  }
};

// GET /api/anime/years — distinct years present in the catalogue for filter dropdown.
exports.getYears = async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT DISTINCT year FROM anime WHERE is_published = 1 AND year IS NOT NULL AND year > 0 ORDER BY year DESC`
    );
    return sendSuccess(res, rows.map(r => r.year));
  } catch (error) {
    console.error('[AnimeController] getYears error:', error.message);
    return sendSuccess(res, []); // Return empty on error instead of 500
  }
};

// GET /api/anime/trending — paginated trending/popular anime (Browse default).
// Query params: page (default 1), perPage (default 10, max 50).
// Returns a bounded slice of the catalogue ordered by engagement (views + rating).
// The Browse page shows only the first page (10 items); search uses /search/advanced.
exports.getTrending = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.perPage, 10) || 10));
    const offset = (page - 1) * perPage;

    const [rows] = await db.query(
      `SELECT id, title, title_japanese, description, cover_image, banner_image,
              rating, year, studio, status, is_premium, access_tier, is_featured, view_count, created_at
       FROM anime a WHERE ${PUBLIC_ANIME_FILTER}
       ORDER BY view_count DESC, rating DESC, created_at DESC
       LIMIT ? OFFSET ?`,
      [perPage, offset]
    );
    const result = await attachGenres(rows);
    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total FROM anime a WHERE ${PUBLIC_ANIME_FILTER}`
    );
    return sendPaginated(res, result, { page, perPage, totalItems: countRows[0]?.total || 0 });
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
              rating, year, studio, status, is_premium, access_tier, is_featured, view_count, created_at
       FROM anime a WHERE ${PUBLIC_ANIME_FILTER} ORDER BY created_at DESC, id DESC LIMIT ?`,
      [limit]
    );
    return sendSuccess(res, await attachGenres(rows));
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
              a.rating, a.year, a.studio, a.status, a.is_premium, a.access_tier, a.is_featured, a.view_count, a.created_at,
              COUNT(ag2.genre_id) AS matching_genres
       FROM anime a
       LEFT JOIN anime_genres ag2 ON ag2.anime_id = a.id
       WHERE a.id <> ? AND ${PUBLIC_ANIME_FILTER} AND (NOT EXISTS (SELECT 1 FROM anime_genres WHERE anime_id = ?) OR ag2.genre_id IN (SELECT genre_id FROM anime_genres WHERE anime_id = ?))
       GROUP BY a.id
       ORDER BY matching_genres DESC, a.rating DESC, a.view_count DESC, a.created_at DESC
       LIMIT 12`,
      [id, id, id]
    );
    return sendSuccess(res, await attachGenres(rows));
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
              rating, year, studio, status, is_premium, access_tier, is_featured
       FROM anime a WHERE is_featured = 1 AND ${PUBLIC_ANIME_FILTER} ORDER BY rating DESC LIMIT 6`
    );
    const result = await attachGenres(rows);
    return sendSuccess(res, result);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch featured anime.' });
  }
};

// GET /api/anime/search?q=query&genre=Action&status=airing&year=2025&sort=rating&page=1&perPage=24
// Enhanced search with pagination, sort, and year filters.
exports.search = async (req, res) => {
  const { q, genre, status, year, sort, page, perPage } = req.query;
  try {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPageNum = Math.min(50, Math.max(1, parseInt(perPage, 10) || 24));
    const offset = (pageNum - 1) * perPageNum;

    let sql = `SELECT a.id, a.title, a.title_japanese, a.cover_image, a.banner_image,
                      a.rating, a.year, a.studio, a.status, a.is_premium, a.access_tier, a.is_featured, a.view_count, a.created_at
               FROM anime a`;
    const params = [];

    if (genre) {
      sql += ` JOIN anime_genres ag ON a.id = ag.anime_id
               JOIN genres g ON ag.genre_id = g.id AND g.name = ?`;
      params.push(genre);
    }
    sql += ` WHERE ${PUBLIC_ANIME_FILTER}`;
    if (q) {
      // Escape LIKE wildcards to prevent information disclosure via pattern matching
      const escapedQ = String(q).replace(/[%_]/g, '\\$&');
      sql += ` AND (a.title LIKE ? OR a.description LIKE ?)`;
      params.push(`%${escapedQ}%`, `%${escapedQ}%`);
    }
    if (status) { sql += ` AND a.status = ?`; params.push(status); }
    if (year) { sql += ` AND a.year = ?`; params.push(parseInt(year, 10)); }

    // Sort options
    const validSorts = { rating: 'a.rating DESC', popular: 'a.view_count DESC', latest: 'a.created_at DESC', az: 'a.title ASC', za: 'a.title DESC' };
    const orderBy = validSorts[sort] || validSorts.rating;
    sql += ` ORDER BY ${orderBy}`;

    const [rows] = await db.query(sql + ` LIMIT ? OFFSET ?`, [...params, perPageNum, offset]);
    const result = await attachGenres(rows);

    // Total count for pagination
    let countSql = `SELECT COUNT(*) AS total FROM anime a`;
    const countParams = [];
    if (genre) {
      countSql += ` JOIN anime_genres ag ON a.id = ag.anime_id JOIN genres g ON ag.genre_id = g.id AND g.name = ?`;
      countParams.push(genre);
    }
    countSql += ` WHERE ${PUBLIC_ANIME_FILTER}`;
    if (q) {
      const escapedQ = String(q).replace(/[%_]/g, '\\$&');
      countSql += ` AND (a.title LIKE ? OR a.description LIKE ?)`;
      countParams.push(`%${escapedQ}%`, `%${escapedQ}%`);
    }
    if (status) { countSql += ` AND a.status = ?`; countParams.push(status); }
    if (year) { countSql += ` AND a.year = ?`; countParams.push(parseInt(year, 10)); }

    const [countRows] = await db.query(countSql, countParams);
    return sendPaginated(res, result, { page: pageNum, perPage: perPageNum, totalItems: countRows[0]?.total || 0 });
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
      return sendSuccess(res, cached);
    }

    console.log(`[resolveStream CACHE MISS] ${animeTitle} Episode ${episodeNumber} — fetching from provider...`);
    const { ConsumetProvider } = require('../services/consumetProvider');
    const consumet = new ConsumetProvider();
    const result = await consumet.resolveStreamUrl(animeTitle, episodeNumber);

    // Store in cache before responding
    await cache.set(cacheKey, result, STREAM_CACHE_TTL);
    console.log(`[resolveStream CACHED] ${animeTitle} Episode ${episodeNumber} for ${STREAM_CACHE_TTL}s`);

    return sendSuccess(res, result);
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

    // 1. Fetch the anime details (explicit column whitelist — no SELECT *).
    const [animeRows] = await db.query(
      `SELECT a.id, a.title, a.title_japanese, a.description, a.cover_image, a.banner_image,
              a.rating, a.year, a.studio, a.status, a.is_premium, a.is_featured,
              a.view_count, a.media_type, a.access_tier, a.tags, a.created_at, a.updated_at
       FROM anime a WHERE a.id = ? AND ${PUBLIC_ANIME_FILTER}`,
      [animeId]
    );
    if (animeRows.length === 0) return res.status(404).json({ error: 'Anime not found' });
    const [anime] = await attachGenres(animeRows);

    // 2. Increment the lifetime view counter only (used for trending/popular
    //    ordering and display). Phase 4 (BUG-2): daily_views is deliberately
    //    NOT incremented here — a GET/read must never feed the viral-threshold
    //    premium classification (itself disabled by default since BUG-1).
    await db.query('UPDATE anime SET view_count = view_count + 1 WHERE id = ?', [animeId]);

    // 3. FETCH THE EPISODES from the local database (explicit column whitelist).
    const [episodeRows] = await db.query(
      `SELECT e.id, e.anime_id, e.episode_number, e.season, e.title, e.description,
               e.thumbnail_url, e.video_url, e.duration_sec, e.view_count, e.is_premium,
               e.access_tier, e.premium_until, e.created_at, e.updated_at
        FROM episodes e WHERE e.anime_id = ? AND ${PUBLIC_EPISODE_FILTER} ORDER BY e.episode_number ASC`,
      [animeId]
    );

    // 4. Map the database columns to safe frontend keys, enforcing the P2
    //    effective-access model (episode_effective_access + entitlement) so a
    //    locked premium episode keeps metadata public but never leaks its video
    //    source. This replaces the legacy is_premium boolean gate.
    // Prompt 6: emit effectiveTier, locked, availableAt, AND accessState so the
    // frontend reads ONLY these fields — never is_premium, never localStorage,
    // never a JWT claim. Frontend gating is cosmetic only; the server is the boundary.
    const { maskEpisodes } = require('../utils/episodeAccess');
    const masked = await maskEpisodes(episodeRows, req.user);
    anime.episodes = masked.map(ep => ({
      id: ep.id,
      number: ep.episode_number,
      season: ep.season || 1,
      // Camel-case compatibility without requiring a second DB column.
      seasonNumber: ep.season || 1,
      title: ep.title,
      description: ep.description,
      thumbnailUrl: ep.thumbnail_url,
      thumbnail_url: ep.thumbnail_url,
      videoUrl: ep.video_url || null,
      video_url: ep.video_url || null,
      durationSec: ep.duration_sec,
      duration_sec: ep.duration_sec,
      // Phase 4 (BUG-4): content CLASSIFICATION only — never caller lock state.
      // effectiveTier==='premium' means the CONTENT is premium-tier; `locked`
      // separately expresses whether THIS user may play it, and `accessState`
      // carries the full UI state (free/premium/premium_required/…).
      isPremiumContent: ep.effectiveTier === 'premium',
      isPremium: ep.premium,
      is_premium: ep.premium,
      effectiveTier: ep.effectiveTier,
      locked: ep.locked,
      availableAt: ep.availableAt,
      accessState: ep.accessState,
      accessTier: ep.access_tier || 'inherit',
      viewCount: ep.view_count,
      view_count: ep.view_count,
    }));

    // 5. Strip internal/sensitive fields (cover_public_id, banner_public_id,
    //    mal_id, consumet_id, etc.) before sending. The DTO utility whitelists
    //    only safe public anime fields and adds camelCase keys.
    const publicAnimeDto = {
      id: anime.id,
      title: anime.title,
      titleJapanese: anime.title_japanese || null,
      description: anime.description || null,
      coverImage: anime.cover_image || null,
      bannerUrl: anime.banner_image || null,
      rating: anime.rating,
      year: anime.year,
      studio: anime.studio || null,
      status: anime.status || 'unknown',
      viewCount: anime.view_count,
      genres: anime.genres || [],
      mediaType: anime.media_type || null,
      tags: anime.tags || null,
      accessTier: anime.access_tier || 'free',
      isPremium: Boolean(anime.is_premium),
      isFeatured: Boolean(anime.is_featured),
      createdAt: anime.created_at || null,
      updatedAt: anime.updated_at || null,
      episodes: anime.episodes,
      // Legacy snake_case aliases
      cover_image: anime.cover_image || null,
      poster_url: anime.poster_url || anime.cover_image || null,
      thumbnail_url: anime.thumbnail_url || anime.cover_image || null,
      banner_url: anime.banner_url || anime.banner_image || null,
    };
    return sendSuccess(res, publicAnimeDto);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch anime details.' });
  }
};

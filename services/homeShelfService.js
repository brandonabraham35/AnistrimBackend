// services/homeShelfService.js
//
// Automatically categorizes and sorts anime into the four home-page UI
// sections for AniStrim:
//
//   1. 🔥 Trending Now   — engagement spikes over a rolling 24–72h window
//   2. ⭐ Popular        — lifetime rating >= 8.5 + high watchlist saves
//   3. ✨ New Releases   — premiere within the last 1–3 months
//   4. 🎬 Classics       — original year <= 2010 with rating >= 7.5
//
// Every section is guaranteed to contain at least MIN_ITEMS entries. If the
// strict rules yield fewer, a documented fallback query fills the remaining
// slots. A title MAY appear in multiple sections (dynamic overlap).
//
// The shelf is cached (Redis/in-memory via utils/cacheService) and refreshed
// by a scheduled cron job, and invalidated whenever an admin adds/updates/
// deletes an anime (see adminController.invalidateCatalogue).

const db = require('../config/db');
const cache = require('../utils/cacheService');
const cron = require('node-cron');

// ── Configuration ─────────────────────────────────────────────
const MIN_ITEMS = 10;                 // Hard minimum per section
const CACHE_KEY = 'homeShelf:sections';
const CACHE_TTL = 6 * 60 * 60;        // 6 hours
const TRENDING_WINDOW_HOURS = 72;     // Rolling engagement window
const NEW_RELEASE_MIN_MONTHS = 1;     // Oldest allowed for "New Releases"
const NEW_RELEASE_MAX_MONTHS = 3;     // Newest allowed for "New Releases"
const POPULAR_RATING_THRESHOLD = 8.5; // Strict rating floor for "Popular"
const CLASSIC_YEAR_CUTOFF = 2010;     // Original premiere year must be <= this
const CLASSIC_RATING_THRESHOLD = 7.5; // Quality floor for "Classics"

// ── Public anime shape (consistent with animeController) ─────
function publicAnime(row) {
  const cover = row.cover_image || row.poster_url || row.thumbnail_url || null;
  return {
    id: row.id,
    title: row.title,
    title_japanese: row.title_japanese || null,
    description: row.description || null,
    cover_image: cover,
    poster_url: cover,
    thumbnail_url: cover,
    banner_url: row.banner_image || null,
    rating: Number(row.rating) || 0,
    year: row.year || null,
    premiere_date: row.premiere_date || null,
    studio: row.studio || null,
    status: row.status || 'completed',
    media_type: row.media_type || 'TV',
    is_premium: Boolean(row.is_premium),
    is_featured: Boolean(row.is_featured),
    view_count: Number(row.view_count) || 0,
    daily_views: Number(row.daily_views) || 0,
    watchlist_count: Number(row.watchlist_count) || 0,
    // Ranking signal used by the section builder (not part of the public contract)
    _score: Number(row._score) || 0,
  };
}

// ── Shared query helpers ──────────────────────────────────────

// Base SELECT for shelf rows. `_score` is a per-section ranking signal.
const SHELF_COLUMNS = `
  a.id, a.title, a.title_japanese, a.description, a.cover_image, a.banner_image,
  a.rating, a.year, a.premiere_date, a.studio, a.status, a.media_type,
  a.is_premium, a.is_featured, a.view_count, a.daily_views, a.watchlist_count`;

/**
 * Fill a section up to MIN_ITEMS using a fallback pool, skipping any anime
 * already present in the section (no duplicates within a section).
 */
function fillFromPool(section, pool) {
  const seen = new Set(section.map(item => item.id));
  for (const item of pool) {
    if (section.length >= MIN_ITEMS) break;
    if (!seen.has(item.id)) {
      section.push(item);
      seen.add(item.id);
    }
  }
  return section;
}

// ── 1. 🔥 Trending Now ────────────────────────────────────────
// Strict: engagement spikes over the last 24–72h. We score each anime by:
//   • watch_history rows in the window (watch time) joined to local anime
//   • user_watchlists rows created in the window (rapid saves)
//   • a bonus for currently airing simulcasts
// Sort: highest velocity/engagement spike first.
async function buildTrending() {
  const since = new Date(Date.now() - TRENDING_WINDOW_HOURS * 60 * 60 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');

  // Watch-time spikes: watch_history -> episodes -> anime (via episode_id),
  // with a fallback match on anime_id string for rows without episode_id.
  const [rows] = await db.query(`
    SELECT ${SHELF_COLUMNS},
           COALESCE(SUM(wh.engagement), 0) AS _score
    FROM anime a
    LEFT JOIN (
      SELECT e.anime_id AS local_anime_id, 1 AS engagement
      FROM watch_history wh
      JOIN episodes e ON e.id = wh.episode_id
      WHERE wh.updated_at >= ?
      UNION ALL
      SELECT CAST(wh.anime_id AS UNSIGNED) AS local_anime_id, 1 AS engagement
      FROM watch_history wh
      WHERE wh.updated_at >= ? AND wh.episode_id IS NULL
    ) wh ON wh.local_anime_id = a.id
    GROUP BY a.id
    ORDER BY _score DESC, a.daily_views DESC, a.view_count DESC
    LIMIT ${MIN_ITEMS * 3}
  `, [since, since]);

  let trending = rows.map(publicAnime).filter(item => item._score > 0);

  // Add rapid watchlist saves in the window as a secondary engagement signal.
  if (trending.length < MIN_ITEMS) {
    const [saves] = await db.query(`
      SELECT ${SHELF_COLUMNS}, COUNT(*) AS _score
      FROM anime a
      JOIN user_watchlists uw
        ON uw.anime_id IN (CAST(a.id AS CHAR), a.source_id, a.source_slug, a.animeheaven_slug)
      WHERE uw.created_at >= ?
      GROUP BY a.id
      ORDER BY _score DESC, a.daily_views DESC
      LIMIT ${MIN_ITEMS * 3}
    `, [since]);
    const saveMap = new Map(saves.map(r => [r.id, Number(r._score) || 0]));
    trending = trending.map(item => ({ ...item, _score: item._score + (saveMap.get(item.id) || 0) }));
    trending.sort((x, y) => y._score - x._score);
    for (const s of saves) {
      if (trending.length >= MIN_ITEMS) break;
      if (!trending.some(t => t.id === s.id)) trending.push(publicAnime(s));
    }
  }

  // Simulcast bonus: currently airing titles get a small boost.
  trending = trending.map(item => ({ ...item, _score: item._score + (item.status === 'airing' ? 1 : 0) }));
  trending.sort((x, y) => y._score - x._score);

  // Fallback: overall most-viewed shows from the current month.
  if (trending.length < MIN_ITEMS) {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const [fallback] = await db.query(`
      SELECT ${SHELF_COLUMNS}, (a.view_count + a.daily_views) AS _score
      FROM anime a
      WHERE a.created_at >= ?
      ORDER BY _score DESC, a.view_count DESC
      LIMIT ${MIN_ITEMS * 3}
    `, [monthStart.toISOString().slice(0, 19).replace('T', ' ')]);
    fillFromPool(trending, fallback.map(publicAnime));
  }

  return trending.slice(0, MIN_ITEMS);
}

// ── 2. ⭐ Popular ─────────────────────────────────────────────
// Strict: rating >= 8.5 AND high lifetime watchlist saves.
// Sort: highest all-time rating first.
// Fallback: lower the rating threshold incrementally (8.0, 7.5) until >= 10.
async function buildPopular() {
  const thresholds = [8.5, 8.0, 7.5];
  let popular = [];

  for (const threshold of thresholds) {
    if (popular.length >= MIN_ITEMS) break;
    const [rows] = await db.query(`
      SELECT ${SHELF_COLUMNS}, a.rating AS _score
      FROM anime a
      WHERE a.rating >= ? AND a.watchlist_count > 0
      ORDER BY a.rating DESC, a.watchlist_count DESC
      LIMIT ${MIN_ITEMS * 3}
    `, [threshold]);
    const batch = rows.map(publicAnime);
    fillFromPool(popular, batch);
  }

  // If still short (e.g., no watchlist data yet), relax the watchlist
  // requirement but keep the rating floor at the lowest threshold.
  if (popular.length < MIN_ITEMS) {
    const [rows] = await db.query(`
      SELECT ${SHELF_COLUMNS}, a.rating AS _score
      FROM anime a
      WHERE a.rating >= 7.5
      ORDER BY a.rating DESC, a.view_count DESC
      LIMIT ${MIN_ITEMS * 3}
    `);
    fillFromPool(popular, rows.map(publicAnime));
  }

  return popular.slice(0, MIN_ITEMS);
}

// ── 3. ✨ New Releases ────────────────────────────────────────
// Strict: premiere_date within the last 1–3 months.
// Sort: chronological, most recent first.
// Fallback: next most recent titles from the current calendar year.
async function buildNewReleases() {
  const now = new Date();
  const minDate = new Date(now);
  minDate.setMonth(minDate.getMonth() - NEW_RELEASE_MAX_MONTHS);
  const maxDate = new Date(now);
  maxDate.setMonth(maxDate.getMonth() - NEW_RELEASE_MIN_MONTHS);

  const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');

  const [rows] = await db.query(`
    SELECT ${SHELF_COLUMNS}, a.premiere_date AS _score
    FROM anime a
    WHERE a.premiere_date IS NOT NULL
      AND a.premiere_date >= ? AND a.premiere_date <= ?
    ORDER BY a.premiere_date DESC, a.id DESC
    LIMIT ${MIN_ITEMS * 3}
  `, [fmt(minDate), fmt(maxDate)]);

  const releases = rows.map(publicAnime);

  // Fallback: next most recent titles from the current calendar year.
  if (releases.length < MIN_ITEMS) {
    const yearStart = `${now.getFullYear()}-01-01 00:00:00`;
    const [fallback] = await db.query(`
      SELECT ${SHELF_COLUMNS}, a.premiere_date AS _score
      FROM anime a
      WHERE a.premiere_date IS NOT NULL AND a.premiere_date >= ?
      ORDER BY a.premiere_date DESC, a.id DESC
      LIMIT ${MIN_ITEMS * 3}
    `, [yearStart]);
    fillFromPool(releases, fallback.map(publicAnime));
  }

  return releases.slice(0, MIN_ITEMS);
}

// ── 4. 🎬 Classics ────────────────────────────────────────────
// Strict: original premiere year <= 2010 AND rating >= 7.5.
// Sort: highest rating first.
// Fallback: pull highest-rated titles from 2011, 2012, ... moving forward
// year-by-year until exactly MIN_ITEMS are filled.
async function buildClassics() {
  const [rows] = await db.query(`
    SELECT ${SHELF_COLUMNS}, a.rating AS _score
    FROM anime a
    WHERE a.year IS NOT NULL AND a.year <= ? AND a.rating >= ?
    ORDER BY a.rating DESC, a.year DESC
    LIMIT ${MIN_ITEMS * 3}
  `, [CLASSIC_YEAR_CUTOFF, CLASSIC_RATING_THRESHOLD]);

  const classics = rows.map(publicAnime);

  // Fallback: walk forward year-by-year from the cutoff.
  let year = CLASSIC_YEAR_CUTOFF + 1;
  while (classics.length < MIN_ITEMS && year <= new Date().getFullYear()) {
    const [fallback] = await db.query(`
      SELECT ${SHELF_COLUMNS}, a.rating AS _score
      FROM anime a
      WHERE a.year = ? AND a.rating >= ?
      ORDER BY a.rating DESC
      LIMIT ${MIN_ITEMS * 3}
    `, [year, CLASSIC_RATING_THRESHOLD]);
    fillFromPool(classics, fallback.map(publicAnime));
    year += 1;
  }

  return classics.slice(0, MIN_ITEMS);
}

// ── Build all sections ────────────────────────────────────────
async function buildAllSections() {
  const [trending, popular, newReleases, classics] = await Promise.all([
    buildTrending(),
    buildPopular(),
    buildNewReleases(),
    buildClassics(),
  ]);

  return {
    trending,
    popular,
    newReleases,
    classics,
    generatedAt: new Date().toISOString(),
  };
}

// ── Public API ────────────────────────────────────────────────

/**
 * Return the home shelf (cached). Builds + caches on first call.
 */
async function getHomeShelf() {
  const cached = await cache.get(CACHE_KEY);
  if (cached) return cached;
  const shelf = await buildAllSections();
  await cache.set(CACHE_KEY, shelf, CACHE_TTL);
  return shelf;
}

/**
 * Force a rebuild and refresh the cache. Used by the cron job and by the
 * admin trigger (create/update/delete anime).
 */
async function refreshHomeShelf() {
  const shelf = await buildAllSections();
  await cache.set(CACHE_KEY, shelf, CACHE_TTL);
  return shelf;
}

/**
 * Invalidate the cached shelf so the next read rebuilds it.
 */
async function invalidate() {
  await cache.delByPrefix(CACHE_KEY);
}

// ── Scheduler ─────────────────────────────────────────────────
let schedulerStarted = false;

/**
 * Start the daily cron that keeps the shelf dynamic. Idempotent and
 * failure-safe — never throws out of the tick.
 */
function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  // Refresh every 6 hours (0,6,12,18) so trending stays fresh.
  cron.schedule('0 */6 * * *', async () => {
    try {
      await refreshHomeShelf();
      console.log('[HomeShelf] Sections refreshed by cron.');
    } catch (error) {
      console.error('[HomeShelf] Cron refresh failed (non-fatal):', error.message);
    }
  });
}

module.exports = {
  MIN_ITEMS,
  getHomeShelf,
  refreshHomeShelf,
  invalidate,
  startScheduler,
  // Exposed for testing
  _buildAllSections: buildAllSections,
};
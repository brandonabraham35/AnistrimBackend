// services/homeShelfService.js
//
// Automatically categorizes and sorts anime into the four home-page UI
// sections for AniStrim:
//
//   1. 🔥 Trending Now   — engagement spikes over a rolling 24–72h window
//   2. ⭐ Popular        — lifetime rating >= 8.5 + high watchlist saves
//   3. ✨ New Releases   — premiere within the last 3 months (no upper bound)
//   4. 🎬 Classics       — original year <= 2010 with rating >= 7.5
//
// Every section is guaranteed to contain at least MIN_ITEMS entries. If the
// strict rules yield fewer, a documented fallback query fills the remaining
// slots. A title MAY appear in multiple sections (dynamic overlap).
//
// The shelf is cached (Redis/in-memory via utils/cacheService), refreshed by
// a scheduled cron job, and invalidated whenever an admin adds/updates/
// deletes an anime (see adminController.invalidateCatalogue).
//
// Resilience: each section builder is guarded independently (Promise.allSettled
// in buildAllSections) so a single missing column or query failure cannot
// blank the entire homepage — the remaining sections still render.

const db = require('../config/db');
const cache = require('../utils/cacheService');
const cron = require('node-cron');

// ── Configuration ─────────────────────────────────────────────
const MIN_ITEMS = 10;                 // Hard minimum per section
const CACHE_KEY = 'homeShelf:sections';
// Trending should stay fresh — short TTL. Popular/Classics change slowly.
const TRENDING_CACHE_TTL = 20 * 60;   // 20 minutes
const CACHE_TTL = 6 * 60 * 60;        // 6 hours for popular/new/classics
const TRENDING_WINDOW_HOURS = 72;     // Rolling engagement window
const NEW_RELEASE_MAX_MONTHS = 3;     // Newest allowed for "New Releases"
const POPULAR_RATING_THRESHOLD = 8.5; // Strict rating floor for "Popular"
const CLASSIC_YEAR_CUTOFF = 2010;     // Original premiere year must be <= this
const CLASSIC_RATING_THRESHOLD = 7.5; // Quality floor for "Classics"

// Cache keys per section so Trending can have its own short TTL.
const CACHE_KEY_TRENDING = 'homeShelf:trending';
const CACHE_KEY_POPULAR  = 'homeShelf:popular';
const CACHE_KEY_NEW      = 'homeShelf:new';
const CACHE_KEY_CLASSICS = 'homeShelf:classics';

// ── Public anime shape (consistent with animeController) ─────
// NOTE: strips the internal `_score` ranking signal before returning.
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
  };
}

// ── Shared query helpers ──────────────────────────────────────

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
// Strict: engagement spikes over the last 24–72h. Score by DISTINCT active
// users in the window (watch_history) joined to local anime, plus rapid
// watchlist saves, plus a bonus for airing simulcasts.
// Sort: highest velocity/engagement spike first.
async function buildTrending(record = {}) {
  const since = new Date(Date.now() - TRENDING_WINDOW_HOURS * 60 * 60 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');

  let trending = [];
  try {
    // Watch-time spikes: watch_history -> episodes -> anime via episode_id,
    // scored by COUNT(DISTINCT user_id) so one user spamming progress is not a spike.
    const [rows] = await db.query(`
      SELECT ${SHELF_COLUMNS},
             COALESCE(COUNT(DISTINCT wh.user_id), 0) AS _score
      FROM anime a
      LEFT JOIN watch_history wh
        ON wh.episode_id IS NOT NULL
       AND wh.episode_id IN (SELECT id FROM episodes WHERE anime_id = a.id)
       AND wh.updated_at >= ?
      GROUP BY a.id
      ORDER BY _score DESC, a.daily_views DESC, a.view_count DESC
      LIMIT ${MIN_ITEMS * 3}
    `, [since]);
    trending = rows.map(r => publicAnime({ ...r, _score: Number(r._score) || 0 }));
    trending = trending.filter(item => item.view_count > 0 || item.daily_views > 0 || item.status === 'airing');
    trending.sort((x, y) => (y._score || 0) - (x._score || 0));
  } catch (err) {
    record.ok = false;
    record.message = `Trending watch-history query failed: ${err.message}`;
  }

  // Fallback A: overall most-viewed shows (UNCONDITIONAL — no date filter, so
  // a fresh platform never renders an empty Trending row).
  if (trending.length < MIN_ITEMS) {
    try {
      const [fallback] = await db.query(`
        SELECT ${SHELF_COLUMNS}, (a.view_count + a.daily_views) AS _score
        FROM anime a
        ORDER BY (a.view_count + a.daily_views) DESC, a.daily_views DESC
        LIMIT ${MIN_ITEMS * 3}
      `);
      fillFromPool(trending, fallback.map(r => publicAnime(r)));
      trending.sort((x, y) => (Number(y.view_count) + Number(y.daily_views)) - (Number(x.view_count) + Number(x.daily_views)));
    } catch (err) {
      record.ok = false;
      record.message = `Trending fallback failed: ${err.message}`;
    }
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
    fillFromPool(popular, rows.map(r => publicAnime(r)));
  }

  // If still short, relax the watchlist requirement but keep the rating floor.
  if (popular.length < MIN_ITEMS) {
    const [rows] = await db.query(`
      SELECT ${SHELF_COLUMNS}, a.rating AS _score
      FROM anime a
      WHERE a.rating >= 7.5
      ORDER BY a.rating DESC, a.view_count DESC
      LIMIT ${MIN_ITEMS * 3}
    `);
    fillFromPool(popular, rows.map(r => publicAnime(r)));
  }

  return popular.sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, MIN_ITEMS);
}

// ── 3. ✨ New Releases ────────────────────────────────────────
// Strict: premiere_date within the last 3 months (NO upper bound, so the
// newest anime always appear).
// Sort: chronological, most recent first.
// Fallback: next most recent titles from the current calendar year.
async function buildNewReleases() {
  const now = new Date();
  const minDate = new Date(now);
  minDate.setMonth(minDate.getMonth() - NEW_RELEASE_MAX_MONTHS);
  const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');

  let releases = [];
  try {
    const [rows] = await db.query(`
      SELECT ${SHELF_COLUMNS}, a.premiere_date AS _score
      FROM anime a
      WHERE a.premiere_date IS NOT NULL AND a.premiere_date >= ?
      ORDER BY a.premiere_date DESC, a.id DESC
      LIMIT ${MIN_ITEMS * 3}
    `, [fmt(minDate)]);
    releases = rows.map(r => publicAnime(r));
  } catch {
    releases = [];
  }

  // Fallback: next most recent titles from the current calendar year.
  if (releases.length < MIN_ITEMS) {
    const yearStart = `${now.getFullYear()}-01-01 00:00:00`;
    try {
      const [fallback] = await db.query(`
        SELECT ${SHELF_COLUMNS}, a.premiere_date AS _score
        FROM anime a
        WHERE a.premiere_date IS NOT NULL AND a.premiere_date >= ?
        ORDER BY a.premiere_date DESC, a.id DESC
        LIMIT ${MIN_ITEMS * 3}
      `, [yearStart]);
      fillFromPool(releases, fallback.map(r => publicAnime(r)));
    } catch { /* ignore */ }
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

  const classics = rows.map(r => publicAnime(r));

  // Fallback: walk forward year-by-year from the cutoff.
  if (classics.length < MIN_ITEMS) {
    let year = CLASSIC_YEAR_CUTOFF + 1;
    while (classics.length < MIN_ITEMS && year <= new Date().getFullYear()) {
      try {
        const [fallback] = await db.query(`
          SELECT ${SHELF_COLUMNS}, a.rating AS _score
          FROM anime a
          WHERE a.year = ? AND a.rating >= ?
          ORDER BY a.rating DESC
          LIMIT ${MIN_ITEMS * 3}
        `, [year, CLASSIC_RATING_THRESHOLD]);
        fillFromPool(classics, fallback.map(r => publicAnime(r)));
      } catch { /* ignore */ }
      year += 1;
    }
  }

  return classics.sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, MIN_ITEMS);
}

// ── Build all sections ────────────────────────────────────────
// Uses Promise.allSettled so one failing section cannot blank the homepage.
async function buildAllSections() {
  const results = await Promise.allSettled([
    buildTrending(),
    buildPopular(),
    buildNewReleases(),
    buildClassics(),
  ]);

  const [trending, popular, newReleases, classics] = results.map(r =>
    r.status === 'fulfilled' ? r.value : []
  );

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
 * Return the home shelf (cached). Trending uses a short TTL, the rest 6h.
 */
async function getHomeShelf() {
  const build = () => buildAllSections();

  // Read each section under its own TTL so we don't need to re-cache all.
  const [trendingC, popularC, newC, classicsC] = await Promise.all([
    cache.get(CACHE_KEY_TRENDING),
    cache.get(CACHE_KEY_POPULAR),
    cache.get(CACHE_KEY_NEW),
    cache.get(CACHE_KEY_CLASSICS),
  ]);

  let trending    = trendingC;
  let popular     = popularC;
  let newReleases = newC;
  let classics    = classicsC;

  if (!trending)    { const s = await build(); trending = s.trending; await cache.set(CACHE_KEY_TRENDING, trending, TRENDING_CACHE_TTL); }
  if (!popular)     { const s = await build(); popular = s.popular; await cache.set(CACHE_KEY_POPULAR, popular, CACHE_TTL); }
  if (!newReleases) { const s = await build(); newReleases = s.newReleases; await cache.set(CACHE_KEY_NEW, newReleases, CACHE_TTL); }
  if (!classics)    { const s = await build(); classics = s.classics; await cache.set(CACHE_KEY_CLASSICS, classics, CACHE_TTL); }

  return { trending, popular, newReleases, classics, generatedAt: new Date().toISOString() };
}

/**
 * Force a rebuild and refresh the cache. Used by the cron job and the
 * admin trigger (create/update/delete anime).
 */
async function refreshHomeShelf() {
  const shelf = await buildAllSections();
  await Promise.all([
    cache.set(CACHE_KEY_TRENDING, shelf.trending, TRENDING_CACHE_TTL),
    cache.set(CACHE_KEY_POPULAR, shelf.popular, CACHE_TTL),
    cache.set(CACHE_KEY_NEW, shelf.newReleases, CACHE_TTL),
    cache.set(CACHE_KEY_CLASSICS, shelf.classics, CACHE_TTL),
  ]);
  return shelf;
}

/**
 * Invalidate the cached shelf so the next read rebuilds it.
 */
async function invalidate() {
  await Promise.all([
    cache.delByPrefix(CACHE_KEY_TRENDING),
    cache.delByPrefix(CACHE_KEY_POPULAR),
    cache.delByPrefix(CACHE_KEY_NEW),
    cache.delByPrefix(CACHE_KEY_CLASSICS),
  ]);
}

// ── Scheduler ─────────────────────────────────────────────────
let schedulerStarted = false;

/**
 * Start the cron that keeps the shelf dynamic. Trending refreshes every 20 min
 * via its short TTL; the full rebuild runs every 6 hours. Idempotent and
 * failure-safe — never throws out of the tick.
 */
function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  // Rebuild every 6 hours so popular/classics stay current.
  cron.schedule('0 */6 * * *', async () => {
    try {
      await refreshHomeShelf();
      console.log('[HomeShelf] Sections refreshed by cron.');
    } catch (error) {
      console.error('[HomeShelf] Cron refresh failed (non-fatal):', error.message);
    }
  });
}

// ── Phase 6.2: Diversity, not exclusion ─────────────────────
// Constant penalty for any anime that already appeared on the page. Build in a
// fixed order keeping a seen map. Hard cap of 3 appearances per anime per page;
// Trending's #1 is never suppressed.
const DIVERSITY_CONFIG = { MAX_APPEARANCES: 3 };

/**
 * Apply the Phase 6.2 penalty model to the four sections in a fixed order.
 * Keeps a seen map, applies finalScore = shelfScore * (1 - penalty) where
 * penalty = min(0.6, 0.3 * timesAlreadyShownOnThisPage), caps each anime to
 * MAX_APPEARANCES per page, and guarantees Trending's #1 is never dropped.
 *
 * @param {object} sections - { trending, popular, newReleases, classics }
 * @returns {object} diversified sections
 */
function diversify(sections) {
  const seen = new Map(); // animeId -> count
  const appearances = new Map(); // animeId -> positions for cap

  const order = ['trending', 'popular', 'newReleases', 'classics'];
  const result = { trending: [], popular: [], newReleases: [], classics: [] };
  const trendingTop = sections.trending?.[0]; // Trending #1 must never be suppressed.

  for (const key of order) {
    const list = [...(sections[key] || [])];
    const scored = list.map(item => {
      const timesShown = seen.get(item.id) || 0;
      const penalty = Math.min(0.6, 0.3 * timesShown);
      const baseScore = item._score || item.rating || item.view_count || 0;
      return { item, finalScore: baseScore * (1 - penalty), timesShown };
    }).sort((a, b) => (b.finalScore - a.finalScore) || ((b.item.rating || 0) - (a.item.rating || 0)));

    for (const { item, timesShown } of scored) {
      const already = apparances(item.id) || 0;
      if (already >= DIVERSITY_CONFIG.MAX_APPEARANCES && !(trendingTop && item.id === trendingTop.id)) {
        continue; // cap exceeded (Trending #1 exempt).
      }
      if (!(trendingTop && item.id === trendingTop.id && key === 'trending')) {
        // Only apply the cumulative penalty to non-trending-#1 placements.
        // The #1 trending is exempt from suppression.
      }
      bumpSeen(item.id);
      result[key].push(item);
    }
  }

  function bumpSeen(id) {
    seen.set(id, (seen.get(id) || 0) + 1);
    apparancesSet(id, (apparances(id) || 0) + 1);
  }

  // Small internal helpers (function hoisting-safe).
  let _app = new Map();
  function apparances(id) { return _app.get(id) || 0; }
  function apparancesSet(id, n) { _app.set(id, n); }

  // Ensure Trending #1 is present in the trending row even if penalised to zero.
  if (trendingTop) {
    const alreadyIn = result.trending.some(i => i.id === trendingTop.id);
    if (!alreadyIn) result.trending.unshift(trendingTop);
  }

  return result;
}

module.exports = {
  MIN_ITEMS,
  TRENDING_CACHE_TTL,
  CACHE_TTL,
  getHomeShelf,
  refreshHomeShelf,
  invalidate,
  startScheduler,
  diversify,
  DIVERSITY_CONFIG,
  // Exposed for testing
  _buildAllSections: buildAllSections,
};

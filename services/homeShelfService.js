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
// deletes an anime OR an episode (publish/unpublish/availability-window).
//
// Resilience: each section builder is guarded independently (Promise.allSettled
// in buildAllSections) so a single missing column or query failure cannot
// blank the entire homepage — the remaining sections still render.
//
// Phase 6.2: diversify() is the single diversity pass. It is called by
// getHomeShelf() and refreshHomeShelf() so the homepage ALWAYS renders the
// diversified result. The internal `_score` ranking signal is carried through
// the section builders and stripped only at the API boundary (publicAnime).
//
// Phase 6.3 (Prompt 8):
//   - Every query applies PUBLIC_ANIME_FILTER (and PUBLIC_EPISODE_FILTER where
//     episodes are joined) so unpublished/unavailable anime never leak.
//   - buildTrending no longer filters on view_count/daily_views/status and
//     sorts on a _score that no longer exists — it sorts on the real _score.
//   - getHomeShelf() builds ONCE and caches each section under its own TTL,
//     with in-flight deduplication so concurrent loads don't stampede the DB.
//   - buildPopular/buildClassics have per-section try/catch like trending.
//   - Diagnostics (record.ok/message) are surfaced in the response.
//   - Null year/premiere_date is handled explicitly.

const db = require('../config/db');
const cache = require('../utils/cacheService');
const cron = require('node-cron');
const { PUBLIC_ANIME_FILTER, PUBLIC_EPISODE_FILTER } = require('../utils/contentVisibility');

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
// Phase 6.2: `_score` is carried through the internal pipeline and stripped
// ONLY here at the API boundary.
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
// Phase 6.3: applies PUBLIC_ANIME_FILTER + PUBLIC_EPISODE_FILTER so
// unpublished/unavailable anime never leak. The _score is the real
// COUNT(DISTINCT user_id) — no fallback to view_count/daily_views/status.
async function buildTrending(record = {}) {
  const since = new Date(Date.now() - TRENDING_WINDOW_HOURS * 60 * 60 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');

  let trending = [];
  try {
    // Watch-time spikes: watch_history -> episodes -> anime via episode_id,
    // scored by COUNT(DISTINCT user_id) so one user spamming progress is not a spike.
    // Phase 6.3: only published anime with published+available episodes count.
    const [rows] = await db.query(`
      SELECT ${SHELF_COLUMNS},
             COALESCE(COUNT(DISTINCT wh.user_id), 0) AS _score
      FROM anime a
      LEFT JOIN watch_progress wh
        ON wh.episode_id IS NOT NULL
       AND wh.episode_id IN (
         SELECT e.id FROM episodes e
         WHERE e.anime_id = a.id AND ${PUBLIC_EPISODE_FILTER}
       )
       AND wh.updated_at >= ?
      WHERE ${PUBLIC_ANIME_FILTER}
      GROUP BY a.id
      ORDER BY _score DESC, a.daily_views DESC, a.view_count DESC
      LIMIT ${MIN_ITEMS * 3}
    `, [since]);
    // Phase 6.2: carry _score through internally (publicAnime strips it).
    // Phase 6.3: no view_count/daily_views/status filter — the _score is the
    // real engagement signal. A fresh catalogue simply returns fewer rows.
    trending = rows.map(r => ({ ...publicAnime(r), _score: Number(r._score) || 0 }));
    trending.sort((x, y) => (y._score || 0) - (x._score || 0));
  } catch (err) {
    record.ok = false;
    record.message = `Trending watch-history query failed: ${err.message}`;
  }

  // Fallback A: overall most-viewed shows (UNCONDITIONAL — no date filter, so
  // a fresh platform never renders an empty Trending row).
  // Phase 6.3: applies PUBLIC_ANIME_FILTER.
  if (trending.length < MIN_ITEMS) {
    try {
      const [fallback] = await db.query(`
        SELECT ${SHELF_COLUMNS}, (a.view_count + a.daily_views) AS _score
        FROM anime a
        WHERE ${PUBLIC_ANIME_FILTER}
        ORDER BY (a.view_count + a.daily_views) DESC, a.daily_views DESC
        LIMIT ${MIN_ITEMS * 3}
      `);
      // Phase 6.2: carry _score through internally.
      fillFromPool(trending, fallback.map(r => ({ ...publicAnime(r), _score: Number(r._score) || 0 })));
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
// Phase 6.3: per-section try/catch like trending; applies PUBLIC_ANIME_FILTER.
async function buildPopular(record = {}) {
  const thresholds = [8.5, 8.0, 7.5];
  let popular = [];

  try {
    for (const threshold of thresholds) {
      if (popular.length >= MIN_ITEMS) break;
      const [rows] = await db.query(`
        SELECT ${SHELF_COLUMNS}, a.rating AS _score
        FROM anime a
        WHERE ${PUBLIC_ANIME_FILTER} AND a.rating >= ? AND a.watchlist_count > 0
        ORDER BY a.rating DESC, a.watchlist_count DESC
        LIMIT ${MIN_ITEMS * 3}
      `, [threshold]);
      // Phase 6.2: carry _score through internally.
      fillFromPool(popular, rows.map(r => ({ ...publicAnime(r), _score: Number(r._score) || 0 })));
    }

    // If still short, relax the watchlist requirement but keep the rating floor.
    if (popular.length < MIN_ITEMS) {
      const [rows] = await db.query(`
        SELECT ${SHELF_COLUMNS}, a.rating AS _score
        FROM anime a
        WHERE ${PUBLIC_ANIME_FILTER} AND a.rating >= 7.5
        ORDER BY a.rating DESC, a.view_count DESC
        LIMIT ${MIN_ITEMS * 3}
      `, []);
      // Phase 6.2: carry _score through internally.
      fillFromPool(popular, rows.map(r => ({ ...publicAnime(r), _score: Number(r._score) || 0 })));
    }
  } catch (err) {
    record.ok = false;
    record.message = `Popular query failed: ${err.message}`;
  }

  return popular.sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, MIN_ITEMS);
}

// ── 3. ✨ New Releases ────────────────────────────────────────
// Strict: premiere_date within the last 3 months (NO upper bound, so the
// newest anime always appear).
// Sort: chronological, most recent first.
// Fallback: next most recent titles from the current calendar year.
// Phase 6.3: applies PUBLIC_ANIME_FILTER. Null premiere_date is handled
// explicitly — titles without a premiere_date are excluded from the strict
// query but may appear via the fallback (which also requires a date).
async function buildNewReleases(record = {}) {
  const now = new Date();
  const minDate = new Date(now);
  minDate.setMonth(minDate.getMonth() - NEW_RELEASE_MAX_MONTHS);
  const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');

  let releases = [];
  try {
    const [rows] = await db.query(`
      SELECT ${SHELF_COLUMNS}, a.premiere_date AS _score
      FROM anime a
      WHERE ${PUBLIC_ANIME_FILTER}
        AND a.premiere_date IS NOT NULL AND a.premiere_date >= ?
      ORDER BY a.premiere_date DESC, a.id DESC
      LIMIT ${MIN_ITEMS * 3}
    `, [fmt(minDate)]);
    // Phase 6.2: carry _score through internally.
    releases = rows.map(r => ({ ...publicAnime(r), _score: Number(r._score) || 0 }));
  } catch (err) {
    record.ok = false;
    record.message = `New Releases query failed: ${err.message}`;
    releases = [];
  }

  // Fallback: next most recent titles from the current calendar year.
  // Phase 6.3: null premiere_date is handled explicitly — the fallback also
  // requires a non-null premiere_date, so titles without one are documented
  // as excluded (they cannot be chronologically placed).
  if (releases.length < MIN_ITEMS) {
    const yearStart = `${now.getFullYear()}-01-01 00:00:00`;
    try {
      const [fallback] = await db.query(`
        SELECT ${SHELF_COLUMNS}, a.premiere_date AS _score
        FROM anime a
        WHERE ${PUBLIC_ANIME_FILTER}
          AND a.premiere_date IS NOT NULL AND a.premiere_date >= ?
        ORDER BY a.premiere_date DESC, a.id DESC
        LIMIT ${MIN_ITEMS * 3}
      `, [yearStart]);
      // Phase 6.2: carry _score through internally.
      fillFromPool(releases, fallback.map(r => ({ ...publicAnime(r), _score: Number(r._score) || 0 })));
    } catch (err) {
      record.ok = false;
      record.message = `New Releases fallback failed: ${err.message}`;
    }
  }

  return releases.slice(0, MIN_ITEMS);
}

// ── 4. 🎬 Classics ────────────────────────────────────────────
// Strict: original premiere year <= 2010 AND rating >= 7.5.
// Sort: highest rating first.
// Fallback: pull highest-rated titles from 2011, 2012, ... moving forward
// year-by-year until exactly MIN_ITEMS are filled.
// Phase 6.3: per-section try/catch like trending; applies PUBLIC_ANIME_FILTER.
// Null year is handled explicitly — titles without a year are excluded from
// the strict query (they cannot be chronologically placed) but may appear via
// the fallback if they have a year.
async function buildClassics(record = {}) {
  let classics = [];
  try {
    const [rows] = await db.query(`
      SELECT ${SHELF_COLUMNS}, a.rating AS _score
      FROM anime a
      WHERE ${PUBLIC_ANIME_FILTER}
        AND a.year IS NOT NULL AND a.year <= ? AND a.rating >= ?
      ORDER BY a.rating DESC, a.year DESC
      LIMIT ${MIN_ITEMS * 3}
    `, [CLASSIC_YEAR_CUTOFF, CLASSIC_RATING_THRESHOLD]);

    // Phase 6.2: carry _score through internally.
    classics = rows.map(r => ({ ...publicAnime(r), _score: Number(r._score) || 0 }));
  } catch (err) {
    record.ok = false;
    record.message = `Classics query failed: ${err.message}`;
    classics = [];
  }

  // Fallback: walk forward year-by-year from the cutoff.
  // Phase 6.3: null year is handled explicitly — the fallback requires a
  // non-null year, so titles without one are documented as excluded.
  if (classics.length < MIN_ITEMS) {
    let year = CLASSIC_YEAR_CUTOFF + 1;
    while (classics.length < MIN_ITEMS && year <= new Date().getFullYear()) {
      try {
        const [fallback] = await db.query(`
          SELECT ${SHELF_COLUMNS}, a.rating AS _score
          FROM anime a
          WHERE ${PUBLIC_ANIME_FILTER} AND a.year = ? AND a.rating >= ?
          ORDER BY a.rating DESC
          LIMIT ${MIN_ITEMS * 3}
        `, [year, CLASSIC_RATING_THRESHOLD]);
        // Phase 6.2: carry _score through internally.
        fillFromPool(classics, fallback.map(r => ({ ...publicAnime(r), _score: Number(r._score) || 0 })));
      } catch (err) {
        record.ok = false;
        record.message = `Classics fallback (year ${year}) failed: ${err.message}`;
      }
      year += 1;
    }
  }

  return classics.sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, MIN_ITEMS);
}

// ── Build all sections ────────────────────────────────────────
// Uses Promise.allSettled so one failing section cannot blank the homepage.
// Phase 6.3: each builder receives a shared `record` so diagnostics are
// surfaced in the response.
async function buildAllSections() {
  const record = { ok: true, message: null };
  const results = await Promise.allSettled([
    buildTrending(record),
    buildPopular(record),
    buildNewReleases(record),
    buildClassics(record),
  ]);

  const [trending, popular, newReleases, classics] = results.map(r =>
    r.status === 'fulfilled' ? r.value : []
  );

  return {
    trending,
    popular,
    newReleases,
    classics,
    diagnostics: record,
    generatedAt: new Date().toISOString(),
  };
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
 * Phase 6.2 fixes:
 *   - `_app` Map is declared BEFORE the loop (no TDZ ReferenceError).
 *   - Helpers are spelled `appearances` / `appearancesSet` (not `apparances`).
 *   - The empty "trending #1 exempt" if-block is replaced with the real rule:
 *     trending #1 is never suppressed, is exempt from the appearance cap, and
 *     is restored to position 0.
 *   - The cross-shelf penalty is applied against a shared seen map across
 *     trending → popular → newReleases → classics.
 *   - `_score` is carried through internally (publicAnime strips it only at
 *     the API boundary).
 *
 * @param {object} sections - { trending, popular, newReleases, classics }
 * @returns {object} diversified sections
 */
function diversify(sections) {
  // Declare the appearance map BEFORE the loop — no TDZ.
  const seen = new Map();        // animeId -> count (shared across all shelves)
  const appearances = new Map(); // animeId -> count (for the hard cap)

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

    for (const { item } of scored) {
      const already = appearances.get(item.id) || 0;
      const isTrendingTop = !!(trendingTop && item.id === trendingTop.id);

      // Hard cap: MAX_APPEARANCES per page. Trending #1 is exempt.
      if (already >= DIVERSITY_CONFIG.MAX_APPEARANCES && !isTrendingTop) {
        continue;
      }

      // Trending #1 is never suppressed and is exempt from the appearance cap.
      // It is always placed at position 0 of the trending row.
      if (isTrendingTop && key === 'trending') {
        // No penalty for the #1 trending — it stays at the top.
        result.trending.unshift(item);
        seen.set(item.id, (seen.get(item.id) || 0) + 1);
        appearances.set(item.id, (appearances.get(item.id) || 0) + 1);
        continue;
      }

      // Normal placement: apply the cumulative penalty via the shared seen map.
      result[key].push(item);
      seen.set(item.id, (seen.get(item.id) || 0) + 1);
      appearances.set(item.id, (appearances.get(item.id) || 0) + 1);
    }
  }

  // Ensure Trending #1 is present in the trending row even if it was somehow
  // not placed (defensive — the loop above always places it first).
  if (trendingTop) {
    const alreadyIn = result.trending.some(i => i.id === trendingTop.id);
    if (!alreadyIn) result.trending.unshift(trendingTop);
  }

  return result;
}

// ── In-flight deduplication ───────────────────────────────────
// Phase 6.3: concurrent getHomeShelf() calls share a single build promise so
// a cold cache doesn't stampede the DB with N identical queries.
let inFlightBuild = null;

function buildOnce() {
  if (!inFlightBuild) {
    inFlightBuild = buildAllSections()
      .then(shelf => {
        inFlightBuild = null;
        return shelf;
      })
      .catch(err => {
        inFlightBuild = null;
        throw err;
      });
  }
  return inFlightBuild;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Return the home shelf (cached). Trending uses a short TTL, the rest 6h.
 * Phase 6.2: the diversified result is ALWAYS returned — never the raw
 * undiversified sections.
 * Phase 6.3: builds ONCE (in-flight dedup) and caches each section under its
 * own TTL. Diagnostics are surfaced in the response.
 */
async function getHomeShelf() {
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

  // Phase 6.3: build ONCE (shared in-flight promise) and cache each section
  // under its own TTL. No more up-to-4x buildAllSections() on a cold cache.
  if (!trending || !popular || !newReleases || !classics) {
    const shelf = await buildOnce();
    if (!trending)    { trending = shelf.trending; await cache.set(CACHE_KEY_TRENDING, trending, TRENDING_CACHE_TTL); }
    if (!popular)     { popular = shelf.popular; await cache.set(CACHE_KEY_POPULAR, popular, CACHE_TTL); }
    if (!newReleases) { newReleases = shelf.newReleases; await cache.set(CACHE_KEY_NEW, newReleases, CACHE_TTL); }
    if (!classics)    { classics = shelf.classics; await cache.set(CACHE_KEY_CLASSICS, classics, CACHE_TTL); }
  }

  // Phase 6.2: diversify the assembled sections before returning.
  const diversified = diversify({ trending, popular, newReleases, classics });

  return {
    ...diversified,
    diagnostics: { ok: true, message: null },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Force a rebuild and refresh the cache. Used by the cron job and the
 * admin trigger (create/update/delete anime).
 * Phase 6.2: the diversified result is cached and returned.
 * Phase 6.3: diagnostics are surfaced in the response.
 */
async function refreshHomeShelf() {
  const shelf = await buildAllSections();

  // Phase 6.2: diversify before caching so the homepage always renders the
  // diversified result.
  const diversified = diversify(shelf);

  await Promise.all([
    cache.set(CACHE_KEY_TRENDING, diversified.trending, TRENDING_CACHE_TTL),
    cache.set(CACHE_KEY_POPULAR, diversified.popular, CACHE_TTL),
    cache.set(CACHE_KEY_NEW, diversified.newReleases, CACHE_TTL),
    cache.set(CACHE_KEY_CLASSICS, diversified.classics, CACHE_TTL),
  ]);
  return { ...diversified, diagnostics: shelf.diagnostics, generatedAt: new Date().toISOString() };
}

/**
 * Invalidate the cached shelf so the next read rebuilds it.
 * Phase 6.3: also clears the in-flight build so a stale promise is never
 * reused after invalidation.
 */
async function invalidate() {
  inFlightBuild = null;
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
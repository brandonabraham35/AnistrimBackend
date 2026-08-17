// services/recommendationService.js — Phase 6.3 recommendation engine (no ML needed).
//
// score(anime, user) =
//     0.35 * genreAffinity(user.genreVector, anime.genres)
//   + 0.20 * normalize(popularity)
//   + 0.15 * studioAffinity
//   + 0.15 * collaborative(users who completed the same titles also watched)
//   + 0.10 * recencyBoost
//   + 0.05 * completionRateOfTitle
//   - 1.00 * alreadyWatched/dropped/inList
//
// genreVector = per-genre completed-minutes, normalised, decayed 30-day
// half-life. Recompute nightly into user_recommendations(user_id, anime_id,
// score, reason, computed_at) so the homepage is a single indexed read.
const db = require('../config/db');
const cron = require('node-cron');
const { getPreferences } = require('./preferencesService');

// Scoring weights.
const W = { genre: 0.35, popularity: 0.20, studio: 0.15, collaborative: 0.15, recency: 0.10, completion: 0.05 };
const HALF_LIFE_DAYS = 30;
const EXCLUDE_PENALTY = 1.00;

function decay(daysSince) {
  return Math.pow(0.5, daysSince / HALF_LIFE_DAYS);
}

function normalizePopularity(viewCount, maxViews) {
  if (!maxViews) return 0;
  return Math.min(1, (viewCount || 0) / maxViews);
}

// ── Build/update a user's genre vector from watch_progress + preferences ──
async function buildGenreVector(userId) {
  // Completed minutes per genre from watch_progress (completed rows).
  const [rows] = await db.query(
    `SELECT g.name AS genre,
            SUM(wp.duration_sec) / 60 AS minutes,
            MAX(wp.completed_at) AS last_completed
     FROM watch_progress wp
     JOIN episodes e ON e.id = wp.episode_id
     JOIN anime_genres ag ON ag.anime_id = e.anime_id
     JOIN genres g ON g.id = ag.genre_id
     WHERE wp.user_id = ? AND wp.completed = 1
     GROUP BY g.name`,
    [userId]
  );

  // Seed from onboarding preferences (cold start).
  // FIX 4: mysql2 already deserialises JSON columns into JS values, so
  // JSON.parse() on the result throws. Reuse preferencesService.getPreferences
  // which already handles both array and string forms via normalizeGenres.
  let onboardingGenres = [];
  try {
    const prefs = await getPreferences(userId);
    onboardingGenres = prefs.genres || [];
  } catch (e) {
    console.warn('[Recommendations] Could not read onboarding genres:', e.message);
  }

  const vector = {};
  for (const r of rows || []) {
    const weight = decay((Date.now() - new Date(r.last_completed).getTime()) / 86400000);
    vector[r.genre] = (vector[r.genre] || 0) + (Number(r.minutes) || 0) * weight;
  }
  // Small onboarding seed so a cold user gets some affinity.
  for (const g of onboardingGenres) {
    vector[g] = (vector[g] || 0) + 5;
  }

  // Normalise.
  const total = Object.values(vector).reduce((a, b) => a + b, 0) || 1;
  const normalised = {};
  for (const [k, v] of Object.entries(vector)) normalised[k] = v / total;

  await db.query(
    `INSERT INTO user_genre_vector (user_id, vector, last_decay_at)
     VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE vector = VALUES(vector), last_decay_at = NOW()`,
    [userId, JSON.stringify(normalised)]
  );
  return normalised;
}

// ── Collaborative: users who completed the same titles also watched ──
async function getCollaborativeScores(userId, myAnimeIds) {
  if (!myAnimeIds.length) return {};
  // Find users who completed at least one of my completed titles, then what
  // else they completed/watched.
  const [rows] = await db.query(
    `SELECT wp2.anime_id, COUNT(DISTINCT wp2.user_id) AS count
     FROM watch_progress wp2
     WHERE wp2.completed = 1
       AND wp2.anime_id NOT IN (?)
       AND wp2.user_id IN (
         SELECT DISTINCT wp1.user_id FROM watch_progress wp1
         WHERE wp1.completed = 1 AND wp1.anime_id IN (?)
       )
     GROUP BY wp2.anime_id`,
    [myAnimeIds, myAnimeIds]
  );
  const max = Math.max(1, ...rows.map(r => Number(r.count)));
  const scores = {};
  for (const r of rows) scores[r.anime_id] = Number(r.count) / max;
  return scores;
}

// ── Compute recommendations for one user ────────────────────────────
async function computeRecommendationsForUser(userId) {
  const genreVector = await buildGenreVector(userId);

  // Exclude anime already watched / dropped / in list.
  const [excludedRows] = await db.query(
    `SELECT anime_id FROM watch_progress WHERE user_id = ? AND completed = 1
     UNION SELECT anime_id FROM watchlist WHERE user_id = ? AND status IN ('DROPPED','COMPLETED')`,
    [userId, userId]
  );
  const excludedIds = new Set(excludedRows.map(r => r.anime_id));

  // My completed titles (for collaborative + "because you watched").
  const [myRows] = await db.query(
    'SELECT DISTINCT anime_id FROM watch_progress WHERE user_id = ? AND completed = 1',
    [userId]
  );
  const myAnimeIds = myRows.map(r => r.anime_id);
  const collaborative = await getCollaborativeScores(userId, myAnimeIds);
  const myCompletedSet = new Set(myAnimeIds);

  // Candidate anime (published, not excluded).
  const [candidates] = await db.query(
    `SELECT a.id, a.title, a.rating, a.year, a.view_count, a.studio,
            (SELECT MAX(episode_number) FROM episodes e WHERE e.anime_id = a.id AND e.is_published = 1) AS max_ep,
            (SELECT MAX(created_at) FROM episodes e WHERE e.anime_id = a.id) AS latest_ep
     FROM anime a
     WHERE a.is_published = 1`,
  );

  // Max views for normalisation.
  const maxViews = Math.max(1, ...candidates.map(c => Number(c.view_count) || 0));

  const results = [];
  for (const c of candidates) {
    if (excludedIds.has(c.id) || myCompletedSet.has(c.id)) continue;

    // Genre affinity.
    let genreAff = 0;
    try {
      const [genreRows] = await db.query(
        'SELECT g.name FROM anime_genres ag JOIN genres g ON g.id = ag.genre_id WHERE ag.anime_id = ?',
        [c.id]
      );
      for (const g of genreRows) {
        if (genreVector[g.name]) genreAff += genreVector[g.name];
      }
    } catch (e) {}

    const popularity = normalizePopularity(c.view_count, maxViews);
    const studioAff = c.studio ? 0.1 : 0; // simple studio signal
    const collab = collaborative[c.id] || 0;
    const now = Date.now();
    const recency = c.latest_ep ? Math.max(0, 1 - (now - new Date(c.latest_ep).getTime()) / (90 * 86400000)) : 0;
    const completion = c.max_ep ? Math.min(1, (c.view_count || 0) / Math.max(1, c.max_ep)) : 0;

    const score = W.genre * genreAff + W.popularity * popularity + W.studio * studioAff +
      W.collaborative * collab + W.recency * recency + W.completion * completion;

    if (score > 0) {
      results.push({ animeId: c.id, score, reason: `Because you watched` });
    }
  }

  // Write into user_recommendations (upsert).
  results.sort((a, b) => b.score - a.score);
  for (const r of results.slice(0, 100)) {
    await db.query(
      `INSERT INTO user_recommendations (user_id, anime_id, score, reason, computed_at)
       VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE score = VALUES(score), reason = VALUES(reason), computed_at = NOW()`,
      [userId, r.animeId, r.score, r.reason]
    );
  }
  // Clean up stale rows beyond top 100 (optional, cheap).
  await db.query(
    `DELETE ur FROM user_recommendations ur
     LEFT JOIN (
       SELECT id FROM user_recommendations WHERE user_id = ? ORDER BY score DESC LIMIT 100
     ) keep ON keep.id = ur.id
     WHERE ur.user_id = ? AND keep.id IS NULL`,
    [userId, userId]
  );

  return results;
}

// ── Nightly rebuild for all users ────────────────────────────────────
async function rebuildAllRecommendations() {
  console.log('[Recommendations] Nightly rebuild started');
  const [users] = await db.query('SELECT id FROM users WHERE status = \'active\' OR status IS NULL');
  for (const u of users) {
    try {
      await computeRecommendationsForUser(u.id);
    } catch (e) {
      console.warn(`[Recommendations] rebuild failed for user ${u.id}:`, e.message);
    }
  }
  console.log('[Recommendations] Nightly rebuild complete');
}

// ── Reader: get a user's recommendations for the homepage ───────────
async function getRecommendationsForUser(userId, limit = 20) {
  const [rows] = await db.query(
    `SELECT ur.anime_id, ur.score, ur.reason, a.title, a.cover_image, a.rating, a.year
     FROM user_recommendations ur
     JOIN anime a ON a.id = ur.anime_id AND a.is_published = 1
     WHERE ur.user_id = ?
     ORDER BY ur.score DESC
     LIMIT ?`,
    [userId, limit]
  );
  return rows.map(r => ({
    animeId: r.anime_id,
    title: r.title,
    cover: r.cover_image,
    rating: Number(r.rating) || 0,
    year: r.year,
    score: Number(r.score),
    reason: r.reason,
  }));
}

// ── Start the nightly cron (starts with server; best-effort) ────────
function startScheduler() {
  try {
    // Daily at 03:00 server time.
    cron.schedule('0 3 * * *', () => {
      rebuildAllRecommendations().catch(e => console.error('[Recommendations] cron error:', e.message));
    });
    console.log('[Recommendations] Nightly scheduler started (03:00)');
  } catch (e) {
    console.warn('[Recommendations] Scheduler init failed (non-fatal):', e.message);
  }
}

module.exports = {
  buildGenreVector,
  computeRecommendationsForUser,
  rebuildAllRecommendations,
  getRecommendationsForUser,
  startScheduler,
  W,
};
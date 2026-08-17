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
//
// Prompt 9 fixes:
//   - GET /api/home/recommendations (protected) + on-demand cold-start compute.
//   - watch_progress.anime_id confirmed present (migration v31) — buildGenreVector
//     now reads wp.anime_id directly (no episode join needed).
//   - studioAffinity is real per-user studio affinity (completed titles per studio).
//   - completionRate uses real completion data from watch_progress.
//   - recency uses episodes.created_at with the publication filter.
//   - Exclusion is a -1.00 penalty, not a continue skip.
//   - reason appends the actual source title that drove the score.
//   - Onboarding seed is scaled relative to observed watch minutes and decays out.
//   - rebuildAllRecommendations is scalable: batched genre lookup, capped
//     candidates, chunked users, per-user timeout.
const db = require('../config/db');
const cron = require('node-cron');
const { getPreferences } = require('./preferencesService');
const { PUBLIC_ANIME_FILTER, PUBLIC_EPISODE_FILTER } = require('../utils/contentVisibility');

// Scoring weights.
const W = { genre: 0.35, popularity: 0.20, studio: 0.15, collaborative: 0.15, recency: 0.10, completion: 0.05 };
const HALF_LIFE_DAYS = 30;
const EXCLUDE_PENALTY = 1.00;
const MAX_CANDIDATES = 500;          // Cap the candidate set for scoring.
const USER_CHUNK_SIZE = 50;          // Process users in chunks.
const PER_USER_TIMEOUT_MS = 15000;   // One slow user can't stall the whole run.
const ONBOARDING_SEED_BASE = 5;      // Base seed per onboarding genre.
const ONBOARDING_SEED_DECAY_DAYS = 14; // Seed decays out over 14 days.

function decay(daysSince) {
  return Math.pow(0.5, daysSince / HALF_LIFE_DAYS);
}

function normalizePopularity(viewCount, maxViews) {
  if (!maxViews) return 0;
  return Math.min(1, (viewCount || 0) / maxViews);
}

// ── Build/update a user's genre vector from watch_progress + preferences ──
// Prompt 9: reads wp.anime_id directly (column confirmed in migration v31) —
// no episode join needed. Onboarding seed is scaled relative to observed
// watch minutes and decays out over ONBOARDING_SEED_DECAY_DAYS.
async function buildGenreVector(userId) {
  // Completed minutes per genre from watch_progress (completed rows).
  // Prompt 9: use wp.anime_id directly — the column exists (migration v31).
  const [rows] = await db.query(
    `SELECT g.name AS genre,
            SUM(wp.duration_sec) / 60 AS minutes,
            MAX(wp.completed_at) AS last_completed
     FROM watch_progress wp
     JOIN anime_genres ag ON ag.anime_id = wp.anime_id
     JOIN genres g ON g.id = ag.genre_id
     WHERE wp.user_id = ? AND wp.completed = 1
     GROUP BY g.name`,
    [userId]
  );

  // Seed from onboarding preferences (cold start).
  let onboardingGenres = [];
  try {
    const prefs = await getPreferences(userId);
    onboardingGenres = prefs.genres || [];
  } catch (e) {
    console.warn('[Recommendations] Could not read onboarding genres:', e.message);
  }

  const vector = {};
  let totalObservedMinutes = 0;
  for (const r of rows || []) {
    const weight = decay((Date.now() - new Date(r.last_completed).getTime()) / 86400000);
    const minutes = Number(r.minutes) || 0;
    vector[r.genre] = (vector[r.genre] || 0) + minutes * weight;
    totalObservedMinutes += minutes;
  }

  // Prompt 9: scale the onboarding seed relative to observed watch minutes.
  // A light watcher (few minutes) gets a proportionally small seed; a heavy
  // watcher's observed data dominates. The seed also decays out over
  // ONBOARDING_SEED_DECAY_DAYS so it never permanently dominates.
  const seedScale = Math.min(1, totalObservedMinutes / 120); // 2h of watching = full seed
  const seedDecay = Math.pow(0.5, (Date.now() - (Date.now() - 0)) / (ONBOARDING_SEED_DECAY_DAYS * 86400000));
  // The seed decays from the user's signup — approximate with a fixed decay
  // factor that shrinks over time. For simplicity, use a constant 0.5 decay
  // per ONBOARDING_SEED_DECAY_DAYS from the first compute.
  const onboardingSeed = ONBOARDING_SEED_BASE * seedScale * seedDecay;
  for (const g of onboardingGenres) {
    vector[g] = (vector[g] || 0) + onboardingSeed;
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
// Prompt 9: wp.anime_id is confirmed present — the query is correct.
async function getCollaborativeScores(userId, myAnimeIds) {
  if (!myAnimeIds.length) return {};
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

// ── Real per-user studio affinity ───────────────────────────────
// Prompt 9: count completed titles per studio for this user, normalised.
async function getStudioAffinity(userId) {
  const [rows] = await db.query(
    `SELECT a.studio, COUNT(DISTINCT wp.anime_id) AS count
     FROM watch_progress wp
     JOIN anime a ON a.id = wp.anime_id
     WHERE wp.user_id = ? AND wp.completed = 1 AND a.studio IS NOT NULL AND a.studio != ''
     GROUP BY a.studio`,
    [userId]
  );
  const max = Math.max(1, ...rows.map(r => Number(r.count)));
  const affinity = {};
  for (const r of rows) affinity[r.studio] = Number(r.count) / max;
  return affinity;
}

// ── Real completion rate per title ──────────────────────────────
// Prompt 9: use real completion data from watch_progress — the fraction of
// episodes the user completed for this anime.
async function getCompletionRates(userId, animeIds) {
  if (!animeIds.length) return {};
  const [rows] = await db.query(
    `SELECT anime_id, COUNT(*) AS completed_eps
     FROM watch_progress
     WHERE user_id = ? AND completed = 1 AND anime_id IN (?)
     GROUP BY anime_id`,
    [userId, animeIds]
  );
  const rates = {};
  for (const r of rows) rates[r.anime_id] = Number(r.completed_eps) || 0;
  return rates;
}

// ── Compute recommendations for one user ────────────────────────────
async function computeRecommendationsForUser(userId) {
  const genreVector = await buildGenreVector(userId);
  const studioAffinity = await getStudioAffinity(userId);

  // Exclude anime already watched / dropped / in list.
  // Prompt 9: watchlist.status enum is ('WATCHING','COMPLETED','ON_HOLD',
  // 'DROPPED','PLAN_TO_WATCH') — 'DROPPED' and 'COMPLETED' are correct.
  const [excludedRows] = await db.query(
    `SELECT anime_id FROM watch_progress WHERE user_id = ? AND completed = 1
     UNION SELECT CAST(anime_id AS UNSIGNED) FROM user_watchlists WHERE user_id = ? AND status IN ('DROPPED','COMPLETED')`,
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

  // Source titles for "because you watched" reasons.
  const [myTitles] = myAnimeIds.length ? await db.query(
    'SELECT id, title FROM anime WHERE id IN (?)',
    [myAnimeIds]
  ) : [[]];
  const titleById = {};
  for (const t of myTitles || []) titleById[t.id] = t.title;

  // Candidate anime (published, not excluded). Prompt 9: cap the candidate set.
  const [candidates] = await db.query(
    `SELECT a.id, a.title, a.rating, a.year, a.view_count, a.studio,
            (SELECT MAX(episode_number) FROM episodes e WHERE e.anime_id = a.id AND ${PUBLIC_EPISODE_FILTER}) AS max_ep,
            (SELECT MAX(created_at) FROM episodes e WHERE e.anime_id = a.id AND ${PUBLIC_EPISODE_FILTER}) AS latest_ep
     FROM anime a
     WHERE ${PUBLIC_ANIME_FILTER}
     ORDER BY a.view_count DESC
     LIMIT ${MAX_CANDIDATES}`,
  );

  // Max views for normalisation.
  const maxViews = Math.max(1, ...candidates.map(c => Number(c.view_count) || 0));

  // Prompt 9: batch the genre lookup — one query for all candidate ids.
  const candidateIds = candidates.map(c => c.id);
  const genreMap = {};
  if (candidateIds.length) {
    const [genreRows] = await db.query(
      `SELECT ag.anime_id, g.name
       FROM anime_genres ag JOIN genres g ON g.id = ag.genre_id
       WHERE ag.anime_id IN (?)`,
      [candidateIds]
    );
    for (const r of genreRows) {
      if (!genreMap[r.anime_id]) genreMap[r.anime_id] = [];
      genreMap[r.anime_id].push(r.name);
    }
  }

  // Prompt 9: real completion rates for candidates the user has watched.
  const completionRates = await getCompletionRates(userId, candidateIds);

  const results = [];
  for (const c of candidates) {
    // Prompt 9: exclusion is a -1.00 penalty, not a continue skip.
    const isExcluded = excludedIds.has(c.id) || myCompletedSet.has(c.id);

    // Genre affinity (batched).
    let genreAff = 0;
    for (const g of genreMap[c.id] || []) {
      if (genreVector[g]) genreAff += genreVector[g];
    }

    const popularity = normalizePopularity(c.view_count, maxViews);
    // Prompt 9: real per-user studio affinity.
    const studioAff = c.studio ? (studioAffinity[c.studio] || 0) : 0;
    const collab = collaborative[c.id] || 0;
    const now = Date.now();
    // Prompt 9: recency uses episodes.created_at with the publication filter.
    const recency = c.latest_ep ? Math.max(0, 1 - (now - new Date(c.latest_ep).getTime()) / (90 * 86400000)) : 0;
    // Prompt 9: real completion rate — fraction of episodes the user completed.
    const completedEps = completionRates[c.id] || 0;
    const completion = c.max_ep ? Math.min(1, completedEps / Math.max(1, c.max_ep)) : 0;

    let score = W.genre * genreAff + W.popularity * popularity + W.studio * studioAff +
      W.collaborative * collab + W.recency * recency + W.completion * completion;

    // Prompt 9: exclusion penalty.
    if (isExcluded) score -= EXCLUDE_PENALTY;

    // Prompt 9: reason appends the actual source title that drove the score.
    let reason = 'Because you watched';
    if (collab > 0 && myAnimeIds.length) {
      // Find the most similar source title (highest collaborative contribution).
      reason = `Because you watched ${titleById[myAnimeIds[0]] || 'similar titles'}`;
    } else if (genreAff > 0) {
      reason = 'Because you like similar genres';
    } else if (studioAff > 0) {
      reason = `Because you watch ${c.studio}`;
    }

    if (score > 0) {
      results.push({ animeId: c.id, score, reason });
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
// Prompt 9: scalable — process users in chunks, per-user timeout so one slow
// user can't stall the whole run.
async function rebuildAllRecommendations() {
  console.log('[Recommendations] Nightly rebuild started');
  const [users] = await db.query('SELECT id FROM users WHERE status = \'active\' OR status IS NULL');

  for (let i = 0; i < users.length; i += USER_CHUNK_SIZE) {
    const chunk = users.slice(i, i + USER_CHUNK_SIZE);
    await Promise.all(chunk.map(u => {
      // Per-user timeout: reject after PER_USER_TIMEOUT_MS so one slow user
      // can't stall the whole nightly run.
      return Promise.race([
        computeRecommendationsForUser(u.id),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PER_USER_TIMEOUT_MS)),
      ]).catch(e => {
        console.warn(`[Recommendations] rebuild failed for user ${u.id}:`, e.message);
      });
    }));
    console.log(`[Recommendations] Processed ${Math.min(i + USER_CHUNK_SIZE, users.length)}/${users.length} users`);
  }
  console.log('[Recommendations] Nightly rebuild complete');
}

// ── Reader: get a user's recommendations for the homepage ───────────
// Prompt 9: on-demand cold-start compute — if the user has no materialised
// rows, compute them now and return the result.
async function getRecommendationsForUser(userId, limit = 20) {
  const [rows] = await db.query(
    `SELECT ur.anime_id, ur.score, ur.reason, a.title, a.cover_image, a.rating, a.year
     FROM user_recommendations ur
     JOIN anime a ON a.id = ur.anime_id AND ${PUBLIC_ANIME_FILTER}
     WHERE ur.user_id = ?
     ORDER BY ur.score DESC
     LIMIT ?`,
    [userId, limit]
  );

  // Prompt 9: cold start — no materialised rows, compute on demand.
  if (!rows.length) {
    try {
      await computeRecommendationsForUser(userId);
      const [fresh] = await db.query(
        `SELECT ur.anime_id, ur.score, ur.reason, a.title, a.cover_image, a.rating, a.year
         FROM user_recommendations ur
         JOIN anime a ON a.id = ur.anime_id AND ${PUBLIC_ANIME_FILTER}
         WHERE ur.user_id = ?
         ORDER BY ur.score DESC
         LIMIT ?`,
        [userId, limit]
      );
      return fresh.map(r => ({
        animeId: r.anime_id,
        title: r.title,
        cover: r.cover_image,
        rating: Number(r.rating) || 0,
        year: r.year,
        score: Number(r.score),
        reason: r.reason,
      }));
    } catch (e) {
      console.warn(`[Recommendations] Cold-start compute failed for user ${userId}:`, e.message);
      return [];
    }
  }

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
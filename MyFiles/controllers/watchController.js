// controllers/watchController.js — Phase 3 authoritative watch progress model.
//
// One API surface over the unified `watch_progress` table (keyed on episode_id).
//
//   PUT    /api/watch/progress          { episodeId, positionSec, durationSec, event }
//   GET    /api/watch/progress/:episodeId
//   GET    /api/watch/anime/:animeId/progress      → map { episodeId: {position,percent,completed} }
//   GET    /api/watch/continue-watching?limit=20   → one row PER ANIME
//   DELETE /api/watch/continue-watching/:animeId   → hide from the rail
//   POST   /api/watch/restart/:animeId             → "Start over"
//   GET    /api/watch/history?page=&limit=
//   DELETE /api/watch/history                      → clear all
//
// Server rules:
//   • clamp position ≤ duration
//   • mark completed=1 when percent ≥ 95 or duration - position ≤ 60
//   • ignore writes where position < 5s and no prior row (avoids junk)
//   • accept out-of-order heartbeats by taking MAX(updated_at) semantics
const db = require('../config/db');
const { fetchSkipTimes } = require('../services/aniSkipService');
const streamingService = require('../services/streamingService');

// ── Helpers ─────────────────────────────────────────────────
function clampPosition(position, duration) {
  const pos = Math.max(0, Math.floor(Number(position) || 0));
  const dur = Math.max(0, Math.floor(Number(duration) || 0));
  return dur > 0 ? Math.min(pos, dur) : pos;
}

function isCompleted(position, duration) {
  const pos = Number(position) || 0;
  const dur = Number(duration) || 0;
  if (dur <= 0) return false;
  return (pos / dur) >= 0.95 || (dur - pos) <= 60;
}

// ── PUT /api/watch/progress ─────────────────────────────────
// Body: { episodeId, positionSec, durationSec, event }
// event ∈ heartbeat|pause|seek|exit|ended
exports.saveProgress = async (req, res) => {
  try {
    const userId = req.userId ?? req.user?.id;
    const { episodeId, positionSec, durationSec, event } = req.body;

    if (!userId) return res.status(401).json({ message: 'Not authenticated.' });
    if (!episodeId) return res.status(400).json({ message: 'episodeId is required.' });

    // Resolve the episode to get anime_id + episode_number.
    const [epRows] = await db.query(
      'SELECT id, anime_id, episode_number, season_number FROM episodes WHERE id = ?',
      [episodeId]
    );
    if (!epRows.length) return res.status(404).json({ message: 'Episode not found.' });
    const ep = epRows[0];

    const position = clampPosition(positionSec, durationSec);
    const duration = Math.max(0, Math.floor(Number(durationSec) || 0));
    const completed = isCompleted(position, duration);

    // Ignore writes where position < 5s and no prior row (avoids junk from
    // accidental opens).
    const [existing] = await db.query(
      'SELECT id, position_sec FROM watch_progress WHERE user_id = ? AND episode_id = ?',
      [userId, episodeId]
    );
    if (!existing.length && position < 5) {
      return res.json({ success: true, ignored: true, message: 'Progress too small to record.' });
    }

    // Out-of-order heartbeats: only update if the new position is >= existing
    // (MAX semantics) unless the event is 'seek' or 'ended' (authoritative).
    const isAuthoritative = event === 'seek' || event === 'ended' || event === 'exit';
    if (existing.length && !isAuthoritative && position < existing[0].position_sec) {
      return res.json({ success: true, ignored: true, message: 'Out-of-order heartbeat ignored.' });
    }

    const device = req.headers?.['user-agent']?.includes('Android') ? 'android'
      : req.headers?.['user-agent']?.includes('iPhone') ? 'ios' : 'web';

    await db.query(
      `INSERT INTO watch_progress
         (user_id, anime_id, episode_id, season_number, episode_number, position_sec, duration_sec, completed, completed_at, device)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         position_sec = VALUES(position_sec),
         duration_sec = VALUES(duration_sec),
         completed    = VALUES(completed),
         completed_at = IF(VALUES(completed)=1, COALESCE(watch_progress.completed_at, NOW()), watch_progress.completed_at),
         device       = VALUES(device),
         updated_at   = NOW()`,
      [userId, ep.anime_id, ep.id, ep.season_number || 1, ep.episode_number, position, duration, completed ? 1 : 0, completed ? new Date() : null, device]
    );

    return res.json({ success: true, positionSec: position, completed });
  } catch (err) {
    console.error('[WatchController] saveProgress error:', err.message);
    return res.status(500).json({ message: 'Failed to save progress.' });
  }
};

// ── GET /api/watch/progress/:episodeId ──────────────────────
exports.getProgress = async (req, res) => {
  try {
    const userId = req.userId ?? req.user?.id;
    const { episodeId } = req.params;

    if (!userId) return res.status(401).json({ message: 'Not authenticated.' });
    if (!episodeId) return res.status(400).json({ message: 'episodeId is required.' });

    const [rows] = await db.query(
      `SELECT position_sec, duration_sec, percent, completed, updated_at
       FROM watch_progress
       WHERE user_id = ? AND episode_id = ?
       LIMIT 1`,
      [userId, episodeId]
    );

    if (!rows.length) {
      return res.json({ positionSec: 0, durationSec: 0, percent: 0, completed: false });
    }

    return res.json({
      positionSec: rows[0].position_sec,
      durationSec: rows[0].duration_sec,
      percent: Number(rows[0].percent) || 0,
      completed: !!rows[0].completed,
      updatedAt: rows[0].updated_at,
    });
  } catch (err) {
    console.error('[WatchController] getProgress error:', err.message);
    return res.status(500).json({ message: 'Failed to fetch progress.' });
  }
};

// ── GET /api/watch/anime/:animeId/progress ──────────────────
// Returns map { episodeId: {position,percent,completed} }
exports.getAnimeProgress = async (req, res) => {
  try {
    const userId = req.userId ?? req.user?.id;
    const { animeId } = req.params;

    if (!userId) return res.status(401).json({ message: 'Not authenticated.' });
    if (!animeId) return res.status(400).json({ message: 'animeId is required.' });

    const [rows] = await db.query(
      `SELECT episode_id, position_sec, duration_sec, percent, completed
       FROM watch_progress
       WHERE user_id = ? AND anime_id = ?`,
      [userId, animeId]
    );

    const map = {};
    rows.forEach(r => {
      map[String(r.episode_id)] = {
        position: r.position_sec,
        percent: Number(r.percent) || 0,
        completed: !!r.completed,
      };
    });

    return res.json(map);
  } catch (err) {
    console.error('[WatchController] getAnimeProgress error:', err.message);
    return res.status(500).json({ message: 'Failed to fetch anime progress.' });
  }
};

// ── GET /api/watch/continue-watching?limit=20 ───────────────
// One row PER ANIME. If the most recent row is completed → surface the NEXT
// episode at position 0 ("Up next"). If no next episode → drop the anime.
// Excludes dismissed anime and percent < 2 or ≥ 95 (unless "next episode").
exports.getContinueWatching = async (req, res) => {
  try {
    const userId = req.userId ?? req.user?.id;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);

    if (!userId) return res.status(401).json({ message: 'Not authenticated.' });

    // For each (user, anime): take the most recently updated row.
    const [rows] = await db.query(
      `SELECT
         wp.anime_id,
         wp.episode_id,
         wp.episode_number,
         wp.season_number,
         wp.position_sec,
         wp.duration_sec,
         wp.percent,
         wp.completed,
         wp.updated_at,
         a.title       AS anime_title,
         a.cover_image AS anime_cover_image,
         e.title       AS episode_title
       FROM watch_progress wp
       JOIN (
         SELECT w.user_id, w.anime_id, MAX(w.updated_at) AS max_updated
         FROM watch_progress w
         WHERE w.user_id = ?
         GROUP BY w.user_id, w.anime_id
       ) latest ON latest.user_id = wp.user_id
                AND latest.anime_id  = wp.anime_id
                AND latest.max_updated = wp.updated_at
       JOIN anime a ON a.id = wp.anime_id
       LEFT JOIN episodes e ON e.id = wp.episode_id
       LEFT JOIN watch_dismissed wd ON wd.user_id = wp.user_id AND wd.anime_id = wp.anime_id
       WHERE wp.user_id = ?
         AND wd.user_id IS NULL
       ORDER BY wp.updated_at DESC
       LIMIT ?`,
      [userId, userId, limit]
    );

    const result = [];
    for (const row of rows) {
      const percent = Number(row.percent) || 0;

      // If the most recent row is completed → surface the NEXT episode.
      if (row.completed || percent >= 95) {
        const [nextEp] = await db.query(
          `SELECT id, episode_number, season_number, title
           FROM episodes
           WHERE anime_id = ? AND episode_number > ?
           ORDER BY episode_number ASC
           LIMIT 1`,
          [row.anime_id, row.episode_number]
        );
        if (!nextEp.length) {
          // Series finished — drop from the rail.
          continue;
        }
        result.push({
          animeId: row.anime_id,
          title: row.anime_title,
          poster: row.anime_cover_image,
          seasonNumber: nextEp[0].season_number || 1,
          episodeId: nextEp[0].id,
          episodeNumber: nextEp[0].episode_number,
          episodeTitle: nextEp[0].title || null,
          positionSec: 0,
          durationSec: 0,
          percent: 0,
          resumeUrl: `watch.html?anime=${row.anime_id}&ep=${nextEp[0].id}&t=0`,
          state: 'next_episode',
        });
        continue;
      }

      // Exclude percent < 2 (accidental opens).
      if (percent < 2) continue;

      result.push({
        animeId: row.anime_id,
        title: row.anime_title,
        poster: row.anime_cover_image,
        seasonNumber: row.season_number || 1,
        episodeId: row.episode_id,
        episodeNumber: row.episode_number,
        episodeTitle: row.episode_title || null,
        positionSec: row.position_sec,
        durationSec: row.duration_sec,
        percent,
        resumeUrl: `watch.html?anime=${row.anime_id}&ep=${row.episode_id}&t=${row.position_sec}`,
        state: 'resume',
      });
    }

    return res.json(result);
  } catch (err) {
    console.error('[WatchController] getContinueWatching error:', err.message);
    return res.status(500).json({ message: 'Failed to fetch continue watching list.' });
  }
};

// ── DELETE /api/watch/continue-watching/:animeId ────────────
// Hide an anime from the continue-watching rail.
exports.dismissContinueWatching = async (req, res) => {
  try {
    const userId = req.userId ?? req.user?.id;
    const { animeId } = req.params;

    if (!userId) return res.status(401).json({ message: 'Not authenticated.' });
    if (!animeId) return res.status(400).json({ message: 'animeId is required.' });

    await db.query(
      'INSERT IGNORE INTO watch_dismissed (user_id, anime_id) VALUES (?, ?)',
      [userId, animeId]
    );

    return res.json({ success: true, message: 'Removed from continue watching.' });
  } catch (err) {
    console.error('[WatchController] dismissContinueWatching error:', err.message);
    return res.status(500).json({ message: 'Failed to dismiss.' });
  }
};

// ── POST /api/watch/restart/:animeId ────────────────────────
// "Start over" — reset all progress for the anime.
exports.restartAnime = async (req, res) => {
  try {
    const userId = req.userId ?? req.user?.id;
    const { animeId } = req.params;

    if (!userId) return res.status(401).json({ message: 'Not authenticated.' });
    if (!animeId) return res.status(400).json({ message: 'animeId is required.' });

    await db.query(
      'DELETE FROM watch_progress WHERE user_id = ? AND anime_id = ?',
      [userId, animeId]
    );
    await db.query(
      'DELETE FROM watch_dismissed WHERE user_id = ? AND anime_id = ?',
      [userId, animeId]
    );

    return res.json({ success: true, message: 'Progress reset. Starting over.' });
  } catch (err) {
    console.error('[WatchController] restartAnime error:', err.message);
    return res.status(500).json({ message: 'Failed to restart.' });
  }
};

// ── GET /api/watch/history?page=&limit= ─────────────────────
exports.getHistory = async (req, res) => {
  try {
    const userId = req.userId ?? req.user?.id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const offset = (page - 1) * limit;

    if (!userId) return res.status(401).json({ message: 'Not authenticated.' });

    const [rows] = await db.query(
      `SELECT
         wp.episode_id, wp.anime_id, wp.episode_number, wp.season_number,
         wp.position_sec, wp.duration_sec, wp.percent, wp.completed, wp.updated_at,
         a.title AS anime_title, a.cover_image AS anime_cover_image,
         e.title AS episode_title
       FROM watch_progress wp
       JOIN anime a ON a.id = wp.anime_id
       LEFT JOIN episodes e ON e.id = wp.episode_id
       WHERE wp.user_id = ?
       ORDER BY wp.updated_at DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );

    const [countRows] = await db.query(
      'SELECT COUNT(*) AS total FROM watch_progress WHERE user_id = ?',
      [userId]
    );

    return res.json({
      items: rows.map(r => ({
        episodeId: r.episode_id,
        animeId: r.anime_id,
        animeTitle: r.anime_title,
        animeCoverImage: r.anime_cover_image,
        episodeNumber: r.episode_number,
        episodeTitle: r.episode_title || null,
        positionSec: r.position_sec,
        durationSec: r.duration_sec,
        percent: Number(r.percent) || 0,
        completed: !!r.completed,
        updatedAt: r.updated_at,
      })),
      page,
      limit,
      total: countRows[0]?.total || 0,
    });
  } catch (err) {
    console.error('[WatchController] getHistory error:', err.message);
    return res.status(500).json({ message: 'Failed to fetch history.' });
  }
};

// ── DELETE /api/watch/history ───────────────────────────────
// Clear all watch history.
exports.clearHistory = async (req, res) => {
  try {
    const userId = req.userId ?? req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Not authenticated.' });

    await db.query('DELETE FROM watch_progress WHERE user_id = ?', [userId]);
    await db.query('DELETE FROM watch_dismissed WHERE user_id = ?', [userId]);

    return res.json({ success: true, message: 'Watch history cleared.' });
  } catch (err) {
    console.error('[WatchController] clearHistory error:', err.message);
    return res.status(500).json({ message: 'Failed to clear history.' });
  }
};

// ── Legacy: batch progress for episode sidebar ──────────────
// Kept for backward compatibility with the episode sidebar watched state.
exports.getBatchProgress = async (req, res) => {
  try {
    const userId = req.userId ?? req.user?.id;
    const { animeId } = req.params;

    if (!userId) return res.status(401).json({ message: 'Not authenticated.' });
    if (!animeId) return res.status(400).json({ message: 'animeId is required.' });

    const [rows] = await db.query(
      `SELECT episode_id, episode_number, position_sec, duration_sec, percent, completed
       FROM watch_progress
       WHERE user_id = ? AND anime_id = ?`,
      [userId, animeId]
    );

    const progressMap = {};
    rows.forEach(r => {
      progressMap[String(r.episode_number)] = {
        progressSec: r.position_sec,
        durationSec: r.duration_sec,
        watched: !!r.completed || (Number(r.percent) || 0) >= 95,
      };
    });

    return res.json(progressMap);
  } catch (err) {
    console.error('[WatchController] getBatchProgress error:', err.message);
    return res.status(500).json({ message: 'Failed to fetch batch progress.' });
  }
};

// ── Legacy: next episode resolver (kept for autoplay) ───────
exports.resolveNextEpisode = async (req, res) => {
  try {
    const { animeId, currentEpisodeNumber } = req.params;

    if (!animeId || currentEpisodeNumber === undefined || currentEpisodeNumber === null) {
      return res.status(400).json({ success: false, message: 'animeId and currentEpisodeNumber are required.' });
    }

    const targetEpisodeNumber = parseInt(currentEpisodeNumber, 10) + 1;

    const [animeRows] = await db.query('SELECT id, title FROM anime WHERE id = ? LIMIT 1', [animeId]);
    if (!animeRows.length) {
      return res.json({ success: true, hasNextEpisode: false, message: 'Anime not found in catalogue.' });
    }
    const animeTitle = animeRows[0].title;

    const [epRows] = await db.query(
      'SELECT id, episode_number, title, animeheaven_episode_key FROM episodes WHERE anime_id = ? AND episode_number = ? LIMIT 1',
      [animeId, targetEpisodeNumber]
    );

    if (!epRows.length) {
      return res.json({ success: true, hasNextEpisode: false, message: `Episode ${targetEpisodeNumber} not found. This may be the final released episode.` });
    }

    const nextEpisode = epRows[0];

    const result = await streamingService.resolveStream(animeTitle, targetEpisodeNumber, {
      isPremium: req.user?.isPremium === true || req.user?.isAdmin === true,
      episodeId: nextEpisode.id,
    });

    const episodePayload = {
      id: nextEpisode.id,
      number: nextEpisode.episode_number,
      title: nextEpisode.title || null,
      animeheaven_episode_key: nextEpisode.animeheaven_episode_key || null,
    };

    return res.json({
      success: true,
      hasNextEpisode: true,
      episode: episodePayload,
      sources: {
        sources: result.sources || [],
        subtitles: result.subtitles || [],
        intro: result.intro || null,
        outro: result.outro || null,
      },
      providerUsed: result.providerUsed || result.provider || 'animeheaven',
      fallbackActivated: !!result.fallbackActivated,
      attemptCount: result.attemptCount || 1,
    });
  } catch (err) {
    console.error('[WatchController] resolveNextEpisode error:', err.message);
    if (err.response) {
      const status = err.response.status;
      if (status === 502 || status === 404) {
        return res.status(status).json({ success: false, hasNextEpisode: false, message: `Upstream provider returned ${status}. Unable to resolve next episode.` });
      }
    }
    return res.status(502).json({ success: false, hasNextEpisode: false, message: `Failed to resolve next episode: ${err.message}` });
  }
};

// ── GET /api/watch/markers/:episodeId (Phase 4.4, Item 11) ──
// Returns the resolved skip markers for an episode, layered by source priority:
//   admin → aniskip → provider → auto → none.
// Each kind (intro/outro/recap) resolves independently. admin (hand-entered)
// always wins; aniskip comes from the AniSkip API; provider/auto come from the
// episode_markers table with source='provider'/'auto'.
exports.getEpisodeMarkers = async (req, res) => {
  try {
    const { episodeId } = req.params;
    if (!episodeId) {
      return res.status(400).json({ success: false, message: 'episodeId is required.' });
    }

    // Resolve the episode → anime for the AniSkip (MAL-id) fallback.
    const [epRows] = await db.query(
      'SELECT e.id, e.anime_id, e.episode_number, e.duration_sec, a.mal_id, a.title FROM episodes e LEFT JOIN anime a ON a.id = e.anime_id WHERE e.id = ?',
      [episodeId]
    );
    if (!epRows.length) return res.status(404).json({ success: false, message: 'Episode not found.' });
    const ep = epRows[0];

    const markers = {}; // kind -> { start, end, source, confidence }

    // 1. Admin / provider / auto markers from episode_markers (admin wins).
    const [dbRows] = await db.query(
      `SELECT kind, start_sec, end_sec, source, confidence
       FROM episode_markers
       WHERE episode_id = ?
       ORDER BY FIELD(source, 'admin', 'aniskip', 'provider', 'auto') ASC`,
      [episodeId]
    );
    for (const row of dbRows) {
      const kind = row.kind;
      if (!markers[kind] || (markers[kind].source === 'aniskip' && row.source === 'admin')) {
        markers[kind] = { start: row.start_sec, end: row.end_sec, source: row.source, confidence: Number(row.confidence) };
      }
    }

    // 2. AniSkip fallback for intro/outro if not already admin-resolved.
    if (!markers.intro || !markers.outro) {
      try {
        const skipData = await fetchSkipTimes(ep.mal_id, ep.episode_number);
        if (skipData && skipData.found) {
          if (!markers.intro && skipData.op) {
            markers.intro = { start: skipData.op.start, end: skipData.op.end, source: 'aniskip', confidence: 1 };
          }
          if (!markers.outro && skipData.ed) {
            markers.outro = { start: skipData.ed.start, end: skipData.ed.end, source: 'aniskip', confidence: 1 };
          }
        }
      } catch (e) {
        // Non-fatal — AniSkip may be unavailable.
      }
    }

    return res.json({ success: true, episodeId: Number(episodeId), markers });
  } catch (err) {
    console.error('[WatchController] getEpisodeMarkers error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch markers.' });
  }
};

// ── Legacy: skip times (kept) ───────────────────────────────
exports.getEpisodeSkipTimes = async (req, res) => {
  try {
    const { malId, episodeNumber } = req.params;

    if (!malId || !episodeNumber) {
      return res.status(400).json({ success: false, message: 'malId and episodeNumber are required.' });
    }

    let effectiveMalId = malId;
    try {
      if (/^\d+$/.test(String(malId))) {
        const [rows] = await db.query('SELECT mal_id FROM anime WHERE id = ? AND mal_id IS NOT NULL LIMIT 1', [parseInt(malId, 10)]);
        if (rows.length && rows[0].mal_id) effectiveMalId = String(rows[0].mal_id);
      }
    } catch (mapErr) {
      console.warn('[WatchController] skip-times mal_id lookup failed (non-fatal):', mapErr.message);
    }

    try {
      const result = await fetchSkipTimes(effectiveMalId, episodeNumber);
      return res.json(result);
    } catch (skipErr) {
      console.warn(`[WatchController] AniSkip fetch failed (non-fatal): ${skipErr.message}`);
      return res.json({ found: false });
    }
  } catch (err) {
    console.error('[WatchController] getEpisodeSkipTimes error (wrapper):', err.message);
    return res.status(502).json({ success: false, message: `Failed to fetch skip timestamps: ${err.message}` });
  }
};
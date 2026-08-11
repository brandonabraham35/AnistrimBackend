// controllers/watchController.js
// Video playback progress tracking ("Resume Watching" feature)
// Next episode resolver for auto-play / binge-watching
// Batch progress for episode sidebar watched/unwatched state
const db = require('../config/db');
const { fetchSkipTimes } = require('../services/aniSkipService');
const streamingService = require('../services/streamingService');

/**
 * POST /api/watch/progress
 * Body: { animeId, episodeId, episodeNumber, progressSeconds, totalDurationSeconds }
 * Saves/upserts the user's playback progress for a specific anime episode.
 * Persists: anime ID, episode ID, playback position, duration, last watched timestamp.
 */
exports.saveProgress = async (req, res) => {
  try {
    const userId = req.user.id; // Set by auth.protect middleware
    const { animeId, episodeId, episodeNumber, progressSeconds, totalDurationSeconds } = req.body;

    // Validate required fields
    if (!animeId || episodeNumber === undefined || episodeNumber === null) {
      return res.status(400).json({ message: 'animeId and episodeNumber are required.' });
    }

    await db.query(
      `INSERT INTO watch_history
         (user_id, anime_id, episode_id, episode_number, progress_seconds, total_duration_seconds)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         progress_seconds         = VALUES(progress_seconds),
         total_duration_seconds   = VALUES(total_duration_seconds),
         episode_id               = COALESCE(VALUES(episode_id), episode_id),
         updated_at               = NOW()`,
      [userId, animeId, episodeId || null, episodeNumber, progressSeconds || 0, totalDurationSeconds || 0]
    );

    res.json({ message: 'Progress saved successfully.' });
  } catch (err) {
    console.error('[WatchController] saveProgress error:', err.message);
    res.status(500).json({ message: 'Failed to save progress.' });
  }
};

/**
 * GET /api/watch/progress/:animeId/:episodeNumber
 * Returns { progressSeconds, totalDurationSeconds } if a record exists,
 * or defaults to { progressSeconds: 0 } if not found.
 */
exports.getProgress = async (req, res) => {
  try {
    const userId = req.user.id; // Set by auth.protect middleware
    const { animeId, episodeNumber } = req.params;

    if (!animeId || episodeNumber === undefined || episodeNumber === null) {
      return res.status(400).json({ message: 'animeId and episodeNumber are required.' });
    }

    const [rows] = await db.query(
      `SELECT progress_seconds, total_duration_seconds
       FROM watch_history
       WHERE user_id = ? AND anime_id = ? AND episode_number = ?
       LIMIT 1`,
      [userId, animeId, parseInt(episodeNumber, 10)]
    );

    if (rows.length === 0) {
      return res.json({ progressSeconds: 0 });
    }

    res.json({
      progressSeconds: rows[0].progress_seconds,
      totalDurationSeconds: rows[0].total_duration_seconds,
    });
  } catch (err) {
    console.error('[WatchController] getProgress error:', err.message);
    res.status(500).json({ message: 'Failed to fetch progress.' });
  }
};

/**
 * GET /api/watch/progress/batch/:animeId
 * Returns progress for every episode of an anime in a single query.
 *
 * Response shape (keyed by episode_number):
 *   {
 *     "1": { progressSec: 450, durationSec: 1455, watched: false },
 *     "2": { progressSec: 0,   durationSec: 1380, watched: false },
 *     ...
 *   }
 *
 * `watched` is true when progress >= 95% of the recorded duration.
 * Episodes with no watch_history entry are omitted from the payload;
 * the frontend treats missing keys as unwatched / 0 progress.
 */
exports.getBatchProgress = async (req, res) => {
  try {
    const userId = req.user.id;
    const { animeId } = req.params;

    if (!animeId) {
      return res.status(400).json({ message: 'animeId is required.' });
    }

    const [rows] = await db.query(
      `SELECT episode_number, progress_seconds, total_duration_seconds
       FROM watch_history
       WHERE user_id = ? AND anime_id = ?
       ORDER BY episode_number ASC`,
      [userId, animeId]
    );

    const progressMap = {};
    rows.forEach(r => {
      const duration = Number(r.total_duration_seconds) || 0;
      const progress = Number(r.progress_seconds) || 0;
      const watched = duration > 0 && progress >= duration * 0.95;
      progressMap[String(r.episode_number)] = {
        progressSec: progress,
        durationSec: duration,
        watched: watched,
      };
    });

    res.json(progressMap);
  } catch (err) {
    console.error('[WatchController] getBatchProgress error:', err.message);
    res.status(500).json({ message: 'Failed to fetch batch progress.' });
  }
};

/**
 * GET /api/watch/continue-watching
 * Returns up to 10 in-progress episodes for the authenticated user.
 *
 * Excludes:
 *  - Episodes < 10 seconds watched (accidental clicks)
 *  - Episodes >= 95% complete (practically finished)
 *
 * Ordered by most recently updated first.
 * Returns anime metadata (title, cover_image) for frontend display.
 */
exports.getContinueWatching = async (req, res) => {
  try {
    const userId = req.user.id;

    const [rows] = await db.query(
      `SELECT
         wh.anime_id,
         wh.episode_number,
         wh.progress_seconds,
         wh.total_duration_seconds,
         wh.updated_at,
         a.title       AS anime_title,
         a.cover_image AS anime_cover_image
       FROM watch_history wh
       LEFT JOIN anime a ON a.id = CAST(wh.anime_id AS UNSIGNED)
       WHERE wh.user_id = ?
         AND wh.progress_seconds > 10
         AND wh.total_duration_seconds > 0
         AND wh.progress_seconds < (wh.total_duration_seconds * 0.95)
       ORDER BY wh.updated_at DESC
       LIMIT 10`,
      [userId]
    );

    // Map to camelCase keys for the frontend
    const mapped = rows.map(row => ({
      animeId: row.anime_id,
      episodeNumber: row.episode_number,
      progressSeconds: row.progress_seconds,
      totalDurationSeconds: row.total_duration_seconds,
      updatedAt: row.updated_at,
      animeTitle: row.anime_title,
      animeCoverImage: row.anime_cover_image,
    }));

    res.json(mapped);
  } catch (err) {
    console.error('[WatchController] getContinueWatching error:', err.message);
    res.status(500).json({ message: 'Failed to fetch continue watching list.' });
  }
};

/**
 * GET /api/watch/next/:animeId/:currentEpisodeNumber
 * Resolves the next episode for an anime to enable auto-play / binge-watching.
 *
 * AnimeHeaven-first (Phase 5): autoplay must use the SAME provider as the
 * current playback. The next episode is resolved from the local DB (which was
 * populated by the AnimeHeaven import) and streamed through the standard
 * streaming engine — NO Consumet dependency.
 *
 * Steps:
 *   1. Look up the anime title + next episode from the local DB.
 *   2. Resolve the stream via streamingService.resolveStream (AnimeHeaven-first).
 *   3. Return combined { success, hasNextEpisode, episode, sources, providerUsed }.
 */
exports.resolveNextEpisode = async (req, res) => {
  try {
    const { animeId, currentEpisodeNumber } = req.params;

    if (!animeId || currentEpisodeNumber === undefined || currentEpisodeNumber === null) {
      return res.status(400).json({
        success: false,
        message: 'animeId and currentEpisodeNumber are required.',
      });
    }

    const targetEpisodeNumber = parseInt(currentEpisodeNumber, 10) + 1;

    // 1. Look up the anime title from the local DB.
    const [animeRows] = await db.query(
      'SELECT id, title FROM anime WHERE id = ? LIMIT 1',
      [animeId]
    );
    if (!animeRows.length) {
      return res.json({
        success: true,
        hasNextEpisode: false,
        message: 'Anime not found in catalogue.',
      });
    }
    const animeTitle = animeRows[0].title;

    // 2. Look up the next episode from the local DB.
    const [epRows] = await db.query(
      'SELECT id, episode_number, title, animeheaven_episode_key FROM episodes WHERE anime_id = ? AND episode_number = ? LIMIT 1',
      [animeId, targetEpisodeNumber]
    );

    if (!epRows.length) {
      return res.json({
        success: true,
        hasNextEpisode: false,
        message: `Episode ${targetEpisodeNumber} not found. This may be the final released episode.`,
      });
    }

    const nextEpisode = epRows[0];

    // 3. Resolve the stream through the standard streaming engine
    //    (AnimeHeaven-first with fallback). This uses the persisted
    //    animeheaven_slug + animeheaven_episode_key — NO search.
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

    // Gracefully handle upstream provider failures (502/404 etc.)
    if (err.response) {
      const status = err.response.status;
      if (status === 502 || status === 404) {
        return res.status(status).json({
          success: false,
          hasNextEpisode: false,
          message: `Upstream provider returned ${status}. Unable to resolve next episode.`,
        });
      }
    }

    return res.status(502).json({
      success: false,
      hasNextEpisode: false,
      message: `Failed to resolve next episode: ${err.message}`,
    });
  }
};

/**
 * GET /api/watch/skip-times/:malId/:episodeNumber
 * Fetches OP (opening) and ED (ending) skip timestamps from the AniSkip API.
 *
 * Used by the frontend "Skip Intro" / "Skip Outro" buttons during video playback.
 *
 * Response shape:
 *   { found: true,  op: { start, end }, ed: { start, end } }   — timestamps exist
 *   { found: false }                                             — no skip data
 */
exports.getEpisodeSkipTimes = async (req, res) => {
  try {
    const { malId, episodeNumber } = req.params;

    if (!malId || !episodeNumber) {
      return res.status(400).json({
        success: false,
        message: 'malId and episodeNumber are required.',
      });
    }

    // Make AniSkip non-fatal. If it fails, log a warning and return empty.
    try {
      const result = await fetchSkipTimes(malId, episodeNumber);
      return res.json(result);
    } catch (skipErr) {
      console.warn(`[WatchController] AniSkip fetch failed (non-fatal): ${skipErr.message}`);
      return res.json({ found: false });
    }
  } catch (err) {
    console.error('[WatchController] getEpisodeSkipTimes error (wrapper):', err.message);

    return res.status(502).json({
      success: false,
      message: `Failed to fetch skip timestamps: ${err.message}`,
    });
  }
};

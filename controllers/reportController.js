// controllers/reportController.js
// Broken Stream Reporting — users can report issues with video streams,
// and administrators can review, resolve, or dismiss them.
const db = require('../config/db');
const logger = require('../utils/logger');
const { sendSuccess } = require('../utils/response');
const streamCacheService = require('../services/streamCacheService');
const streamCacheMetrics = require('../services/streamCacheMetrics');
const cache = require('../utils/cacheService');

// Rate limit: max 3 failure reports per user per 5 minutes.
// Prevents a malicious client from spamming cache invalidation.
const FAILURE_REPORT_WINDOW_MS = 5 * 60 * 1000;
const FAILURE_REPORT_MAX = 3;
const failureReportCounts = new Map(); // userId => { count, resetAt }

/**
 * POST /api/reports/stream
 * Body: { animeId, episodeNumber, issueType }
 * Creates a new stream report from the authenticated user.
 */
exports.submitReport = async (req, res) => {
  try {
    const userId = req.user.id;
    const { animeId, episodeNumber, issueType } = req.body;

    if (!animeId || episodeNumber === undefined || episodeNumber === null) {
      return res.status(400).json({ message: 'animeId and episodeNumber are required.' });
    }

    const validIssueTypes = ['BROKEN_VIDEO', 'AUDIO_ISSUE', 'SUBTITLE_ISSUE', 'WRONG_EPISODE', 'OTHER'];
    const resolvedIssue = validIssueTypes.includes(issueType) ? issueType : 'BROKEN_VIDEO';

    await db.query(
      `INSERT INTO stream_reports (user_id, anime_id, episode_number, issue_type)
       VALUES (?, ?, ?, ?)`,
      [userId, animeId, episodeNumber, resolvedIssue]
    );

    return sendSuccess(res, null, { message: 'Report submitted successfully. Thank you for your feedback!' }, 201);
  } catch (err) {
    console.error('[ReportController] submitReport error:', err.message);
    res.status(500).json({ message: 'Failed to submit report.' });
  }
};

/**
 * POST /api/reports/playback-failure
 * Body: { episodeId, reason }
 * Reports a playback failure for an authorized stream.
 *
 * Cache invalidation is EVIDENCE-BASED: the persistent source is only marked
 * invalid when a probe of the actual cached source returns an explicit
 * authoritative 403/404. Auth/entitlement, transient browser/network,
 * device-limit, and decode failures are recorded for diagnostics but do NOT
 * poison a healthy cached source.
 *
 * Security:
 *   - Requires authentication (protect middleware).
 *   - episodeId must be a positive integer (validated).
 *   - Rate-limited per user (3 per 5 min) to prevent abuse.
 *   - Client cannot specify arbitrary provider URLs — the backend
 *     identifies the cached source by trusted episodeId.
 */
exports.reportPlaybackFailure = async (req, res) => {
  try {
    const userId = req.user.id;
    const { episodeId, reason } = req.body;

    // Validate episodeId.
    const epId = Number(episodeId);
    if (!Number.isInteger(epId) || epId <= 0) {
      return res.status(400).json({ message: 'Valid episodeId (positive integer) is required.' });
    }

    // Rate limit: max 3 failure reports per user per 5 minutes.
    const now = Date.now();
    const userRecord = failureReportCounts.get(userId);
    if (userRecord && now < userRecord.resetAt) {
      userRecord.count += 1;
      if (userRecord.count > FAILURE_REPORT_MAX) {
        return res.status(429).json({
          message: 'Too many failure reports. Please try again later.',
          retryAfter: Math.ceil((userRecord.resetAt - now) / 1000),
        });
      }
    } else {
      failureReportCounts.set(userId, { count: 1, resetAt: now + FAILURE_REPORT_WINDOW_MS });
    }

    // ── EVIDENCE-BASED CACHE INVALIDATION ───────────────────
    // A user-facing playback failure report is NOT proof that the upstream
    // stream source is dead. Auth/entitlement, transient browser/network,
    // device-limit, and decode failures can all be reported while the cached
    // AnimeHeaven source is perfectly healthy. The persistent source is only
    // invalidated when a probe of the ACTUAL cached source returns an explicit
    // authoritative 403/404 (the existing source-liveness mechanism). The
    // failure report itself is always recorded for diagnostics.
    const provider = process.env.STREAM_CACHE_PROVIDER || 'animeheaven';
    streamCacheMetrics.increment('playbackReportedFailures');

    let shouldInvalidate = false;
    try {
      const lookup = await streamCacheService.findCachedStream(epId, provider);
      let data = (lookup && lookup.row && lookup.row.stream_data) || null;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_) { data = null; }
      }
      const source = data && Array.isArray(data.sources)
        ? data.sources.find(s => s && s.url) || null
        : null;
      if (source) {
        const alive = await streamCacheService.isCachedSourceAlive(source.url, {
          referer: source.referer || null,
          origin: source.origin || null,
          cookies: source.cookies || null,
        });
        shouldInvalidate = !alive;
      }
    } catch (probeErr) {
      // Probe failure (DB read error, etc.) must NEVER poison the cache.
      logger.warn('[ReportController] Source-liveness probe failed (no invalidation)', {
        episodeId: epId, error: probeErr.message,
      });
      shouldInvalidate = false;
    }

    if (shouldInvalidate) {
      // Explicit authoritative 403/404 → the cached source is dead; invalidate
      // BOTH Redis and MySQL so the next play triggers a fresh resolution.
      const redisKey = streamCacheService.buildRedisKey(epId, provider);
      try {
        await cache.delByPrefix(redisKey);
      } catch (redisErr) {
        logger.warn('[ReportController] Redis invalidation failed (non-fatal)', {
          episodeId: epId, error: redisErr.message,
        });
      }
      try {
        await db.query(
          `UPDATE episode_stream_cache
           SET verification_status = 'invalid',
               failure_count = failure_count + 1,
               last_failed_at = NOW()
           WHERE episode_id = ? AND provider = ?`,
          [epId, provider]
        );
      } catch (dbErr) {
        logger.warn('[ReportController] MySQL invalidation failed (non-fatal)', {
          episodeId: epId, error: dbErr.message,
        });
      }
      logger.info('[ReportController] Playback failure confirmed dead → cache invalidated', {
        userId, episodeId: epId, reason: reason || 'unspecified',
      });
    } else {
      // Diagnostics only — no evidence the cached source is dead, so the
      // persistent row remains reusable. Redis is left untouched to stay in
      // sync with the (unchanged) MySQL decision.
      try {
        await db.query(
          `UPDATE episode_stream_cache
           SET failure_count = failure_count + 1,
               last_failed_at = NOW()
           WHERE episode_id = ? AND provider = ?`,
          [epId, provider]
        );
      } catch (dbErr) {
        logger.warn('[ReportController] MySQL diagnostic update failed (non-fatal)', {
          episodeId: epId, error: dbErr.message,
        });
      }
      logger.info('[ReportController] Playback failure reported (no invalidation — no dead-source evidence)', {
        userId, episodeId: epId, reason: reason || 'unspecified',
      });
    }

    const responseMessage = shouldInvalidate
      ? 'Playback failure reported. The cached source was confirmed dead and will be re-resolved on next play.'
      : 'Playback failure reported for diagnostics. The cached source remains reusable until verified otherwise.';

    return sendSuccess(res, null, { message: responseMessage });
  } catch (err) {
    console.error('[ReportController] reportPlaybackFailure error:', err.message);
    res.status(500).json({ message: 'Failed to report playback failure.' });
  }
};

/**
 * POST /api/reports/client-event
 * Body: { event, payload }
 * Generic endpoint for logging client-side events for performance monitoring.
 */
exports.logClientEvent = async (req, res) => {
  const { event, ...payload } = req.body;
  if (!event) {
    return res.status(400).json({ message: 'Event name is required.' });
  }

  // Use the structured logger for consistency.
  logger.info(`[PLAYBACK]`, { event, from: 'client', ...payload });

  return sendSuccess(res, null, { message: 'Event logged.' }, 202);
};

/**
 * GET /api/reports/stream
 * Fetches all pending reports, ordered by oldest first.
 * Includes the reporter's email via a JOIN with the users table.
 * Admin only.
 */
exports.getPendingReports = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT sr.id,
              sr.anime_id,
              sr.episode_number,
              sr.issue_type,
              sr.status,
              sr.created_at,
              sr.updated_at,
              u.email AS reporter_email
       FROM stream_reports sr
       JOIN users u ON u.id = sr.user_id
       WHERE sr.status = 'PENDING'
       ORDER BY sr.created_at ASC`
    );

    return sendSuccess(res, rows);
  } catch (err) {
    console.error('[ReportController] getPendingReports error:', err.message);
    res.status(500).json({ message: 'Failed to fetch reports.' });
  }
};

/**
 * PUT /api/reports/stream/:id/status
 * Body: { status }
 * Updates a report's status to RESOLVED or DISMISSED.
 * Admin only.
 */
exports.updateReportStatus = async (req, res) => {
  try {
    const reportId = req.params.id;
    const { status } = req.body;

    if (!status || !['RESOLVED', 'DISMISSED'].includes(status)) {
      return res.status(400).json({ message: 'Status must be either RESOLVED or DISMISSED.' });
    }

    const [result] = await db.query(
      `UPDATE stream_reports SET status = ? WHERE id = ?`,
      [status, reportId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Report not found.' });
    }

    return sendSuccess(res, null, { message: `Report ${status.toLowerCase()} successfully.` });
  } catch (err) {
    console.error('[ReportController] updateReportStatus error:', err.message);
    res.status(500).json({ message: 'Failed to update report status.' });
  }
};
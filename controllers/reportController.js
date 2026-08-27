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
 * Invalidates the cached source so the next play triggers a fresh resolution.
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

    // Invalidate Redis cache for the default provider.
    const provider = process.env.STREAM_CACHE_PROVIDER || 'animeheaven';
    const redisKey = streamCacheService.buildRedisKey(epId, provider);
    streamCacheMetrics.increment('playbackReportedFailures');
    try {
      await cache.delByPrefix(redisKey);
    } catch (redisErr) {
      logger.warn('[ReportController] Redis invalidation failed (non-fatal)', {
        episodeId: epId, error: redisErr.message,
      });
    }

    // Invalidate MySQL cache: mark as invalid, increment failure count.
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

    logger.info('[ReportController] Playback failure reported', {
      userId, episodeId: epId, reason: reason || 'unspecified',
    });

    return sendSuccess(res, null, {
      message: 'Playback failure reported. A fresh source will be resolved on next play.',
    });
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
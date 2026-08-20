// controllers/reportController.js
// Broken Stream Reporting — users can report issues with video streams,
// and administrators can review, resolve, or dismiss them.
const db = require('../config/db');
const logger = require('../utils/logger');
const { sendSuccess } = require('../utils/response');

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
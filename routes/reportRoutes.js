// routes/reportRoutes.js
// Routes for broken stream reporting — users submit reports,
// admins review and manage them.
const express   = require('express');
const router    = express.Router();
const report    = require('../controllers/reportController');
const { protect, adminOnly } = require('../middleware/auth');
const { eventLimiter } = require('../middleware/rateLimit');

// ─── User-facing: submit a report ──────────────────────────
// POST /api/reports/stream
router.post('/stream', protect, report.submitReport);

// ─── User-facing: report playback failure ──────────────────
// POST /api/reports/playback-failure
// Protected by auth + rate-limited internally (3 per 5 min per user).
router.post('/playback-failure', protect, report.reportPlaybackFailure);

// ─── User-facing: client-side event logging ──────────────
// POST /api/reports/client-event
// Protected by auth + rate-limited to prevent log flooding abuse
router.post('/client-event', protect, eventLimiter, report.logClientEvent);

// ─── Admin-only: view pending reports & update status ──────
// GET  /api/reports/stream
router.get('/stream', protect, adminOnly, report.getPendingReports);

// PUT  /api/reports/stream/:id/status
router.put('/stream/:id/status', protect, adminOnly, report.updateReportStatus);

module.exports = router;

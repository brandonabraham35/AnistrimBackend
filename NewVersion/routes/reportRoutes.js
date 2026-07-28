// routes/reportRoutes.js
// Routes for broken stream reporting — users submit reports,
// admins review and manage them.
const express   = require('express');
const router    = express.Router();
const report    = require('../controllers/reportController');
const { protect, adminOnly } = require('../middleware/auth');

// ─── User-facing: submit a report ──────────────────────────
// POST /api/reports/stream
router.post('/stream', protect, report.submitReport);

// ─── Admin-only: view pending reports & update status ──────
// GET  /api/reports/stream
router.get('/stream', protect, adminOnly, report.getPendingReports);

// PUT  /api/reports/stream/:id/status
router.put('/stream/:id/status', protect, adminOnly, report.updateReportStatus);

module.exports = router;


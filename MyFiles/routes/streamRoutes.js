// ============================================================
//  routes/streamRoutes.js — AnimeHeaven Stream Routes
//  Mounted at /api/stream
// ============================================================
const express = require('express');
const router = express.Router();
const streamController = require('../controllers/streamController');
const streamProxyQueryController = require('../controllers/streamProxyQueryController');
const { protect } = require('../middleware/auth');

// ── Stateless Query-Based Playback Proxy (AnimeHeaven only) ─
// GET /api/stream/proxy?provider=animeheaven&url=<encoded>&referer=<encoded>
// MUST be registered BEFORE the /:animeTitle/:episodeNumber catch-all so the
// literal "proxy" path is not mistaken for an anime title.
router.options('/proxy', streamProxyQueryController.preflight);
router.get('/proxy', streamProxyQueryController.streamMedia);

// ── Public: Best stream (AnimeHeaven single provider) ──────
// GET /api/stream/:animeTitle/:episodeNumber
// Optional query param: preferredProvider=animeheaven
//   (accepted for backward compatibility but IGNORED — AnimeHeaven is the
//    only streaming provider. The response contract is unchanged.)
// Optional auth (if token provided, will unlock premium quality)
router.get('/:animeTitle/:episodeNumber', (req, res, next) => {
  // Optional auth — if token present, attach user for tier enforcement
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const jwt = require('jsonwebtoken');
      req.user = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    } catch (_) {}
  }
  next();
}, streamController.getStream);

// ── Public: List all providers for "Switch Server" dropdown ─
// GET /api/stream/providers/:animeTitle/:episodeNumber
router.get('/providers/:animeTitle/:episodeNumber', (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const jwt = require('jsonwebtoken');
      req.user = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    } catch (_) {}
  }
  next();
}, streamController.listProviders);

// ── Premium-only: Authorize offline download ───────────────
// POST /api/stream/offline-download
router.post('/offline-download', protect, streamController.authorizeDownload);

module.exports = router;

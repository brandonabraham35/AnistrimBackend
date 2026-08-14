// ============================================================
//  routes/streamRoutes.js — AnimeHeaven Stream Routes
//  Mounted at /api/stream
// ============================================================
const express = require('express');
const router = express.Router();
const streamController = require('../controllers/streamController');
const streamProxyQueryController = require('../controllers/streamProxyQueryController');
const { protect } = require('../middleware/auth');
const { verifyTokenAndStatus } = require('../middleware/authMiddleware');

// ── Stateless Query-Based Playback Proxy (AnimeHeaven only) ─
// GET /api/stream/proxy?provider=animeheaven&url=<encoded>&referer=<encoded>
// MUST be registered BEFORE the /:animeTitle/:episodeNumber catch-all so the
// literal "proxy" path is not mistaken for an anime title.
router.options('/proxy', streamProxyQueryController.preflight);
router.get('/proxy', streamProxyQueryController.streamMedia);

// ── Phase 10 (item 21): stream authorization ────────────────
// POST /api/stream/authorize { episodeId } → canWatch() → 120 s HMAC token.
// MUST be registered before the /:animeTitle/:episodeNumber catch-all.
router.post('/authorize', protect, streamController.authorizeStream);

// ── Protected: Best stream (AnimeHeaven single provider) ───
// GET /api/stream/:animeTitle/:episodeNumber
// Optional query param: preferredProvider=animeheaven
//   (accepted for backward compatibility but IGNORED — AnimeHeaven is the
//    only streaming provider. The response contract is unchanged.)
// The verifyTokenAndStatus middleware enforces strict email verification:
//   • no/invalid token  → 401
//   • verified token    → next() (unlocks premium quality)
//   • unverified token  → 403 { requiresVerification: true }
router.get('/:animeTitle/:episodeNumber', verifyTokenAndStatus, streamController.getStream);

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

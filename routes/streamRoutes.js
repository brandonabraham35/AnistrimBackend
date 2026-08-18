// ============================================================
//  routes/streamRoutes.js — AnimeHeaven Stream Routes
//  Mounted at /api/stream
// ============================================================
const express = require('express');
const router = express.Router();
const streamController = require('../controllers/streamController');
const { protect } = require('../middleware/auth');

// ── FIX 4 (P0): /api/stream/proxy QUERY ROUTE DELETED ────────
// The stateless query proxy was the security bypass: it accepted an arbitrary
// url= within the allow-list and only verified { ip } — never userId /
// episodeId / streamId, so a token minted for episode A (or user X) could
// fetch episode B (or be used by user Y from the same IP).
//
// The hardened, token-gated /api/stream-proxy/:streamId path is now the ONLY
// proxy. It verifies { userId, episodeId, streamId, ip } AND checks the store
// context's userId/episodeId match the token (FIX 3). The player (watch.js)
// was migrated to it in FIX 3, so this legacy route is no longer needed.
//
// If a phased removal was preferred, this route could have first gained a
// per-user rate limiter + per-request logging to confirm zero traffic; given
// the migration is complete, it is removed outright. The module
// controllers/streamProxyQueryController.js remains on disk but is now
// unreachable (only this file referenced it).

// ── Phase 10 (item 21): stream authorization ────────────────
// POST /api/stream/authorize { episodeId } → canWatch() → 120 s HMAC token.
// MUST be registered before the /:animeTitle/:episodeNumber catch-all.
router.post('/authorize', protect, streamController.authorizeStream);

// ── Protected: Best stream (AnimeHeaven single provider) ───
// GET /api/stream/:animeTitle/:episodeNumber
// Optional query param: preferredProvider=animeheaven
//   (accepted for backward compatibility but IGNORED — AnimeHeaven is the
//    only streaming provider. The response contract is unchanged.)
// Uses the canonical protect middleware (DB reload + status + tv + session).
router.get('/:animeTitle/:episodeNumber', protect, streamController.getStream);

// ── Public: List all providers for "Switch Server" dropdown ─
// GET /api/stream/providers/:animeTitle/:episodeNumber
router.get('/providers/:animeTitle/:episodeNumber', (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const jwt = require('jsonwebtoken');
      req.user = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch (_) {}
  }
  next();
}, streamController.listProviders);

// ── Premium-only: Authorize offline download ───────────────
// POST /api/stream/offline-download
router.post('/offline-download', protect, streamController.authorizeDownload);

module.exports = router;

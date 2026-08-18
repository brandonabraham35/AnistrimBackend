// =============================================================
//  routes/streamProxyRoutes.js — Secure AnimeHeaven Playback Proxy
//
//  Mounts the stream proxy under /api/stream-proxy. The browser only
//  ever sees anonymized /api/stream-proxy/:streamId URLs; cookies,
//  referers, origins and target URLs stay server-side in the
//  streamProxyStore.
// =============================================================
'use strict';

const express = require('express');
const router = express.Router();
const proxyController = require('../controllers/streamProxyController');
const { proxyLimiter } = require('../middleware/rateLimit');

// Preflight for cross-origin media playback (HLS / MP4).
router.options('/:streamId', proxyController.preflight);

// Stream the registered (or HLS child) resource behind the proxy.
// FIX 7: coarse per-IP limiter. The keyGenerator routes HLS child/segment
// (?url=) requests to a separate `proxy-hls:` bucket (high ceiling), so the
// strict bucket only throttles parent-manifest requests and stops abusive
// clients without breaking HLS segment bursts.
router.get('/:streamId', proxyLimiter, proxyController.streamMedia);

module.exports = router;

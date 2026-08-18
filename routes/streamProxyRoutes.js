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
// The extra /:suffix segment is the cosmetic `/index.m3u8` hint appended to
// HLS proxy URLs so players can detect HLS from the URL (see
// utils/streamProxy.js proxyUrlSuffix). It is ignored by the controller.
// NOTE: registered as two explicit routes — Express 5 (path-to-regexp v8)
// no longer supports the `:param?` optional-segment syntax.
router.options('/:streamId', proxyController.preflight);
router.options('/:streamId/:suffix', proxyController.preflight);

// Stream the registered (or HLS child) resource behind the proxy.
// FIX 7: coarse per-IP limiter. The keyGenerator routes HLS child/segment
// (?url=) requests to a separate `proxy-hls:` bucket (high ceiling), so the
// strict bucket only throttles parent-manifest requests and stops abusive
// clients without breaking HLS segment bursts.
router.get('/:streamId', proxyLimiter, proxyController.streamMedia);
router.get('/:streamId/:suffix', proxyLimiter, proxyController.streamMedia);

module.exports = router;

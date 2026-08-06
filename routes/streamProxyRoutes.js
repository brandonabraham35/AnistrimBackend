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

// Preflight for cross-origin media playback (HLS / MP4).
router.options('/:streamId', proxyController.preflight);

// Stream the registered (or HLS child) resource behind the proxy.
router.get('/:streamId', proxyController.streamMedia);

module.exports = router;

// ============================================================
//  routes/v1/index.js - Centralized API v1 version router.
//
//  The v1 surface REUSES the exact same router/controller objects
//  that the legacy /api/* surface uses. No business logic is
//  duplicated. Mounted in server.js as:
//      app.use('/api/v1', require('./routes/v1'));
//
//  STREAMING COMPATIBILITY
//  -----------------------
//  /api/v1/stream/*       -> same streamRoutes handlers as /api/stream/*
//  /api/v1/stream-proxy/* -> same streamProxyRoutes handlers as
//                            /api/stream-proxy/*
//  The secure token-gated proxy, HLS rewriting and SSRF guards are
//  untouched - the same controller functions are invoked.
// ============================================================
'use strict';

const express = require('express');
const v1 = express.Router();

// Public + auth (mirrors legacy /api/auth mounting).
v1.use('/auth', require('../authRoutes'));
v1.use('/auth', require('../avatarRoutes'));

// User-facing resources.
v1.use('/profile', require('../profileRoutes'));
v1.use('/anime', require('../animeRoutes'));
v1.use('/watchlist', require('../watchlistRoutes'));
v1.use('/payments', require('../paymentRoutes'));
v1.use('/watch', require('../watchRoutes'));
v1.use('/download', require('../downloadRoutes'));

// Streaming (secure, unchanged handlers).
v1.use('/stream', require('../streamRoutes'));
v1.use('/stream-proxy', require('../streamProxyRoutes'));

// Admin + CMS (mirrors legacy /api/admin and /api/admin/upload).
v1.use('/admin', require('../adminRoutes'));
v1.use('/admin/upload', require('../uploadRoutes'));

// Discovery + content shelves.
v1.use('/ads', require('../adsRoutes'));
v1.use('/reports', require('../reportRoutes'));
v1.use('/home', require('../homeShelfRoutes'));

// Lightweight stable probe so clients can confirm the v1 contract.
v1.get('/version', (req, res) => {
  res.status(200).json({
    api: 'anistrim',
    version: 'v1',
    status: 'stable',
    deprecation: {
      legacy: '/api/*',
      notice:
        'Legacy /api/* remains fully supported during migration; see reports/api-versioning.md',
    },
  });
});

module.exports = v1;
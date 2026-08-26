// routes/seoRoutes.js — crawlable path-based SEO surface.
//
// Mounted in server.js BEFORE all static/SPA-fallback handlers so these paths
// are served by this backend rather than being swallowed by a catch-all:
//
//   GET /sitemap.xml    → dynamic XML sitemap from the published catalogue
//   GET /robots.txt     → crawler rules + sitemap reference
//   GET /anime/:id      → per-anime crawlable page (canonical / OG / JSON-LD)
//   GET /browse         → crawlable catalogue hub with internal anime links
//
// The production edge (Vercel) rewrites these exact paths to the backend so
// https://anistrim.com/sitemap.xml etc. resolve to the handlers below.
const express = require('express');
const seo = require('../controllers/seoController');

const router = express.Router();

router.get('/sitemap.xml', seo.getSitemap);
router.get('/robots.txt', seo.getRobots);
router.get('/browse', seo.getBrowseSeo);
router.get('/search', seo.getSearchSeo);
router.get('/anime/:id', seo.getAnimeSeo);

module.exports = router;

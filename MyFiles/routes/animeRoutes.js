// routes/animeRoutes.js
const express = require('express');
const router  = express.Router();
const anime   = require('../controllers/animeController');
const { protect } = require('../middleware/auth');

// Public (but protect adds user context if token present — optional auth)
router.get('/trending', anime.getTrending);
router.get('/featured', anime.getFeatured);
router.get('/search',   anime.search);

// Optional auth — episodes show video_url only for premium users
router.get('/:id', (req, res, next) => {
  const auth = req.headers.authorization;
  if (auth) {
    const jwt = require('jsonwebtoken');
    try { req.user = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET); } catch(_) {}
  }
  next();
}, anime.getById);

module.exports = router;

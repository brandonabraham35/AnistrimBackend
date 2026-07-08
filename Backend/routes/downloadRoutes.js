// routes/downloadRoutes.js — Server-side video download proxy
const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const db      = require('../config/db');
const { protect } = require('../middleware/auth');

// Support ?token= query param as fallback to Authorization header (for <a href> downloads)
function authMiddleware(req, res, next) {
  if (req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  protect(req, res, next);
}

// GET /api/download/:episodeId
router.get('/:episodeId', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT e.video_url, e.title, e.is_premium, a.title AS anime_title
       FROM episodes e JOIN anime a ON e.anime_id = a.id
       WHERE e.id = ?`,
      [req.params.episodeId]
    );
    if (!rows.length) return res.status(404).json({ message: 'Episode not found.' });
    const ep = rows[0];

    const [users] = await db.query('SELECT is_premium, is_admin FROM users WHERE id = ?', [req.user.id]);
    const user = users[0];
    if (!user?.is_premium && !user?.is_admin) {
      return res.status(403).json({ message: 'Premium subscription required for downloads.' });
    }

    if (!ep.video_url) return res.status(404).json({ message: 'No video available for this episode.' });

    // NOTE: Only works for direct .mp4 URLs — HLS (.m3u8) not supported
    if (ep.video_url.includes('.m3u8')) {
      return res.status(400).json({ message: 'Streaming videos cannot be downloaded directly. Please contact support.' });
    }

    const fileName = `${ep.anime_title}_${ep.title || 'episode'}.mp4`.replace(/[^a-z0-9._\- ]/gi, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'video/mp4');

    const upstream = await axios({ url: ep.video_url, method: 'GET', responseType: 'stream' });
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }
    upstream.data.pipe(res);

  } catch(e) {
    console.error('Download error:', e.message);
    if (!res.headersSent) res.status(500).json({ message: 'Download failed.' });
  }
});

module.exports = router;

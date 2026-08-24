// routes/downloadRoutes.js — Server-side video download proxy
const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const db      = require('../config/db');
const { protect } = require('../middleware/auth');
const { getEntitlement, GRANTING_STATES } = require('../utils/episodeAccess');
const { assertSafeTargetHost } = require('../utils/ssrfGuard');

// NOTE: Token in query string is NOT accepted for security reasons.
// Tokens in URLs are exposed to server logs, browser history, and referrer headers.
// Only Authorization header is supported.

// GET /api/download/:episodeId
router.get('/:episodeId', protect, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT e.video_url, e.title, a.title AS anime_title
       FROM episodes e JOIN anime a ON e.anime_id = a.id
       WHERE e.id = ?`,
      [req.params.episodeId]
    );
    if (!rows.length) return res.status(404).json({ message: 'Episode not found.' });
    const ep = rows[0];

    // Use the canonical entitlement system — the same one used by streaming.
    // Never trust users.is_premium, users.is_admin, or client-supplied values.
    const ent = await getEntitlement(req.userId ?? req.user?.id);
    const isAdmin = !!req.user?.isAdmin;
    const isEntitled = (ent && ent.isPremium && GRANTING_STATES.has(ent.state)) || isAdmin;

    if (!isEntitled) {
      return res.status(403).json({ message: 'Premium subscription required for downloads.' });
    }

    if (!ep.video_url) return res.status(404).json({ message: 'No video available for this episode.' });

    // NOTE: Only works for direct .mp4 URLs — HLS (.m3u8) not supported
    if (ep.video_url.includes('.m3u8')) {
      return res.status(400).json({ message: 'Streaming videos cannot be downloaded directly. Please contact support.' });
    }

    // SSRF protection — validate the upstream URL before fetching.
    const ssrfError = await assertSafeTargetHost(ep.video_url);
    if (ssrfError) {
      console.error('[Download] SSRF guard rejected URL:', ssrfError);
      return res.status(502).json({ message: 'Download source rejected by security policy.' });
    }

    const fileName = `${ep.anime_title}_${ep.title || 'episode'}.mp4`.replace(/[^a-z0-9._\- ]/gi, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'video/mp4');

    const upstream = await axios({ url: ep.video_url, method: 'GET', responseType: 'stream', maxRedirects: 0 });
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }
    upstream.data.pipe(res);

  } catch(e) {
    if (e.response?.status && e.response?.status >= 300 && e.response?.status < 400) {
      console.error('[Download] Redirect blocked by security policy:', e.message);
      if (!res.headersSent) res.status(502).json({ message: 'Download source redirect rejected.' });
      return;
    }
    console.error('Download error:', e.message);
    if (!res.headersSent) res.status(500).json({ message: 'Download failed.' });
  }
});

module.exports = router;

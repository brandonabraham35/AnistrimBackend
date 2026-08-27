// controllers/analyticsController.js — centralized analytics event ingestion
// and admin analytics aggregation for unified cross-platform analytics.
//
// Events flow:
//   Client (Web/Mobile/Desktop) → POST /api/analytics/events → analytics_events table
//   Admin Dashboard → GET /api/admin/analytics/* → aggregated queries
//
// All analytics share the same user_id across platforms. The X-Client header
// (via req.clientPlatform) determines platform attribution.
const db = require('../config/db');
const { sendSuccess, sendPaginated } = require('../utils/response');
const streamCacheMetrics = require('../services/streamCacheMetrics');

// ── Event type allowlist ────────────────────────────────────
const ALLOWED_EVENTS = new Set([
  'signup', 'login', 'google_login', 'logout',
  'anime_view', 'episode_view', 'watch_start', 'watch_progress', 'watch_complete',
  'search', 'favorite_add', 'favorite_remove',
  'download_start', 'download_complete',
  'stream_start', 'stream_error',
  'premium_purchase', 'payment_success', 'payment_failed',
]);

// ── POST /api/analytics/events ──────────────────────────────
// Body: [{ event_type, anime_id?, episode_id?, metadata?, event_id? }, ...]
// Authenticated (optional for anonymous events like search before login).
exports.recordEvents = async (req, res) => {
  try {
    const userId = req.userId ?? req.user?.id ?? null;
    const platform = req.clientPlatform || 'unknown';
    const sessionId = req.tokenClaims?.sid || null;
    const events = Array.isArray(req.body) ? req.body : (req.body.events || [req.body]);

    const valid = [];
    for (const ev of events) {
      if (!ev || !ev.event_type) continue;
      const type = String(ev.event_type).trim();
      if (!ALLOWED_EVENTS.has(type)) continue;

      valid.push([
        userId,
        type,
        platform,
        sessionId,
        ev.anime_id ? Number(ev.anime_id) : null,
        ev.episode_id ? Number(ev.episode_id) : null,
        ev.metadata && typeof ev.metadata === 'object' ? JSON.stringify(ev.metadata) : null,
      ]);
    }

    if (!valid.length) {
      return sendSuccess(res, { recorded: 0 }, { message: 'No valid events provided.' });
    }

    await db.query(
      `INSERT INTO analytics_events
         (user_id, event_type, client_platform, session_id, anime_id, episode_id, metadata)
       VALUES ?`,
      [valid]
    );

    return sendSuccess(res, { recorded: valid.length });
  } catch (err) {
    console.error('[Analytics] recordEvents error:', err.message);
    return res.status(500).json({ message: 'Failed to record analytics events.' });
  }
};

// ── GET /api/admin/analytics/overview ───────────────────────
exports.getOverview = async (req, res) => {
  try {
    const platform = req.query.platform || 'all';
    const days = Math.min(parseInt(req.query.days) || 30, 365);

    // Platform filter via parameterized query (no alias — table not aliased).
    const ALLOWED_PLATFORMS = new Set(['web', 'mobile', 'desktop']);
    const platformFilter = ALLOWED_PLATFORMS.has(platform) ? platform : null;
    const platformWhere = platformFilter ? 'AND client_platform = ?' : '';
    const platformParam = platformFilter ? [platformFilter] : [];

    const [users] = await db.query('SELECT COUNT(*) AS total FROM users');

    let activeToday = [{ total: 0 }], activeWeek = [{ total: 0 }], activeMonth = [{ total: 0 }];
    let animeViews = [{ total: 0 }], episodeViews = [{ total: 0 }];
    let searches = [{ total: 0 }], logins = [{ total: 0 }];
    let platformBreakdown = [];

    try {
      [activeToday] = await db.query(
        `SELECT COUNT(DISTINCT user_id) AS total FROM analytics_events
         WHERE event_type IN ('login','anime_view','episode_view','watch_start')
           AND DATE(created_at) = CURDATE() ${platformWhere}`,
        platformParam
      );
      [activeWeek] = await db.query(
        `SELECT COUNT(DISTINCT user_id) AS total FROM analytics_events
         WHERE event_type IN ('login','anime_view','episode_view','watch_start')
           AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) ${platformWhere}`,
        platformParam
      );
      [activeMonth] = await db.query(
        `SELECT COUNT(DISTINCT user_id) AS total FROM analytics_events
         WHERE event_type IN ('login','anime_view','episode_view','watch_start')
           AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) ${platformWhere}`,
        platformParam
      );
      [animeViews] = await db.query(
        `SELECT COUNT(*) AS total FROM analytics_events
         WHERE event_type = 'anime_view'
           AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${platformWhere}`,
        [days, ...platformParam]
      );
      [episodeViews] = await db.query(
        `SELECT COUNT(*) AS total FROM analytics_events
         WHERE event_type IN ('episode_view','watch_start')
           AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${platformWhere}`,
        [days, ...platformParam]
      );
      [searches] = await db.query(
        `SELECT COUNT(*) AS total FROM analytics_events
         WHERE event_type = 'search'
           AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${platformWhere}`,
        [days, ...platformParam]
      );
      [logins] = await db.query(
        `SELECT COUNT(*) AS total FROM analytics_events
         WHERE event_type IN ('login','google_login')
           AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${platformWhere}`,
        [days, ...platformParam]
      );
      [platformBreakdown] = await db.query(
        `SELECT client_platform, COUNT(*) AS views
         FROM analytics_events
         WHERE event_type IN ('anime_view','episode_view','watch_start')
           AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
           ${platformWhere}
         GROUP BY client_platform`,
        [days, ...platformParam]
      );
    } catch (e) {
      // analytics_events table may not exist yet — return zeros
      console.warn('[Analytics] analytics_events table not available:', e.message);
    }

    // New users by period
    const [newUsers] = await db.query(
      `SELECT
        COUNT(CASE WHEN DATE(created_at) = CURDATE() THEN 1 END) AS today,
        COUNT(CASE WHEN created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) THEN 1 END) AS week,
        COUNT(CASE WHEN created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN 1 END) AS month
       FROM users`
    );

    return sendSuccess(res, {
      users: { total: users[0]?.total || 0, activeToday: activeToday[0]?.total || 0, activeWeek: activeWeek[0]?.total || 0, activeMonth: activeMonth[0]?.total || 0 },
      newUsers: { today: newUsers[0]?.today || 0, week: newUsers[0]?.week || 0, month: newUsers[0]?.month || 0 },
      views: { anime: animeViews[0]?.total || 0, episode: episodeViews[0]?.total || 0 },
      engagement: { searches: searches[0]?.total || 0, logins: logins[0]?.total || 0 },
      platformBreakdown: platformBreakdown.map(r => ({ platform: r.client_platform, views: r.views })),
    });
  } catch (err) {
    console.error('[Analytics] overview error:', err.message);
    return res.status(500).json({ message: 'Failed to load analytics overview.' });
  }
};

// ── GET /api/admin/analytics/views ──────────────────────────
exports.getViews = async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const platform = req.query.platform || 'all';
    const ALLOWED_PLATFORMS = new Set(['web', 'mobile', 'desktop']);
    const platformFilter = ALLOWED_PLATFORMS.has(platform) ? platform : null;
    const platformWhere = platformFilter ? 'AND ae.client_platform = ?' : '';
    const platformParam = platformFilter ? [platformFilter] : [];

    let rows = [];
    try {
      [rows] = await db.query(
        `SELECT DATE(ae.created_at) AS date, ae.client_platform, COUNT(*) AS views
         FROM analytics_events ae
         WHERE ae.event_type IN ('anime_view','episode_view','watch_start')
           AND ae.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
           ${platformWhere}
         GROUP BY DATE(ae.created_at), ae.client_platform
         ORDER BY date ASC`,
        [days, ...platformParam]
      );
    } catch (e) {
      console.warn('[Analytics] views: analytics_events not available:', e.message);
    }

    // Group by date
    const byDate = {};
    rows.forEach(r => {
      if (!byDate[r.date]) byDate[r.date] = { date: r.date, web: 0, mobile: 0, desktop: 0, all: 0 };
      byDate[r.date][r.client_platform] = r.views;
      byDate[r.date].all += r.views;
    });

    return sendSuccess(res, {
      labels: Object.keys(byDate).sort(),
      values: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)),
    });
  } catch (err) {
    console.error('[Analytics] views error:', err.message);
    return res.status(500).json({ message: 'Failed to load views analytics.' });
  }
};

// ── GET /api/admin/analytics/searches ──────────────────────
exports.getSearches = async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const platform = req.query.platform || 'all';
    const ALLOWED_PLATFORMS = new Set(['web', 'mobile', 'desktop']);
    const platformFilter = ALLOWED_PLATFORMS.has(platform) ? platform : null;
    const platformWhere = platformFilter ? 'AND client_platform = ?' : '';
    const platformParam = platformFilter ? [platformFilter] : [];

    let topTerms = [], totalSearches = [{ total: 0 }];
    try {
      [topTerms] = await db.query(
        `SELECT JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.query')) AS term,
                client_platform, COUNT(*) AS searches
         FROM analytics_events
         WHERE event_type = 'search'
           AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
           AND metadata IS NOT NULL
           ${platformWhere}
         GROUP BY term, client_platform
         ORDER BY searches DESC
         LIMIT 50`,
        [days, ...platformParam]
      );
      [totalSearches] = await db.query(
        `SELECT COUNT(*) AS total FROM analytics_events
         WHERE event_type = 'search' AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${platformWhere}`,
        [days, ...platformParam]
      );
    } catch (e) {
      console.warn('[Analytics] searches: analytics_events not available:', e.message);
    }

    return sendSuccess(res, {
      total: totalSearches[0]?.total || 0,
      topTerms: topTerms.map(r => ({ term: r.term, platform: r.client_platform, searches: r.searches })),
    });
  } catch (err) {
    console.error('[Analytics] searches error:', err.message);
    return res.status(500).json({ message: 'Failed to load search analytics.' });
  }
};

// ── GET /api/admin/analytics/activity ──────────────────────
exports.getActivity = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const platform = req.query.platform || 'all';
    const ALLOWED_PLATFORMS = new Set(['web', 'mobile', 'desktop']);
    const platformFilter = ALLOWED_PLATFORMS.has(platform) ? platform : null;
    const platformWhere = platformFilter ? 'AND ae.client_platform = ?' : '';
    const platformParam = platformFilter ? [platformFilter] : [];

    let rows = [];
    try {
      [rows] = await db.query(
        `SELECT ae.event_type AS event, ae.client_platform AS platform,
                ae.user_id, ae.anime_id, ae.episode_id, ae.created_at,
                u.name AS user_name, u.email AS user_email,
                a.title AS anime_title,
                e.episode_number, e.title AS episode_title
         FROM analytics_events ae
         LEFT JOIN users u ON u.id = ae.user_id
         LEFT JOIN anime a ON a.id = ae.anime_id
         LEFT JOIN episodes e ON e.id = ae.episode_id
         WHERE 1=1 ${platformWhere}
         ORDER BY ae.created_at DESC
         LIMIT ?`,
        [...platformParam, limit]
      );
    } catch (e) {
      console.warn('[Analytics] activity: analytics_events not available:', e.message);
    }

    return sendSuccess(res, rows.map(r => ({
      event: r.event,
      platform: r.platform,
      user: r.user_name || r.user_email || 'Anonymous',
      anime: r.anime_title || null,
      episode: r.episode_title ? `Episode ${r.episode_number}: ${r.episode_title}` : (r.episode_number ? `Episode ${r.episode_number}` : null),
      timestamp: r.created_at,
    })));
  } catch (err) {
    console.error('[Analytics] activity error:', err.message);
    return res.status(500).json({ message: 'Failed to load activity.' });
  }
};

// ── GET /api/admin/analytics/users ─────────────────────────
exports.getUsers = async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const platform = req.query.platform || 'all';
    const ALLOWED_PLATFORMS = new Set(['web', 'mobile', 'desktop']);
    const platformFilter = ALLOWED_PLATFORMS.has(platform) ? platform : null;
    const platformWhere = platformFilter ? 'AND ae.client_platform = ?' : '';
    const platformParam = platformFilter ? [platformFilter] : [];

    // New users by day
    const [newByDay] = await db.query(
      `SELECT DATE(created_at) AS date, COUNT(*) AS count
       FROM users
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [days]
    );

    let activeByPlatform = [], loginMethods = [];
    try {
      [activeByPlatform] = await db.query(
        `SELECT client_platform, COUNT(DISTINCT user_id) AS users
         FROM analytics_events
         WHERE event_type IN ('login','anime_view','episode_view')
           AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
           ${platformWhere}
         GROUP BY client_platform`,
        [days, ...platformParam]
      );
      [loginMethods] = await db.query(
        `SELECT event_type, COUNT(*) AS count
         FROM analytics_events
         WHERE event_type IN ('login','google_login')
           AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         GROUP BY event_type`,
        [days]
      );
    } catch (e) {
      console.warn('[Analytics] users: analytics_events not available:', e.message);
    }

    return sendSuccess(res, {
      newUsersByDay: newByDay.map(r => ({ date: r.date, count: r.count })),
      activeByPlatform: activeByPlatform.map(r => ({ platform: r.client_platform, users: r.users })),
      loginMethods: loginMethods.map(r => ({ method: r.event_type, count: r.count })),
    });
  } catch (err) {
    console.error('[Analytics] users error:', err.message);
    return res.status(500).json({ message: 'Failed to load user analytics.' });
  }
};

// ── GET /api/admin/analytics/stream-cache ──────────────────
// Returns in-memory stream cache metrics + live DB source counts.
// No provider credentials or raw upstream URLs are exposed.
exports.getStreamCacheMetrics = async (req, res) => {
  try {
    const snapshot = await streamCacheMetrics.getSnapshot();
    return sendSuccess(res, snapshot);
  } catch (err) {
    console.error('[Analytics] stream-cache metrics error:', err.message);
    return res.status(500).json({ message: 'Failed to load stream cache metrics.' });
  }
};

// File Path: Backend/controllers/adminController.js

const db = require('../config/db');

// Utility to normalize buffer bit objects safely into actual JSON booleans
const toBool = v => v === true || v === 1 || v === '1' || (Buffer.isBuffer(v) && v[0] === 1);

exports.getDashboardOverview = async (req, res) => {
  try {
    // 1. Structural User Counts
    const [[{ totalUsers }]] = await db.query('SELECT COUNT(*) as totalUsers FROM users');
    const [[{ premiumUsers }]] = await db.query('SELECT COUNT(*) as premiumUsers FROM users WHERE is_premium = 1 OR premium_expires_at > NOW()');
    const [[{ activeToday }]] = await db.query('SELECT COUNT(DISTINCT user_id) as activeToday FROM watch_history WHERE DATE(updated_at) = CURDATE()').catch(() => [[{ activeToday: 0 }]]);
    const [[{ bannedUsers }]] = await db.query('SELECT COUNT(*) as bannedUsers FROM users WHERE status = "banned"').catch(() => [[{ bannedUsers: 0 }]]);

    // 2. Catalogue Inventory Summaries
    const [[{ totalAnime }]] = await db.query('SELECT COUNT(*) as totalAnime FROM anime');
    const [[{ totalEpisodes }]] = await db.query('SELECT COUNT(*) as totalEpisodes FROM episodes');
    const [[{ totalViews }]] = await db.query('SELECT COALESCE(SUM(view_count), 0) as totalViews FROM anime');
    const [[{ avgRating }]] = await db.query('SELECT COALESCE(AVG(rating), 0) as avgRating FROM anime').catch(() => [[{ avgRating: 0 }]]);

    // 3. Storage Analysis (Bunny.net Upload Stats)
    const [[{ videoCount }]] = await db.query('SELECT COUNT(*) as videoCount FROM episodes WHERE video_url IS NOT NULL AND video_url != ""');
    const [[{ bunnyReady }]] = await db.query('SELECT COUNT(*) as bunnyReady FROM episodes WHERE video_status = "ready"').catch(() => [[{ bunnyReady: 0 }]]);
    const [[{ bunnyProcessing }]] = await db.query('SELECT COUNT(*) as bunnyProcessing FROM episodes WHERE video_status = "processing"').catch(() => [[{ bunnyProcessing: 0 }]]);
    const [[{ bunnyFailed }]] = await db.query('SELECT COUNT(*) as bunnyFailed FROM episodes WHERE video_status = "failed"').catch(() => [[{ bunnyFailed: 0 }]]);

    // 4. Data Sub-Arrays for Layout Feeds
    const [recentAnime] = await db.query('SELECT id, title, cover_image, status, release_year FROM anime ORDER BY created_at DESC LIMIT 5');
    
    const [recentEpisodes] = await db.query(`
      SELECT e.episode_number, e.created_at, a.title as anime_title 
      FROM episodes e 
      JOIN anime a ON e.anime_id = a.id 
      ORDER BY e.created_at DESC LIMIT 5
    `);

    const [activityLogs] = await db.query(`
      SELECT al.action, al.created_at, al.ip_address, u.name as user_name 
      FROM admin_logs al 
      LEFT JOIN users u ON al.admin_id = u.id 
      ORDER BY al.created_at DESC LIMIT 5
    `).catch(() => [[]]);

    // 5. Response payload assembly matching required structures
    res.status(200).json({
      overview: {
        users: { total: totalUsers || 0, premium: premiumUsers || 0, activeToday: activeToday || 0, banned: bannedUsers || 0 },
        content: { totalAnime: totalAnime || 0, totalEpisodes: totalEpisodes || 0, totalViews: totalViews || 0, avgRating: avgRating || 0 },
        storage: { usageGB: (totalEpisodes * 0.45).toFixed(2), videoCount: videoCount || 0 }, 
        bunny: { ready: bunnyReady || 0, processing: bunnyProcessing || 0, failed: bunnyFailed || 0 }
      },
      recentAnime,
      recentEpisodes,
      activityLogs
    });
  } catch (err) {
    console.error('Overview query failure:', err);
    res.status(500).json({ message: 'Internal Server Error fetching dashboard aggregates' });
  }
};

exports.getAllAnime = async (req, res) => {
  try {
    const [anime] = await db.query(`
      SELECT a.*, COUNT(e.id) as episode_count, GROUP_CONCAT(g.name SEPARATOR ', ') as genres
      FROM anime a
      LEFT JOIN episodes e ON a.id = e.anime_id
      LEFT JOIN anime_genres ag ON a.id = ag.anime_id
      LEFT JOIN genres g ON ag.genre_id = g.id
      GROUP BY a.id ORDER BY a.created_at DESC
    `);
    res.status(200).json(anime);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getAllEpisodes = async (req, res) => {
  try {
    const [episodes] = await db.query(`
      SELECT e.*, a.title as anime_title 
      FROM episodes e
      JOIN anime a ON e.anime_id = a.id
      ORDER BY e.created_at DESC
    `);
    res.status(200).json(episodes);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getAllUsers = async (req, res) => {
  try {
    const [users] = await db.query('SELECT id, name, email, is_admin, is_premium, premium_expires_at, status, created_at FROM users ORDER BY created_at DESC');
    res.status(200).json(users.map(u => ({
        ...u,
        is_admin: toBool(u.is_admin),
        is_premium: toBool(u.is_premium)
    })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getSettings = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM settings LIMIT 1').catch(() => [[]]);
    if (!rows.length) {
        return res.status(200).json({ site_name: "AniStrim", premium_monthly_amount: 15000, premium_yearly_amount: 180000 });
    }
    res.status(200).json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getAdvertisements = async (req, res) => {
  try {
    const [ads] = await db.query('SELECT * FROM advertisements ORDER BY created_at DESC').catch(() => [[]]);
    res.status(200).json(ads.map(ad => ({ ...ad, is_active: toBool(ad.is_active), target_free_only: toBool(ad.target_free_only) })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
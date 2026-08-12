const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Global Error Boundaries to prevent Render crashes
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [CRASH PREVENTION] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('💥 [CRASH PREVENTION] Critical Uncaught Exception:', error);
});

const app = express();
const PORT = process.env.PORT || 5000;
const providerHealthMonitor = require('./services/providerHealthMonitor');

providerHealthMonitor.initialize();

// ─── CORS Configuration ────────────────────────────────────
const allowedOrigins = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://10.5.50.55:3000',
  ...(process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean),
]);
const localDevOrigin = /^https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(?::\d+)?$/;

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin) || localDevOrigin.test(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  credentials: true,
}));

// ─── Standard Middleware ───────────────────────────────────
// Webhook route MUST come before express.json() so it gets raw body
app.use('/api/payments/webhook', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Main API Endpoints ────────────────────────────────────
// API routes must be registered before static file handlers and SPA fallbacks
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/anime', require('./routes/animeRoutes'));
app.use('/api/watchlist', require('./routes/watchlistRoutes'));
app.use('/api/payments', require('./routes/paymentRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/admin/upload', require('./routes/uploadRoutes'));
app.use('/api/download', require('./routes/downloadRoutes'));
app.use('/api/watch', require('./routes/watchRoutes'));
app.use('/api/stream', require('./routes/streamRoutes'));
// Secure AnimeHeaven playback proxy — serves anonymized /api/stream-proxy/:streamId
// URLs that inject the cookie/referer/origin context server-side. Cookies and
// target URLs never reach the browser.
app.use('/api/stream-proxy', require('./routes/streamProxyRoutes'));
app.use('/api/ads', require('./routes/adsRoutes'));
app.use('/api/reports', require('./routes/reportRoutes'));
app.use('/api/home', require('./routes/homeShelfRoutes'));

// ─── Consumet Microservice Middleware (Optional HTTP Routes) ──
try {
  const consumetApp = require('./services/consumet/server');
  app.use('/consumet-api', consumetApp);
  console.log('✅ Consumet microservice mounted at /consumet-api');
} catch (err) {
  console.log('ℹ️ Consumet running purely in-memory via @consumet/extensions');
}

// ─── Health Check ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'OK', time: new Date(), environment: process.env.NODE_ENV || 'development'
  });
});

app.get('/health/provider', (req, res) => {
  try {
    const snapshot = providerHealthMonitor.getSnapshot();
    res.status(200).json(snapshot);
  } catch (error) {
    res.status(500).json({
      provider: 'animeheaven',
      status: 'error',
      message: error && error.message ? error.message : 'health_snapshot_failed',
    });
  }
});

// ─── Static Files ──────────────────────────────────────────
// Serve static assets after API routes have been checked
app.use(express.static(path.join(__dirname, 'Frontend')));
app.use('/admin', express.static(path.join(__dirname, 'AdminDashboard')));
app.use('/uploads', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, 'uploads')));

// ─── SPA Fallback Routes ───────────────────────────────────
// These routes catch client-side paths and serve the correct HTML entry point.
// They must come after all API and static asset routes.

// Admin dashboard SPA fallback
// This catches any deep links into the admin panel (e.g., /admin/users) that aren't
// static files, and serves the main dashboard HTML. The client-side router
// (in dashboard.js) will then handle showing the correct section based on the URL hash,
// and will redirect to the login page if the user is not authenticated.
// This must come AFTER the static middleware for '/admin'.
app.get(/^\/admin(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'AdminDashboard', 'dashboard.html'));
});

// General Frontend SPA fallback:
// For any other unmatched route (e.g., /, /browse, /details, /watchlist),
// serve the main frontend index.html, letting the client-side router handle it.
// This must be the very last route handler.
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'Frontend', 'index.html'));
});

// ─── Start Server ──────────────────────────────────────────
// Bind to 0.0.0.0 to ensure the server is accessible from outside the container,
// as required by hosting platforms like Render.
app.listen(PORT, '0.0.0.0', () => {
  console.log('==================================================');
  console.log(`🚀 AniStrim2 running on port ${PORT}`);
  console.log(`   Listening on: http://0.0.0.0:${PORT}`);
  console.log('==================================================');
});

// Start background jobs
require('./utils/premiumAutomation');

// Start the automatic home-shelf section builder (trending/popular/new/classics).
// Refreshes every 6 hours so the sections stay dynamic. Idempotent + failure-safe.
try {
  const homeShelfService = require('./services/homeShelfService');
  homeShelfService.startScheduler();
} catch (err) {
  console.error('⚠️ [HOMESHELF] Scheduler init failed (non-fatal):', err && err.message);
}

// Start the lightweight persistent-stream-cache expiry sweeper (best-effort).
// The sweeper interval is unref'd and failure-safe, so it never blocks playback
// or a clean shutdown. Idempotent — safe to call even if the stream cache
// table isn't migrated yet.
try {
  const streamCacheService = require('./services/streamCacheService');
  streamCacheService.startSweeper();
} catch (err) {
  console.error('⚠️ [STREAM_CACHE] Sweeper init failed (non-fatal):', err && err.message);
}

// Start the AnimeHeaven catalog daily-refresh job (best-effort).
// Automatically syncs stale AnimeHeaven anime every 24h so the catalog stays
// up-to-date (new episodes detected). Idempotent + unref'd + failure-safe.
try {
  const animeHeavenCatalogService = require('./services/animeHeavenCatalogService');
  animeHeavenCatalogService.startDailyRefresh();
} catch (err) {
  console.error('⚠️ [ANIMEHEAVEN_CATALOG] Daily refresh init failed (non-fatal):', err && err.message);
}

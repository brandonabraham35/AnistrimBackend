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
const clientAgnostic = require('./config/clientAgnostic');

// Phase 10 (Security): fail fast if any required secret is missing. Credentials
// are server-side only — never logged, never shipped to the client.
// FIX 6 (P1): STREAM_TOKEN_SECRET is now REQUIRED in production. It is the
// dedicated HMAC key for the short-lived stream tokens (utils/streamToken.js)
// and must NOT fall back to JWT_SECRET — a stream-token key compromise must
// never become an auth-token (JWT) key compromise, and rotation must be
// possible independently. Generate with: openssl rand -hex 32
const REQUIRED_ENV = ['JWT_SECRET', 'STREAM_TOKEN_SECRET', 'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
if (process.env.NODE_ENV === 'production') {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`❌ [SECURITY] Missing required env vars: ${missing.join(', ')}. Refusing to start.`);
    process.exit(1);
  }
}

// Phase 4 (Item 5): generous streaming timeouts. The effective configuration
// is the explicit http.createServer({...}) options below — app.set() is a no-op
// for these Node http-server options. This covers Node-level request/header
// timeouts only. It does NOT prevent upstream provider timeouts, CDN/reverse-proxy
// timeouts (Render/Cloudflare), or client-side aborts.
if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error('❌ [SERVER] Node >= 18 is required (http.createServer options-object timeouts are ignored on older Node). Refusing to start.');
  process.exit(1);
}

// ── Prompt 10: Migration runner + critical-table assertion ──
// Apply any pending sql/migrations_v*.sql files (recorded in schema_migrations)
// and verify the critical tables exist BEFORE any service that depends on them
// starts. Fails loudly — never silently falls back to a legacy path.
//
// The ENTIRE server bootstrap (route registration + app.listen) is wrapped in
// an async IIFE that AWAITS migrations first, so no request can ever hit an
// unmigrated schema. If migrations fail, the process exits before binding.
(async () => {
  try {
    const { runMigrations, assertCriticalTables } = require('./scripts/migrate');
    await runMigrations();
    await assertCriticalTables();
    console.log('✅ Migrations verified. Starting server...');
  } catch (e) {
    console.error('❌ [MIGRATIONS] Startup blocked:', e.message);
    process.exit(1);
  }

  providerHealthMonitor.initialize();

  // ── Email (Mailgun) boot-time check ──────────────────────
  // The server MUST start even if email is misconfigured or Mailgun is down.
  // No real test email is sent at startup — Mailgun is only used at runtime
  // when an email actually needs to be sent. This replaces the old Gmail SMTP
  // transporter.verify() which could block/crash the Render boot.
  try {
    const { verifyTransport } = require('./utils/mailer');
    await verifyTransport(false); // exitOnFailure=false → never kills the server
  } catch (e) {
    // verifyTransport logged already. Non-fatal — the app keeps running.
    console.warn('⚠️ [MAILER] Email configuration check failed at startup (non-fatal).', e && e.message);
  }

// Phase 2 (FIX 3): boot-time probe for sharp so avatar failures are visible
// in server logs instead of silently returning 502/503 at runtime.
try {
  const { probeSharp } = require('./services/avatarService');
  probeSharp();
} catch (e) {
  console.warn('⚠️ [AVATAR] Could not probe sharp:', e.message);
}

// ─── CORS Configuration ────────────────────────────────────
// Environment-driven CORS from config/cors.js:
//   - API_ALLOWED_ORIGINS env var (comma-separated) for Web, Admin,
//     Capacitor (mobile), and future desktop origins.
//   - Development localhost/private-LAN origins auto-enabled in dev.
//   - credentials:false because auth uses Bearer JWT (Authorization header),
//     not cookies.
const corsOptions = require('./config/cors').buildCorsOptions();
app.use(cors(corsOptions));

// ─── Request ID ────────────────────────────────────────────
// Assigns a unique request ID (req.requestId) and echoes it in the
// X-Request-Id response header. Used by the error handler in every error body.
app.use(require('./middleware/requestId'));

// ─── Standard Middleware ───────────────────────────────────
// Webhook route MUST come before express.json() so it gets raw body
app.use('/api/payments/webhook', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Per-request latency + status logging (admin health widgets) ──
// Records method/path/status_code/latency_ms into api_request_log for the
// p50/p95 + 5xx-per-hour widgets. Fire-and-forget, never blocks the request.
try {
  app.use(require('./middleware/requestMetrics'));
  console.log('✅ Request metrics middleware mounted (api_request_log)');
} catch (err) {
  console.warn('⚠️ [REQUEST_METRICS] Middleware init failed (non-fatal):', err && err.message);
}

// ─── Main API Endpoints ────────────────────────────────────
// API routes must be registered before static file handlers and SPA fallbacks
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/v1', require('./routes/v1'));
app.use('/api/auth', require('./routes/avatarRoutes'));
app.use('/api/profile', require('./routes/profileRoutes'));
// FIX 10: profileRoutes already declares /username-available and /set-username
// under /api/profile. The inline /api/auth duplicates are removed — one handler,
// one declaration site. The frontend uses /api/profile/username-available.
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

// ─── Centralized Error Handler ─────────────────────────────
// Must be registered AFTER all routes so it catches any errors thrown from
// controllers, and BEFORE the SPA fallback so API errors stay JSON.
app.use(require('./middleware/errorHandler'));

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

// ─── Static Files (configurable) ───────────────────────────
// The backend is a pure API/service for independent deployment. Static serving
// of the Web (Frontend/) and Admin (AdminDashboard/) is OPTIONAL and controlled
// by environment configuration. Local development keeps the default (true) so
// the in-repo frontends keep working; production API deployments set:
//   SERVE_STATIC_FRONTEND=false   (disables both, API-only)
//   SERVE_FRONTEND=false          (disables the Web frontend only)
//   SERVE_ADMIN=false             (disables the admin dashboard only)
// The API 404 guard and /api/health always work regardless.
const frontendDir = path.join(__dirname, clientAgnostic.FRONTEND_DIR || 'Frontend');
const adminDir = path.join(__dirname, clientAgnostic.ADMIN_DIR || 'AdminDashboard');

if (clientAgnostic.SERVE_FRONTEND) {
  // Serve the Web frontend static assets (dev convenience / monolith mode).
  app.use(express.static(frontendDir));
}

if (clientAgnostic.SERVE_ADMIN) {
  // Serve the Admin dashboard static assets under /admin.
  app.use('/admin', express.static(adminDir));
}

// Uploads are always served (they are API-adjacent user content, not a frontend).
app.use('/uploads', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, 'uploads')));

// ─── API 404 Guard ─────────────────────────────────────────
// Always present: unknown /api/* routes return JSON regardless of static config.
app.use('/api', (req, res) => {
  res.status(404).json({ code: 'NOT_FOUND', message: 'API endpoint not found.' });
});

// ─── SPA Fallback Routes (only when the component is served) ──
if (clientAgnostic.SERVE_ADMIN && clientAgnostic.SERVE_FRONTEND) {
  app.get(/^\/admin(\/.*)?$/, (req, res) => {
    res.sendFile(path.join(adminDir, 'dashboard.html'));
  });
  app.get(/.*/, (req, res) => {
    res.sendFile(path.join(frontendDir, 'index.html'));
  });
} else if (clientAgnostic.SERVE_ADMIN) {
  app.get(/^\/admin(\/.*)?$/, (req, res) => {
    res.sendFile(path.join(adminDir, 'dashboard.html'));
  });
} else if (clientAgnostic.SERVE_FRONTEND) {
  app.get(/.*/, (req, res) => {
    res.sendFile(path.join(frontendDir, 'index.html'));
  });
}

console.log(`[SERVE] API-only=${!clientAgnostic.SERVE_FRONTEND && !clientAgnostic.SERVE_ADMIN} | SERVE_FRONTEND=${clientAgnostic.SERVE_FRONTEND} | SERVE_ADMIN=${clientAgnostic.SERVE_ADMIN}`);
console.log(`[SERVE] API is reachable at /api/health regardless of static serving.`);


// ─── Start Server ──────────────────────────────────────────
// Bind to 0.0.0.0 to ensure the server is accessible from outside the container,
// as required by hosting platforms like Render.
// Phase 4 (Item 5): create the HTTP server explicitly so the streaming timeouts
// actually apply — express app.set() does not reach the underlying Node http
// server when using app.listen(). requestTimeout=0 disables the body timeout so
// long-lived media streams are never cut; headersTimeout=120000 gives the
// upstream generous time to begin responding.
const http = require('http');
const server = http.createServer(
  {
    requestTimeout: 0,
    headersTimeout: 120000,
    keepAliveTimeout: 65000,
    connectionsCheckingInterval: 60000,
  },
  app
);
server.listen(PORT, '0.0.0.0', () => {
  console.log('==================================================');
  console.log(`🚀 AniStrim2 running on port ${PORT}`);
  console.log(`   Listening on: http://0.0.0.0:${PORT}`);
  console.log('==================================================');
});
// Detect abnormal server-closing conditions so we can log the cause.
server.on('clientError', (err, socket) => {
  console.error('⚠️ [SERVER] clientError:', err.message);
  if (socket && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
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

// Start the nightly recommendation rebuild (Phase 6.3, best-effort).
// Recomputes user_recommendations + user_genre_vector each night at 03:00 so
// the homepage is a single indexed read. Idempotent + failure-safe.
try {
  const recommendationService = require('./services/recommendationService');
  recommendationService.startScheduler();
} catch (err) {
  console.error('⚠️ [RECOMMENDATIONS] Scheduler init failed (non-fatal):', err && err.message);
}

// Start the premium release + subscription state scheduler (Phase 7.3).
// Every 10 min: expire timed-release episodes → free, sweep subscription state
// (active → grace → expired), and refresh the users.is_premium derived cache.
// Idempotent + failure-safe. The read path stays correct even if cron misses.
try {
  const premiumScheduler = require('./services/premiumScheduler');
  premiumScheduler.startScheduler();
} catch (err) {
  console.error('⚠️ [PREMIUM_SCHEDULER] Scheduler init failed (non-fatal):', err && err.message);
}

// Start the nightly health_samples prune (Phase 9). Each night at 03:17 deletes
// health_samples older than 30 days so the table doesn't grow unbounded
// (10 components sampled per probe run). Idempotent + failure-safe.
try {
  const healthService = require('./services/healthService');
  healthService.startPruner();
} catch (err) {
  console.error('⚠️ [HEALTH] Pruner init failed (non-fatal):', err && err.message);
}

})();

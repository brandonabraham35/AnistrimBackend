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

// ── Render/Express proxy trust (FIX: ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) ──
// AniStrim2 is deployed behind Render's reverse proxy. Render terminates TLS
// and forwards X-Forwarded-For / X-Forwarded-Proto. Without "trust proxy",
// Express overwrites req.ip with the socket's remote address (the proxy
// itself), so express-rate-limit sees every request coming from the same
// internal IP and rejects the X-Forwarded-For header with
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
//
// trust proxy = 1 means "trust the first hop only" — correct for a single
// proxy layer (Render's load balancer). Set BEFORE any middleware that
// reads req.ip (CORS, rate-limiting, request metrics).
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────
// These are intentionally set AFTER trust-proxy but BEFORE routes.
app.use((_req, res, next) => {
  // X-Content-Type-Options: prevent MIME-type sniffing.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Referrer-Policy: never leak the API URL in the Referer header.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Permissions-Policy: restrict browser features to trusted origins.
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Strict-Transport-Security: only when HTTPS is guaranteed (production).
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  // X-Frame-Options: prevent clickjacking via iframe embedding.
  res.setHeader('X-Frame-Options', 'DENY');
  // Content-Security-Policy: restrict script/style sources to self.
  // 'unsafe-inline' is needed for the SPA's inline event handlers and JSON-LD.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "img-src 'self' data: https:; media-src 'self' https: blob:; " +
    "connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; " +
    "font-src 'self' https://fonts.gstatic.com;"
  );
  // Hide Express framework identity.
  // (done via app.disable below, but header-level defense in depth)
  next();
});

// Disable Express's X-Powered-By header.
app.disable('x-powered-by');

// ─ Vercel secret gate ──────────────────────────────────────
// Ensures sensitive API requests come from Vercel (with the shared secret header)
// and not from direct Render URL access.
// Public endpoints (anime, streaming, health, Google OAuth) are EXEMPT.
const VERCEL_SECRET = process.env.VERCEL_SECRET;
if (VERCEL_SECRET) {
  // When mounted at /api, req.path is stripped of the /api prefix
  const PUBLIC_API_PREFIXES = ['/anime/', '/stream/', '/health', '/auth/google/'];
  app.use('/api', (req, res, next) => {
    if (PUBLIC_API_PREFIXES.some(p => req.path.startsWith(p))) return next();
    const provided = req.headers['x-vercel-secret'];
    if (!provided || provided !== VERCEL_SECRET) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied.' } });
    }
    next();
  });
}

// ─ HTTPS enforcement (production only) ────────────────────────
// Render terminates TLS at the edge and forwards X-Forwarded-Proto.
// Without this, direct IP access to the Render instance would serve
// unencrypted HTTP, exposing Bearer tokens to MITM attacks.
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    }
    next();
  });
}

const PORT = process.env.PORT || 5000;

const providerHealthMonitor = require('./services/providerHealthMonitor');
const clientAgnostic = require('./config/clientAgnostic');
const { sendSuccess } = require('./utils/response');

// Phase 10 (Security): fail fast if any required secret is missing. Credentials
// are server-side only — never logged, never shipped to the client.
// FIX 6 (P1): STREAM_TOKEN_SECRET is now REQUIRED in production. It is the
// dedicated HMAC key for the short-lived stream tokens (utils/streamToken.js)
// and must NOT fall back to JWT_SECRET — a stream-token key compromise must
// never become an auth-token (JWT) key compromise, and rotation must be
// possible independently. Generate with: openssl rand -hex 32
const REQUIRED_ENV = ['JWT_SECRET', 'STREAM_TOKEN_SECRET', 'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
// PASSWORD_PEPPER is strongly recommended for production security.
// Without it, passwords are vulnerable to offline cracking if the database is breached.
// Generate with: openssl rand -hex 32
// Note: We don't make it required to avoid breaking existing deployments that
// would need a migration strategy for existing password hashes.
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

  // ── Email (Postmark) boot-time check ──────────────────────
  // The server MUST start even if email is misconfigured or Postmark is down.
  // No real test email is sent at startup — Postmark is only used at runtime
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
//   - Native WebView origins (capacitor://localhost, https://localhost) are
//     ALWAYS allowed regardless of NODE_ENV (B1 fix).
//   - credentials:false because auth uses Bearer JWT (Authorization header),
//     not cookies.
const corsOptions = require('./config/cors').buildCorsOptions();
app.use(cors(corsOptions));

// ─── Request ID ────────────────────────────────────────────
// Assigns a unique request ID (req.requestId) and echoes it in the
// X-Request-Id response header. Used by the error handler in every error body.
app.use(require('./middleware/requestId'));

// ─── Client Platform Normalization ─────────────────────────
// Extracts X-Client header (web|mobile|desktop|admin) into req.clientPlatform
// for analytics attribution. Backward-compatible: missing headers → 'unknown'.
app.use(require('./middleware/clientPlatform'));

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
app.use('/api/analytics', require('./routes/analyticsRoutes'));
app.use('/api/admin/analytics', require('./routes/analyticsRoutes'));
app.use('/api/support', require('./routes/supportRoutes'));

// ─── SEO surface (crawlable path-based URLs) ────────────────
// Dynamic sitemap.xml / robots.txt plus per-anime and browse pages that carry
// canonical URLs, metadata, and JSON-LD for crawlers while booting humans into
// the hash-routed Web SPA. Must stay registered BEFORE static/catch-all mounts.
app.use(require('./routes/seoRoutes'));

// ─── Consumet Microservice Middleware (Optional HTTP Routes) ──
// Security: Consumet is only mounted in non-production environments.
// In production, the backend uses the dedicated stream proxy instead.
// This prevents unauthorized scraping of upstream providers.
if (process.env.NODE_ENV !== 'production') {
  try {
    const consumetApp = require('./services/consumet/server');
    const authMiddleware = require('./middleware/auth');
    app.use('/consumet-api', authMiddleware.protect, consumetApp);
    console.log('✅ Consumet microservice mounted at /consumet-api (dev only, auth-protected)');
  } catch (err) {
    console.log('ℹ️ Consumet running purely in-memory via @consumet/extensions');
  }
} else {
  console.log('ℹ️ Consumet microservice disabled in production (using stream proxy instead)');
}

// ─── Health Check ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  sendSuccess(res, { status: 'OK', time: new Date(), environment: process.env.NODE_ENV || 'development' });
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

// ─── API 404 Guard (B3 fix) ────────────────────────────────
// ALWAYS present: unknown /api/* routes return JSON 404, never HTML.
// This must come AFTER all /api/* routers but BEFORE static/SPA fallbacks.
// A bad API path returning the mobile HTML shell was a whole class of bugs.
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'API endpoint not found.',
      status: 404,
      requestId: req.requestId || undefined,
    },
  });
});

// ─── Static Files (configurable) ───────────────────────────
// The backend serves up to four static roots. Mount order matters:
//   1. /admin → AdminDashboard/
//   2. /web → Web/ (browser SPA)
//   3. /desktop-preview → Desktop/ (optional, for testing)
//   4. /shared/client-contract → shared contract layer
//   5. / → Frontend/ (mobile, Capacitor webDir) — LAST (catch-all)
//
// Static serving is OPTIONAL and controlled by environment configuration.
// Local development keeps the default (true); production API-only deployments
// set SERVE_STATIC_FRONTEND=false.

const frontendDir = path.join(__dirname, clientAgnostic.FRONTEND_DIR || 'Frontend');
const adminDir = path.join(__dirname, clientAgnostic.ADMIN_DIR || 'AdminDashboard');
const webDir = path.join(__dirname, clientAgnostic.WEB_DIR || 'Web');
const desktopDir = path.join(__dirname, clientAgnostic.DESKTOP_DIR || 'Desktop');
const webMountPath = clientAgnostic.WEB_MOUNT_PATH || '/web';

// Cache control helpers
const NO_CACHE = 'no-cache, no-store, must-revalidate';
const ASSET_CACHE = 'public, max-age=31536000, immutable'; // 1 year for hashed assets

// ─── Shared client contract layer ──────────────────────────
// Serve shared/client-contract/* so all clients can load the same API contract.
// This is non-visual logic only: endpoints, envelope unwrapping, http, session.
app.use('/shared/client-contract', express.static(path.join(__dirname, 'shared', 'client-contract'), {
  index: false,
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  },
}));

// ─── 1. Admin Dashboard ────────────────────────────────────
if (clientAgnostic.SERVE_ADMIN) {
  app.use('/admin', express.static(adminDir, {
    index: false, // Let the fallback route handle index
    maxAge: '1h',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', NO_CACHE);
      } else if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?)$/.test(filePath)) {
        res.setHeader('Cache-Control', ASSET_CACHE);
      }
    },
  }));
  // SPA fallback for /admin/*
  app.get(/^\/admin(\/.*)?$/, (req, res) => {
    res.sendFile(path.join(adminDir, 'dashboard.html'));
  });
}

// ─── 2. Web Client (browser SPA at /web) ───────────────────
// B3 fix: The Web/ folder is now served at /web with proper SPA fallback.
// Deep links like /web/anime/123 return Web/index.html, not mobile shell.
if (clientAgnostic.SERVE_WEB) {
  app.use(webMountPath, express.static(webDir, {
    index: false, // Let the fallback route handle index
    maxAge: '1h',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', NO_CACHE);
      } else if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?)$/.test(filePath)) {
        res.setHeader('Cache-Control', ASSET_CACHE);
      }
    },
  }));
  // SPA fallback for /web/* — all deep links return Web/index.html
  const webFallbackRegex = new RegExp(`^${webMountPath.replace(/\//g, '\\/')}(\\/.*)?$`);
  app.get(webFallbackRegex, (req, res) => {
    res.sendFile(path.join(webDir, 'index.html'));
  });
}

// ─── 3. Desktop Preview (optional) ─────────────────────────
// For testing the Electron renderer in a browser before packaging.
// Disabled by default (SERVE_DESKTOP_PREVIEW=false).
if (clientAgnostic.SERVE_DESKTOP_PREVIEW) {
  app.use('/desktop-preview', express.static(desktopDir, {
    index: false,
    maxAge: '1h',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', NO_CACHE);
      }
    },
  }));
  app.get(/^\/desktop-preview(\/.*)?$/, (req, res) => {
    res.sendFile(path.join(desktopDir, 'index.html'));
  });
}

// Uploads are always served (they are API-adjacent user content, not a frontend).
app.use('/uploads', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, 'uploads')));

// ─── 4. Mobile Frontend (catch-all, MUST be last) ──────────
// Frontend/ is the mobile-only UI (Capacitor webDir). It is served at /
// and is the FINAL catch-all — any unmatched route returns Frontend/index.html.
if (clientAgnostic.SERVE_FRONTEND) {
  app.use(express.static(frontendDir, {
    index: false, // Let the fallback route handle index
    maxAge: '1h',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', NO_CACHE);
      } else if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?)$/.test(filePath)) {
        res.setHeader('Cache-Control', ASSET_CACHE);
      }
    },
  }));
}

// ─── Final SPA Fallback (mobile) ───────────────────────────
// This MUST be the last route. Any request that didn't match /api/*,
// /admin/*, /web/*, /desktop-preview/*, or a static file gets the mobile shell.
if (clientAgnostic.SERVE_FRONTEND) {
  app.get(/.*/, (req, res) => {
    res.sendFile(path.join(frontendDir, 'index.html'));
  });
}

// ─── Loud CORS rejection (B9 fix) ─────────────────────────────
// cors()'s origin callback rejects blocked origins with callback(null, false),
// which yields a 200 with NO Access-Control-Allow-Origin header — the silent
// failure that killed mobile in production. This wrapper turns blocked-origin
// requests into an explicit 403 JSON so they are visible in server logs and
// on the client console.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !res.getHeader('access-control-allow-origin') && !res.writableEnded) {
    res.status(403).json({
      success: false,
      error: {
        code: 'CORS_BLOCKED',
        message: 'Origin not allowed: ' + origin,
        status: 403,
        requestId: req.requestId || req.id || undefined,
      },
    });
    return;
  }
  next();
});

// ─── Centralized Error Handler ─────────────────────────────
// MUST be registered AFTER every route (API + static + SPA fallback + CORS
// wrapper) so it catches errors thrown by the final catch-all or the 403 wrapper.
app.use(require('./middleware/errorHandler'));

console.log('[SERVE] Configuration:');
console.log(`  API-only: ${!clientAgnostic.SERVE_FRONTEND && !clientAgnostic.SERVE_ADMIN && !clientAgnostic.SERVE_WEB}`);
console.log(`  SERVE_FRONTEND (mobile at /): ${clientAgnostic.SERVE_FRONTEND}`);
console.log(`  SERVE_WEB (browser at ${webMountPath}): ${clientAgnostic.SERVE_WEB}`);
console.log(`  SERVE_ADMIN (at /admin): ${clientAgnostic.SERVE_ADMIN}`);
console.log(`  SERVE_DESKTOP_PREVIEW: ${clientAgnostic.SERVE_DESKTOP_PREVIEW}`);
console.log('[SERVE] API is reachable at /api/health regardless of static serving.');

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
// config/cors.js — environment-driven CORS configuration.
//
// The backend serves four independent clients:
//   1. Web frontend (browser SPA at /web or hosted separately)
//   2. Mobile (Android/iOS Capacitor WebView)
//   3. Desktop (Electron packaged app)
//   4. Admin dashboard
//
// CORS origins are read from the API_ALLOWED_ORIGINS environment variable
// (comma-separated). Native WebView origins (Capacitor) are ALWAYS allowed
// regardless of NODE_ENV because they are not browser origins and cannot be
// spoofed into a credentialed attack (credentials:false, Bearer header auth).
//
// Authentication uses Bearer JWT in the Authorization header — NOT cookies —
// so credentials:true is intentionally NOT used. This avoids reflecting
// arbitrary origins with credentials, which is a security risk.
//
// Example API_ALLOWED_ORIGINS:
//   https://anistrim.com,https://www.anistrim.com,https://admin.anistrim.com,https://anistrimbackend.onrender.com
//
// Desktop origins (Electron packaged builds) can be added via DESKTOP_ORIGINS:
//   DESKTOP_ORIGINS=app://anistrim-desktop,anistrim://desktop

'use strict';

/**
 * Parse a comma-separated origin list into a Set of trimmed origins.
 * Handles empty strings and whitespace.
 */
function parseOrigins(raw) {
  if (!raw) return new Set();
  return new Set(
    String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * Native WebView origins that MUST always be allowed regardless of NODE_ENV.
 * These are Capacitor/Electron internal origins, not browser origins:
 *   - capacitor://localhost  → iOS Capacitor WebView
 *   - https://localhost      → Android Capacitor WebView (androidScheme: https)
 *   - http://localhost       → Android Capacitor WebView (fallback)
 *   - ionic://localhost      → Ionic/Capacitor alternative scheme
 *
 * Security note: These origins cannot be exploited cross-origin because:
 *   1. credentials:false — no cookies are sent
 *   2. Auth uses Bearer JWT in Authorization header, which the attacker cannot
 *      inject into a victim's WebView
 *   3. These origins only exist inside the app's own WebView process
 */
const NATIVE_WEBVIEW_ORIGINS = [
  'capacitor://localhost',   // iOS Capacitor
  'https://localhost',       // Android Capacitor (androidScheme: https)
  'http://localhost',        // Android Capacitor (fallback)
  'ionic://localhost',       // Ionic/Capacitor alternative
];

/**
 * Build the set of allowed origins for the current environment.
 * Reads API_ALLOWED_ORIGINS (comma-separated) + DESKTOP_ORIGINS.
 * ALWAYS includes native WebView origins (Capacitor) regardless of NODE_ENV.
 * In non-production, adds standard development localhost origins.
 */
function buildAllowedOrigins() {
  const envOrigins = parseOrigins(process.env.API_ALLOWED_ORIGINS);

  // Desktop app origins (Electron packaged builds use app:// or custom schemes)
  parseOrigins(process.env.DESKTOP_ORIGINS).forEach((o) => envOrigins.add(o));

  // ALWAYS allow native WebView origins — these are not browser origins.
  // This fixes B1: mobile app was dead in production because these were
  // only added when NODE_ENV !== 'production'.
  NATIVE_WEBVIEW_ORIGINS.forEach((o) => envOrigins.add(o));

  // In dev, allow common local development origins across all client types.
  if (process.env.NODE_ENV !== 'production') {
    parseOrigins([
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:8100',   // Capacitor web (dev)
      'http://localhost:4200',   // Angular dev (future desktop)
      'http://localhost:5000',   // API itself (server-rendered / OAuth callbacks)
      'http://localhost:5173',   // Vite dev server
    ].join(',')).forEach((o) => envOrigins.add(o));
  }

  return envOrigins;
}

// Regex for development-only private-LAN origins. Production never allows these.
const DEV_ORIGIN_REGEX = process.env.NODE_ENV === 'production'
  ? /^$/
  : /^https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(?::\d+)?$/;

/**
 * CORS origin validator. Returns true if the origin is allowed, false otherwise.
 * - Allows requests with NO origin (curl, Electron file://, server-to-server).
 * - Allows explicit origins from API_ALLOWED_ORIGINS + DESKTOP_ORIGINS.
 * - ALWAYS allows native WebView origins (Capacitor).
 * - In dev, allows localhost / private-LAN origins.
 */
function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) return true; // no Origin header (curl, Electron file://, same-origin, server-to-server)
  if (allowedOrigins.has(origin)) return true;
  if (DEV_ORIGIN_REGEX.test(origin)) return true;
  return false;
}

/**
 * Build the CORS middleware options object.
 * Exported separately for testability.
 */
function buildCorsOptions() {
  const allowedOrigins = buildAllowedOrigins();
  return {
    origin(origin, callback) {
      if (isOriginAllowed(origin, allowedOrigins)) {
        return callback(null, true);
      }
      // B9 fix: Log rejected origins so CORS failures are diagnosable.
      console.warn('[cors] blocked origin:', origin);
      return callback(null, false); // CORS error — request blocked by cors middleware
    },
    // PATCH added (was missing per audit B1)
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin',
      'X-Client',           // Client identifier: mobile|web|desktop|admin
      'X-Request-Id',       // Request tracing
    ],
    exposedHeaders: [
      'X-Request-Id',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
    ],
    credentials: false, // Bearer JWT auth — cookies NOT used
    optionsSuccessStatus: 200, // Ensure OPTIONS preflight returns 200, not 204
    maxAge: 86400, // Cache preflight for 24h
  };
}

module.exports = {
  parseOrigins,
  buildAllowedOrigins,
  isOriginAllowed,
  buildCorsOptions,
  DEV_ORIGIN_REGEX,
  NATIVE_WEBVIEW_ORIGINS,
};
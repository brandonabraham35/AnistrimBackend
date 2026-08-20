// config/cors.js — environment-driven CORS configuration.
//
// The backend serves four independent clients:
//   1. Web frontend
//   2. Mobile (Android/iOS Capacitor)
//   3. Desktop (future)
//   4. Admin dashboard
//
// CORS origins are read from the API_ALLOWED_ORIGINS environment variable
// (comma-separated). Development localhost origins are enabled automatically
// when NODE_ENV !== 'production'.
//
// Authentication uses Bearer JWT in the Authorization header — NOT cookies —
// so credentials:true is intentionally NOT used. This avoids reflecting
// arbitrary origins with credentials, which is a security risk.
//
// Example API_ALLOWED_ORIGINS:
//   https://anistrim.com,https://admin.anistrim.com,https://anistrimbackend.onrender.com
//
// Development defaults (when NODE_ENV !== 'production'):
//   http://localhost:3000, http://127.0.0.1:3000, capacitor://localhost,
//   https://localhost, http://localhost:8100, http://localhost:4200

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
 * Build the set of allowed origins for the current environment.
 * Reads API_ALLOWED_ORIGINS (comma-separated). In non-production, adds
 * standard development localhost origins (browser + Capacitor + desktop dev).
 */
function buildAllowedOrigins() {
  const envOrigins = parseOrigins(process.env.API_ALLOWED_ORIGINS);

  // In dev, allow common local development origins across all client types.
  if (process.env.NODE_ENV !== 'production') {
    parseOrigins([
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:8100',   // Capacitor web (dev)
      'http://localhost:4200',   // Angular dev (future desktop)
      'capacitor://localhost',   // iOS Capacitor
      'https://localhost',       // Android Capacitor (production WebView)
      'http://localhost:5000',   // API itself (server-rendered / OAuth callbacks)
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
 * - Allows requests with NO origin (curl, server-to-server, same-origin).
 * - Allows explicit origins from API_ALLOWED_ORIGINS.
 * - In dev, allows localhost / private-LAN origins.
 */
function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) return true; // no Origin header (curl, same-origin, server-to-server)
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
      return callback(null, false); // CORS error — request blocked by cors middleware
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
    credentials: false, // Bearer JWT auth — cookies NOT used
    optionsSuccessStatus: 200, // Ensure OPTIONS preflight returns 200, not 204
  };
}

module.exports = {
  parseOrigins,
  buildAllowedOrigins,
  isOriginAllowed,
  buildCorsOptions,
  DEV_ORIGIN_REGEX,
};
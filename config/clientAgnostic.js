// config/clientAgnostic.js
// Central configuration for making the API client-agnostic (presentation-decoupling).
//
// These settings let operators control how the backend behaves without forcing
// any particular client UI. They are read by the auth/payment/watch controllers
// and by server.js for static-serving of all three clients (Mobile/Web/Desktop).
//
// MULTI-CLIENT SUPPORT (B7 fix):
// - Password reset and Google OAuth return URLs are now per-client maps resolved
//   from the X-Client header (mobile|web|desktop|admin).
// - Values are validated against strict allow-lists from env — never reflect
//   caller-supplied URLs.
require('dotenv').config();

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true' || value === '1';
}

function parseJsonEnv(key, fallback) {
  const raw = process.env[key];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[clientAgnostic] Invalid JSON in ${key}, using fallback. Error:`, e.message);
    return fallback;
  }
}

// ── Static-serving defaults ─────────────────────────────────
// A single all-or-nothing flag (SERVE_STATIC_FRONTEND) remains the legacy
// control; granular flags default to it so local dev keeps serving everything
// while production can disable each component independently.
const serveStatic = bool(process.env.SERVE_STATIC_FRONTEND, true);
const serveFrontend = bool(process.env.SERVE_FRONTEND, serveStatic);
const serveAdmin = bool(process.env.SERVE_ADMIN, serveStatic);

// B3 fix: Web client serving (browser SPA at /web)
const serveWeb = bool(process.env.SERVE_WEB, serveStatic);
const webMountPath = process.env.WEB_MOUNT_PATH || '/web';

// B6 fix: Desktop preview serving (optional, for testing Electron renderer in browser)
const serveDesktopPreview = bool(process.env.SERVE_DESKTOP_PREVIEW, false);

// ── Per-client URL maps (B7 fix) ────────────────────────────
// These replace the single PASSWORD_RESET_PATH / GOOGLE_AUTH_DEEP_LINK.
// Keys are client identifiers from X-Client header: mobile|web|desktop|admin
// Values MUST be validated against allow-lists — never reflect caller input.

// Default reset paths per client (can be overridden via RESET_PATHS_JSON env)
const DEFAULT_RESET_PATHS = {
  mobile: '/reset-password.html',           // Frontend/ (Capacitor WebView)
  web: '/web/reset-password',               // Web/ SPA route
  desktop: '/reset-password',               // Desktop app route
  admin: '/admin/reset-password',           // Admin dashboard (if needed)
};

// Default Google OAuth return targets per client
const DEFAULT_GOOGLE_RETURN_TARGETS = {
  mobile: 'anistrim://auth',                // Deep link scheme for Capacitor
  web: '/web/auth/google/callback',         // Web SPA callback route
  desktop: 'anistrim-desktop://auth',       // Desktop custom scheme
  admin: '/admin/google-callback.html',     // Admin dashboard callback
};

const resetPaths = parseJsonEnv('RESET_PATHS_JSON', DEFAULT_RESET_PATHS);
const googleReturnTargets = parseJsonEnv('GOOGLE_RETURN_TARGETS_JSON', DEFAULT_GOOGLE_RETURN_TARGETS);

// Strict allow-lists for validating client-supplied paths.
// Only values in these lists are ever accepted — prevents open redirect attacks.
const RESET_PATH_ALLOW_LIST = new Set([
  '/reset-password.html',
  '/reset-password',              // matches DEFAULT_RESET_PATHS.desktop
  '/web/reset-password',
  '/web/#/reset-password',        // hash-routed web default (SPA)
  '/desktop/reset-password',
  '/admin/reset-password',
  // Add custom paths here if needed
]);

const GOOGLE_RETURN_ALLOW_LIST = new Set([
  'anistrim://auth',
  'anistrim-desktop://auth',
  '/web/auth/google/callback',
  '/admin/google-callback.html',
  // Add custom targets here if needed
]);

/**
 * Resolve the password reset path for a given client.
 * @param {string} client - Client identifier (mobile|web|desktop|admin)
 * @param {string} [requestedPath] - Optional path requested by the client (validated)
 * @returns {string} The validated reset path
 */
function getPasswordResetPath(client, requestedPath) {
  // If client requested a specific path, validate it against the allow-list
  if (requestedPath) {
    if (RESET_PATH_ALLOW_LIST.has(requestedPath)) {
      return requestedPath;
    }
    console.warn(`[clientAgnostic] Rejected reset path (not in allow-list): ${requestedPath}`);
  }
  // Fall back to per-client default, then mobile default
  return resetPaths[client] || resetPaths.mobile || DEFAULT_RESET_PATHS.mobile;
}

/**
 * Resolve the Google OAuth return target for a given client.
 * @param {string} client - Client identifier (mobile|web|desktop|admin)
 * @param {string} [requestedTarget] - Optional target requested by the client (validated)
 * @returns {string} The validated return target
 */
function getGoogleReturnTarget(client, requestedTarget) {
  // If client requested a specific target, validate it against the allow-list
  if (requestedTarget) {
    if (GOOGLE_RETURN_ALLOW_LIST.has(requestedTarget)) {
      return requestedTarget;
    }
    console.warn(`[clientAgnostic] Rejected Google return target (not in allow-list): ${requestedTarget}`);
  }
  // Fall back to per-client default, then mobile default
  return googleReturnTargets[client] || googleReturnTargets.mobile || DEFAULT_GOOGLE_RETURN_TARGETS.mobile;
}

// ── Host-based routing (optional) ───────────────────────────
// If PRIMARY_HOST_WEB is set, requests with that Host header get Web/ at /
// instead of Frontend/. Useful for serving web.anistrim.com → Web/ and
// m.anistrim.com → Frontend/ from the same server.
const primaryHostWeb = process.env.PRIMARY_HOST_WEB || '';
const primaryHostMobile = process.env.PRIMARY_HOST_MOBILE || '';

module.exports = {
  // Legacy flags
  SERVE_STATIC_FRONTEND: serveStatic,
  SERVE_FRONTEND: serveFrontend,
  SERVE_ADMIN: serveAdmin,

  // B3 fix: Web client serving
  SERVE_WEB: serveWeb,
  WEB_DIR: process.env.WEB_DIR || 'Web',
  WEB_MOUNT_PATH: webMountPath,

  // B6 fix: Desktop preview serving
  SERVE_DESKTOP_PREVIEW: serveDesktopPreview,
  DESKTOP_DIR: process.env.DESKTOP_DIR || 'Desktop',

  // Host-based routing
  PRIMARY_HOST_WEB: primaryHostWeb,
  PRIMARY_HOST_MOBILE: primaryHostMobile,

  // Directories
  FRONTEND_DIR: process.env.FRONTEND_DIR || 'Frontend',
  ADMIN_DIR: process.env.ADMIN_DIR || 'AdminDashboard',

  // ── Legacy single-value settings (deprecated, kept for backward compat) ──
  // These are now per-client. Use getPasswordResetPath() / getGoogleReturnTarget()
  PASSWORD_RESET_PATH: process.env.PASSWORD_RESET_PATH || '',
  GOOGLE_AUTH_DEEP_LINK: process.env.GOOGLE_AUTH_DEEP_LINK || '',

  // ── Multi-client resolution functions (B7 fix) ────────────
  getPasswordResetPath,
  getGoogleReturnTarget,
  RESET_PATH_ALLOW_LIST,
  GOOGLE_RETURN_ALLOW_LIST,
  resetPaths,
  googleReturnTargets,
};
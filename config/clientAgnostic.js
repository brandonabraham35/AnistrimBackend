// config/clientAgnostic.js
// Central configuration for making the API client-agnostic (presentation-decoupling).
//
// These settings let operators control how the backend behaves without forcing
// any particular client UI. They are read by the auth/payment/watch controllers
// and by server.js for the static-frontend serving migration flag.
require('dotenv').config();

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true' || value === '1';
}

// Static-serving defaults. A single all-or-nothing flag (SERVE_STATIC_FRONTEND)
// remains the legacy control; granular SERVE_FRONTEND / SERVE_ADMIN default to
// it so local dev keeps serving both while production can disable each.
const serveStatic = bool(process.env.SERVE_STATIC_FRONTEND, true);
const serveFrontend = bool(process.env.SERVE_FRONTEND, serveStatic);
const serveAdmin = bool(process.env.SERVE_ADMIN, serveStatic);

module.exports = {
  SERVE_FRONTEND: serveFrontend,
  SERVE_ADMIN: serveAdmin,
  // ── Password reset ──────────────────────────────────────────
  // The destination URI a client should use to render the password-reset form.
  // Clients can override per-request via `?resetPath=` on /forgot-password.
  // The backend never hardcodes a presentation-specific page name.
  PASSWORD_RESET_PATH: process.env.PASSWORD_RESET_PATH || '',

  // ── Google OAuth result delivery ────────────────────────────
  // For client-agnostic OAuth, the API can return the short-lived login code
  // as JSON (when ?client=api) with a suggested deep link the client can use
  // to return to the native app. Defaults to the current APP_SCHEME deep link
  // so the existing mobile flow keeps working.
  GOOGLE_AUTH_DEEP_LINK: process.env.GOOGLE_AUTH_DEEP_LINK || '',

  // ── Static frontend serving (migration) ─────────────────────
  // API-only mode: `SERVE_STATIC_FRONTEND=false` disables serving both
  // Frontend/ and AdminDashboard/. This is the target state for deploying the
  // API and frontends independently. SERVE_FRONTEND / SERVE_ADMIN override
  // per-component.

  // Backward-compatible alias for the all-or-nothing flag.
  SERVE_STATIC_FRONTEND: serveStatic,

  // Which directories to serve when static serving is enabled (dev convenience).
  FRONTEND_DIR: process.env.FRONTEND_DIR || 'Frontend',
  ADMIN_DIR: process.env.ADMIN_DIR || 'AdminDashboard',
};
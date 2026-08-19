/**
 * backend-url.js — SINGLE shared backend-URL helper for the Admin Dashboard.
 *
 * Replaces the three hardcoded URL blocks that used to live in
 * AdminDashboard/js/api.js, AdminDashboard/js/auth.js and the Google auth
 * handler. Load this file FIRST (before api.js / google-auth-handler.js /
 * auth.js) in every AdminDashboard HTML page.
 *
 * Resolution:
 *   • localhost / 127.0.0.1  → http://localhost:5000 (local dev backend)
 *   • everything else        → https://anistrimbackend.onrender.com (Render)
 *
 * It also exposes the standard window.getApiBaseUrl() alias (only if not
 * already defined) so shared Frontend modules such as google-auth-handler.js
 * resolve the correct backend on admin pages without loading Frontend/config.js.
 */
(function () {
  'use strict';

  var PROD_BACKEND_URL = 'https://anistrimbackend.onrender.com';
  var LOCAL_BACKEND_URL = 'http://localhost:5000';

  function getAdminBackendUrl() {
    var host = '';
    try {
      host = window.location.hostname;
    } catch (e) { /* non-browser context */ }
    if (host === 'localhost' || host === '127.0.0.1') {
      return LOCAL_BACKEND_URL;
    }
    return PROD_BACKEND_URL;
  }

  // Primary admin helper.
  window.getAdminBackendUrl = getAdminBackendUrl;

  // Standard alias used by shared Frontend modules (google-auth-handler.js).
  // Never override an existing implementation (e.g. Frontend/config.js).
  if (typeof window.getApiBaseUrl !== 'function') {
    window.getApiBaseUrl = getAdminBackendUrl;
  }
})();
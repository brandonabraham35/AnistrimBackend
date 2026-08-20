/* eslint-env browser */
// AniStrim Web — environment config (independent from Frontend/)
// Implements the AniStrim API contract from docs/client-integration-spec.md.
(function () {
  'use strict';

  var API_BASE = 'https://anistrimbackend.onrender.com';

  // B3 (review) fix — resolve the API base in priority order:
  //   (a) window.__ANISTRIM_API — explicit override ('' => same-origin relative)
  //   (b) <meta name="anistrim-api">      — server/meta injection
  //   (c) fallback to the built-in production backend URL
  // A same-origin relative ('') base makes Web served from the backend hit
  // /api/* with zero CORS (and is how local dev works).
  function getApiBaseUrl() {
    if (typeof window !== 'undefined' && typeof window.__ANISTRIM_API !== 'undefined') {
      return String(window.__ANISTRIM_API === null ? '' : window.__ANISTRIM_API).replace(/\/+$/, '');
    }
    try {
      var meta = document.querySelector('meta[name="anistrim-api"]');
      if (meta && meta.content) return meta.content.trim().replace(/\/+$/, '');
    } catch (e) { /* non-browser / no document */ }
    return API_BASE;
  }

  window.AniStrimConfig = {
    API_BASE: API_BASE,
    getApiBaseUrl: getApiBaseUrl,
    APP_NAME: 'AniStrim',
    CLIENT: 'web',
  };
})();

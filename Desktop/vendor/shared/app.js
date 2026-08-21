// shared/client-contract/app.js
// Boot helper for all non-visual clients (desktop, web SPA).
// Creates a fully-configured HTTP client + session in one call.
// ES5-safe IIFE for use in all clients (mobile, web, desktop, admin).
//
// Usage:
//   <script src="/shared/client-contract/endpoints.js"></script>
//   <script src="/shared/client-contract/envelope.js"></script>
//   <script src="/shared/client-contract/session.js"></script>
//   <script src="/shared/client-contract/http.js"></script>
//   <script src="/shared/client-contract/app.js"></script>
//   var app = AniStrimClient.create({ apiBase, client: 'desktop' });

/* eslint-disable no-undef */
(function (root) {
  'use strict';

  /**
   * Create a fully wired client (session + http) for the given client id.
   * @param {object} opts - { apiBase, client, onUnauthorized?, onRequiresVerification? }
   * @returns {object} { session, http }
   */
  function create(opts) {
    opts = opts || {};
    var apiBase = opts.apiBase || '';
    var client = opts.client || 'web';

    var session = root.AniStrimSession.create(client);
    var http = root.AniStrimHttp.create({
      apiBase: apiBase,
      client: client,
      session: session,
      onUnauthorized: opts.onUnauthorized || function () {},
      onRequiresVerification: opts.onRequiresVerification || function () {},
    });

    return { session: session, http: http };
  }

  // Export for browser (IIFE) and CommonJS (tests)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { create: create };
  } else {
    root.AniStrimClient = { create: create };
  }
})(typeof window !== 'undefined' ? window : this);
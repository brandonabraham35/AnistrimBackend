// shared/client-contract/session.js
// Client-scoped token storage with legacy key migration.
// Fixes B8: mobile (anistrim.mobile.*) and web (anistrim.web.*) sessions
// no longer collide when served from the same origin.
//
// ES5-safe IIFE for use in all clients (mobile, web, desktop, admin).
//
// Usage:
//   <script src="/shared/client-contract/session.js"></script>
//   var session = AniStrimSession.create('mobile');

/* eslint-disable no-undef */
(function (root) {
  'use strict';

  // Client-scoped key prefixes
  var PREFIXES = {
    mobile: 'anistrim.mobile.',
    web: 'anistrim.web.',
    desktop: 'anistrim.desktop.',
    admin: 'anistrim.admin.',
  };

  // Legacy key names to migrate from (B8 fix)
  var LEGACY_KEYS = {
    token: 'token',
    refreshToken: 'refresh_token',
    sessionToken: 'session_token',
    webToken: 'web_token',
    webRefreshToken: 'web_refresh_token',
  };

  /**
   * Create a client-scoped session manager.
   * @param {string} client - client identifier: mobile|web|desktop|admin
   * @param {object} [storage] - storage implementation (defaults to localStorage)
   */
  function create(client, storage) {
    var prefix = PREFIXES[client] || PREFIXES.web;
    var store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) {
      // In-memory fallback for non-browser environments (Electron main, tests)
      var mem = {};
      store = {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; },
      };
    }

    function key(name) { return prefix + name; }

    // ── Legacy migration ────────────────────────────────────
    // Reads legacy keys once and migrates to client-scoped keys.
    // This keeps existing users logged in after the B8 fix.
    function migrateLegacy() {
      var migrated = false;
      var legacy = null;

      if (client === 'mobile') {
        // Mobile legacy: token / refresh_token / session_token
        var legacyToken = store.getItem(LEGACY_KEYS.token);
        var legacyRefresh = store.getItem(LEGACY_KEYS.refreshToken);
        if (legacyToken) {
          legacy = { token: legacyToken, refreshToken: legacyRefresh || '' };
        } else {
          var legacySession = store.getItem(LEGACY_KEYS.sessionToken);
          if (legacySession) legacy = { token: legacySession, refreshToken: legacyRefresh || '' };
        }
        if (legacy) {
          store.setItem(key('token'), legacy.token);
          if (legacy.refreshToken) store.setItem(key('refreshToken'), legacy.refreshToken);
          // Remove legacy keys after migration
          store.removeItem(LEGACY_KEYS.token);
          store.removeItem(LEGACY_KEYS.refreshToken);
          store.removeItem(LEGACY_KEYS.sessionToken);
          migrated = true;
        }
      } else if (client === 'web') {
        // Web legacy: web_token / web_refresh_token
        var webToken = store.getItem(LEGACY_KEYS.webToken);
        var webRefresh = store.getItem(LEGACY_KEYS.webRefreshToken);
        if (webToken) {
          store.setItem(key('token'), webToken);
          if (webRefresh) store.setItem(key('refreshToken'), webRefresh);
          store.removeItem(LEGACY_KEYS.webToken);
          store.removeItem(LEGACY_KEYS.webRefreshToken);
          migrated = true;
        }
      }
      // Mark migration complete to avoid running again
      store.setItem(key('migrated'), '1');
      return migrated;
    }

    // Run migration on first access if not already done
    if (!store.getItem(key('migrated'))) {
      migrateLegacy();
    }

    return {
      /**
       * Get the stored access token.
       */
      getToken: function () {
        return store.getItem(key('token')) || '';
      },

      /**
       * Get the stored refresh token.
       */
      getRefreshToken: function () {
        return store.getItem(key('refreshToken')) || '';
      },

      /**
       * Store tokens.
       * @param {string} token - access token
       * @param {string} [refreshToken] - refresh token
       */
      setTokens: function (token, refreshToken) {
        if (token) store.setItem(key('token'), token);
        if (refreshToken) store.setItem(key('refreshToken'), refreshToken);
      },

      /**
       * Clear all tokens for this client.
       */
      clear: function () {
        store.removeItem(key('token'));
        store.removeItem(key('refreshToken'));
        store.removeItem(key('migrated'));
      },

      /**
       * Check if the user has a stored session.
       */
      hasSession: function () {
        return !!store.getItem(key('token'));
      },

      /**
       * Get the raw storage adapter (for advanced use).
       */
      storage: store,

      /**
       * Get the key prefix for this client.
       */
      prefix: prefix,
    };
  }

  // Export for browser (IIFE) and CommonJS (tests)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { create: create, PREFIXES: PREFIXES };
  } else {
    root.AniStrimSession = { create: create, PREFIXES: PREFIXES };
  }
})(typeof window !== 'undefined' ? window : this);
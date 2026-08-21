// shared/client-contract/endpoints.js
// SINGLE source of truth for all API endpoint paths.
// Generated from docs/client-integration-spec.md — do not edit manually.
// ES5-safe IIFE for use in all clients (mobile, web, desktop, admin).
//
// Usage:
//   <script src="/shared/client-contract/endpoints.js"></script>
//   var path = AniStrimEndpoints.auth.login; // '/api/auth/login'

/* eslint-disable no-undef */
(function (root) {
  'use strict';

  var endpoints = {
    // ── Health ──────────────────────────────────────────────
    health: '/api/health',

    // ── Authentication ──────────────────────────────────────
    auth: {
      signup: '/api/auth/signup',
      login: '/api/auth/login',
      verifyOtp: '/api/auth/verify-otp',
      resendOtp: '/api/auth/resend-otp',
      forgotPassword: '/api/auth/forgot-password',
      resetPassword: '/api/auth/reset-password',
      setPassword: '/api/auth/set-password',
      me: '/api/auth/me',
      logout: '/api/auth/logout',
      logoutAll: '/api/auth/logout-all',
      sessions: '/api/auth/sessions',
      sessionById: function (id) { return '/api/auth/sessions/' + encodeURIComponent(id); },
      changePassword: '/api/auth/change-password',
      changeEmail: '/api/auth/change-email',
      changeEmailConfirm: '/api/auth/change-email/confirm',
      deactivate: '/api/auth/account/deactivate',
      delete: '/api/auth/account/delete',
      refresh: '/api/auth/refresh',
      google: {
        clientId: '/api/auth/google/client-id',
        verify: '/api/auth/google/verify',
        signup: '/api/auth/google/signup',
        start: '/api/auth/google/start',
        callback: '/api/auth/google/callback',
        token: '/api/auth/google/token',
      },
    },

    // ── Profile / Onboarding ────────────────────────────────
    profile: {
      usernameAvailable: '/api/profile/username-available',
      setUsername: '/api/profile/set-username',
      onboarding: '/api/profile/onboarding',
      preferences: '/api/profile/preferences',
      history: '/api/profile/history',
      avatar: '/api/auth/avatar',
    },

    // ── Catalogue ───────────────────────────────────────────
    anime: {
      trending: '/api/anime/trending',
      latest: '/api/anime/latest',
      recent: '/api/anime/recent',
      popular: '/api/anime/popular',
      featured: '/api/anime/featured',
      search: '/api/anime/search',
      genres: '/api/anime/genres',
      searchAdvanced: '/api/anime/search/advanced',
      recommendations: function (id) { return '/api/anime/recommendations/' + encodeURIComponent(id); },
      byId: function (id) { return '/api/anime/' + encodeURIComponent(id); },
      episodes: function (id) { return '/api/anime/' + encodeURIComponent(id) + '/episodes'; },
    },

    // ── Home ────────────────────────────────────────────────
    home: {
      sections: '/api/home/sections',
      recommendations: '/api/home/recommendations',
    },

    // ── Watchlist / Progress ────────────────────────────────
    watchlist: {
      list: '/api/watchlist',
      add: '/api/watchlist/add',
      continueWatching: '/api/watchlist/continue',
      stats: '/api/watchlist/stats',
      progress: '/api/watchlist/progress',
      remove: function (animeId) { return '/api/watchlist/' + encodeURIComponent(animeId); },
    },

    watch: {
      progress: '/api/watch/progress',
      progressByEpisode: function (episodeId) { return '/api/watch/progress/' + encodeURIComponent(episodeId); },
      markers: function (episodeId) { return '/api/watch/markers/' + encodeURIComponent(episodeId); },
      continueWatching: '/api/watch/continue-watching',
      continueRemove: function (animeId) { return '/api/watch/continue-watching/' + encodeURIComponent(animeId); },
      history: '/api/watch/history',
      next: function (animeId, currentEp) { return '/api/watch/next/' + encodeURIComponent(animeId) + '/' + encodeURIComponent(currentEp); },
      skipTimes: function (malId, epNum) { return '/api/watch/skip-times/' + encodeURIComponent(malId) + '/' + encodeURIComponent(epNum); },
      progressBatch: function (animeId) { return '/api/watch/progress/batch/' + encodeURIComponent(animeId); },
      restart: function (animeId) { return '/api/watch/restart/' + encodeURIComponent(animeId); },
    },

    // ── Streaming ───────────────────────────────────────────
    stream: {
      authorize: '/api/stream/authorize',
      byTitleEpisode: function (title, ep) { return '/api/stream/' + encodeURIComponent(title) + '/' + encodeURIComponent(ep); },
      providers: '/api/stream/providers',
      offlineDownload: '/api/stream/offline-download',
    },

    // ── Payments ────────────────────────────────────────────
    payments: {
      checkout: '/api/payments/checkout',
      verifySubscription: '/api/payments/verify-subscription',
      callback: '/api/payments/callback',
      cancel: '/api/payments/cancel',
      webhook: '/api/payments/webhook',
    },

    // ── Ads ─────────────────────────────────────────────────
    ads: {
      config: '/api/ads/config',
      event: '/api/ads/event',
    },

    // ── Reports ─────────────────────────────────────────────
    reports: {
      submit: '/api/reports',
    },

    // ── Download ────────────────────────────────────────────
    download: {
      request: '/api/download/request',
    },
  };

  // Export for browser (IIFE) and CommonJS (tests)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = endpoints;
  } else {
    root.AniStrimEndpoints = endpoints;
  }
})(typeof window !== 'undefined' ? window : this);
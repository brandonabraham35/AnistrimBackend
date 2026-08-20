/* eslint-env browser */
// AniStrim Web — API client (independent from Frontend/)
// Implements the AniStrim API contract from docs/client-integration-spec.md.
(function () {
  'use strict';

  var CONFIG = window.AniStrimConfig;
  var API = CONFIG.getApiBaseUrl();
  var TOKEN_KEY = 'web_token';
  var REFRESH_KEY = 'web_refresh_token';
  var refreshPromise = null;

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function getRefreshToken() { return localStorage.getItem(REFRESH_KEY) || ''; }
  function setTokens(token, refresh) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
  }
  function clearTokens() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
  }

  // Unwrap the { success, data, meta } or { success, error } envelope.
  function unwrap(body) {
    if (!body || typeof body !== 'object') return body;
    if (body.success === true) return body.data !== undefined ? body.data : body;
    if (body.success === false && body.error) {
      var err = new Error((body.error.message) || 'Request failed');
      err.code = body.error.code;
      err.status = body.error.status || 0;
      err.details = body.error.details;
      err.requestId = body.error.requestId;
      throw err;
    }
    return body;
  }

  // Single-flight refresh.
  function doRefresh() {
    var refresh = getRefreshToken();
    if (!refresh) return Promise.resolve(null);
    return fetch(API + '/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refresh }),
    }).then(function (r) { return r.json(); })
      .then(function (body) { return unwrap(body); })
      .then(function (data) {
        if (!data || !data.token) return null;
        setTokens(data.token, data.refreshToken || refresh);
        return data;
      }).catch(function () { return null; });
  }
  function refreshOnce() {
    if (!refreshPromise) {
      refreshPromise = doRefresh().finally(function () { refreshPromise = null; });
    }
    return refreshPromise;
  }

  async function request(path, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    var body = options.body;
    var isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    var isUrlEncoded = typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams;
    if (!isFormData && !isUrlEncoded && body !== undefined && typeof body !== 'string') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    var token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    var res = await fetch(API + path, {
      method: options.method || 'GET',
      headers: headers,
      body: body,
      credentials: options.credentials || 'same-origin',
    });
    var text = await res.text();
    var data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) { /* non-JSON */ }

    if (res.status === 401 && getRefreshToken() && options._retried !== true) {
      var refreshed = await refreshOnce();
      if (refreshed && refreshed.token) {
        return request(path, Object.assign({}, options, {
          _retried: true,
          headers: Object.assign({}, options.headers, { 'Authorization': 'Bearer ' + refreshed.token }),
        }));
      }
    }
    if (res.status === 401) {
      clearTokens();
      var unauthorizedError = new Error('Session expired. Please sign in again.');
      unauthorizedError.code = 'UNAUTHORIZED';
      unauthorizedError.status = 401;
      throw unauthorizedError;
    }
    if (!res.ok) {
      var payload = data && data.error ? data.error : data;
      var msg = (payload && payload.message) || ('Request failed with status ' + res.status);
      var e = new Error(msg);
      e.code = (payload && payload.code) || ('HTTP_' + res.status);
      e.status = res.status;
      e.details = (payload && payload.details) || null;
      throw e;
    }
    return unwrap(data);
  }

  window.AniStrimApi = {
    get API_BASE() { return API; },
    getToken: getToken,
    getRefreshToken: getRefreshToken,
    setTokens: setTokens,
    clearTokens: clearTokens,
    request: request,

    // Auth
    login: function (email, password) { return request('/api/auth/login', { method: 'POST', body: { email: email, password: password } }); },
    signup: function (payload) { return request('/api/auth/signup', { method: 'POST', body: payload }); },
    verifyEmail: function (email, otp) { return request('/api/auth/verify-email', { method: 'POST', body: { email: email, otp: otp } }); },
    resendOtp: function (email) { return request('/api/auth/resend-otp', { method: 'POST', body: { email: email } }); },
    me: function () { return request('/api/auth/me'); },
    logout: function () { return request('/api/auth/logout', { method: 'POST' }); },
    logoutAll: function () { return request('/api/auth/logout-all', { method: 'POST' }); },
    googleVerify: function (idToken) { return request('/api/auth/google/verify', { method: 'POST', body: { idToken: idToken } }); },
    googleSignup: function (idToken) { return request('/api/auth/google/signup', { method: 'POST', body: { idToken: idToken } }); },
    googleClientId: function () { return request('/api/auth/google/client-id'); },

    // Profile
    profileSetUsername: function (username) { return request('/api/profile/set-username', { method: 'POST', body: { username: username } }); },
    profileOnboarding: function (data) { return request('/api/profile/onboarding', { method: 'POST', body: data }); },
    profilePreferences: function () { return request('/api/profile/preferences'); },
    profileUpdatePreferences: function (prefs) { return request('/api/profile/preferences', { method: 'PUT', body: prefs }); },
    uploadAvatar: function (file) {
      var fd = new FormData();
      fd.append('avatar', file);
      return request('/api/auth/avatar', { method: 'POST', body: fd });
    },

    // Anime
    homeSections: function () { return request('/api/home/sections'); },
    trending: function () { return request('/api/anime/trending'); },
    latest: function () { return request('/api/anime/latest?limit=20'); },
    popular: function () { return request('/api/anime/popular'); },
    genres: function () { return request('/api/anime/genres'); },
    search: function (q, filters) {
      var params = new URLSearchParams();
      if (q) params.set('q', q);
      if (filters) Object.keys(filters).forEach(function (k) { if (filters[k]) params.set(k, filters[k]); });
      return request('/api/anime/search?' + params.toString());
    },
    anime: function (id) { return request('/api/anime/' + id); },
    episodes: function (id) { return request('/api/anime/' + id + '/episodes'); },
    recommendations: function (id) { return request('/api/anime/recommendations/' + id); },

    // Watch
    continueWatching: function () { return request('/api/watch/continue-watching'); },
    watchHistory: function (page, perPage) {
      var p = new URLSearchParams();
      p.set('page', page || 1); p.set('perPage', perPage || 20);
      return request('/api/watch/history?' + p.toString());
    },
    clearHistory: function () { return request('/api/watch/history', { method: 'DELETE' }); },
    saveProgress: function (episodeId, positionSec, durationSec) {
      return request('/api/watch/progress', { method: 'PUT', body: { episodeId: episodeId, positionSec: positionSec, durationSec: durationSec } });
    },
    getEpisodeProgress: function (episodeId) { return request('/api/watch/progress/' + episodeId); },

    // Watchlist
    watchlist: function () { return request('/api/watchlist'); },
    watchlistStats: function () { return request('/api/watchlist/stats'); },
    addWatchlist: function (animeId) { return request('/api/watchlist', { method: 'POST', body: { animeId: animeId } }); },
    removeWatchlist: function (animeId) { return request('/api/watchlist/' + animeId, { method: 'DELETE' }); },
    toggleWatchlist: function (animeId) { return request('/api/watchlist/' + animeId, { method: 'POST' }); },

    // Streaming
    getStream: function (title, episodeNum, preferredProvider) {
      var url = '/api/stream/' + encodeURIComponent(title) + '/' + episodeNum;
      if (preferredProvider) url += '?preferredProvider=' + encodeURIComponent(preferredProvider);
      return request(url);
    },
    authorizeStream: function (episodeId) {
      return request('/api/stream/authorize', { method: 'POST', body: { episodeId: String(episodeId) } });
    },
    providers: function (title, episodeNum) { return request('/api/stream/providers/' + encodeURIComponent(title) + '/' + episodeNum); },

    // Payments
    checkout: function (plan) { return request('/api/payments/checkout', { method: 'POST', body: { plan: plan } }); },
    verifySubscription: function (ref) { return request('/api/payments/verify-subscription?reference=' + encodeURIComponent(ref)); },
  };
})();
// Frontend/js/api.js — single API wrapper for all frontend auth calls.
// Uses the API base URL exposed by config.js (window.getApiBaseUrl).
// Attaches Authorization (JWT) when present, parses JSON once, and handles
// 403 (requiresVerification), 401 (auto-refresh), and 429 (rate limited)
// globally. Throws ApiError otherwise.
//
// Must be loaded AFTER config.js/scrpt.js so it overrides window.apiFetch
// with this canonical version.

(function () {
  'use strict';

  var API_BASE = (typeof window.getApiBaseUrl === 'function')
    ? window.getApiBaseUrl()
    : 'https://anistrimbackend.onrender.com';

  var REFRESH_KEY = 'refresh_token';
  var TOKEN_KEY = 'token';
  var SESSION_KEY = 'session_token';

  // Single-flight refresh promise so parallel 401s don't double-rotate.
  var refreshPromise = null;

  function ApiError(message, status, data) {
    this.message = message || 'Request failed';
    this.status = status || 0;
    this.data = data || null;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || localStorage.getItem(SESSION_KEY) || '';
  }

  function getRefreshToken() {
    return localStorage.getItem(REFRESH_KEY) || '';
  }

  function setTokens(token, refreshToken) {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(SESSION_KEY, token);
    }
    if (refreshToken) {
      localStorage.setItem(REFRESH_KEY, refreshToken);
    }
  }

  function clearTokens() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(REFRESH_KEY);
  }

  // ── Centralized post-authentication redirect ─────────────
  // Single source of truth for where the app goes after a successful
  // login/signup/OTP. Commits token + user atomically through Auth.save so the
  // session (including the admin role) is fully written to localStorage BEFORE
  // any navigation — the WebView writes storage slower than the browser, and a
  // hard redirect before the session is settled is exactly what caused the
  // "login -> lands nowhere" loop.
  //
  // Phase 1 (Item 15): delegates the destination decision to the canonical
  // Navigation.afterAuth contract (Frontend/js/navigation.js), which sanitizes
  // the redirect param, handles emailVerified/onboarded/status, and uses
  // location.replace() so the back-button can't return to the login page.
  // Callers must RETURN immediately after calling this.
  function redirectAfterAuthentication(user, token, refreshToken) {
    var tok = token || (window.Auth ? window.Auth.token : '') || localStorage.getItem(TOKEN_KEY) || '';
    if (window.Auth) {
      if (tok && user) window.Auth.save(tok, user);
      else if (user) window.Auth.setUser(user);
    } else {
      if (tok) localStorage.setItem(TOKEN_KEY, tok);
      if (user) localStorage.setItem('user', JSON.stringify(user));
    }
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
    sessionStorage.removeItem('pendingEmail');
    sessionStorage.removeItem('otpEmailSent');
    localStorage.removeItem('pendingEmail');
    // One-shot guard so scrpt.js's "logged in -> index" gate can't stomp this.
    sessionStorage.setItem('__authRedirecting', '1');
    // Fresh session => fresh redirect budget.
    try { window.NavGuard && window.NavGuard.reset(); } catch (e) {}
    // Delegate to the canonical navigation contract.
    var redirectParam = new URLSearchParams(window.location.search).get('redirect');
    if (window.Navigation && window.Navigation.afterAuth) {
      window.Navigation.afterAuth(user, redirectParam);
    } else {
      var dest = (user && user.isAdmin) ? '/admin.html' : '/index.html';
      window.location.replace(dest);
    }
  }
  window.redirectAfterAuthentication = redirectAfterAuthentication;

  // ── Single-flight refresh ─────────────────────────────────
  // Calls POST /api/auth/refresh once. Parallel 401s share the same promise.
  function doRefresh() {
    var refreshToken = getRefreshToken();
    if (!refreshToken) return Promise.resolve(null);
    return fetch(API_BASE + '/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refreshToken })
    }).then(function (res) {
      if (!res.ok) return null;
      return res.json().catch(function () { return null; });
    }).then(function (data) {
      if (!data || !data.token) return null;
      setTokens(data.token, data.refreshToken || refreshToken);
      return data;
    }).catch(function () { return null; });
  }

  function refreshOnce() {
    if (!refreshPromise) {
      refreshPromise = doRefresh().finally(function () {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  }

  async function apiFetch(path, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    var body = options.body;
    var isFormData = (typeof FormData !== 'undefined') && (body instanceof FormData);
    if (!isFormData && !(body instanceof URLSearchParams)) {
      headers['Content-Type'] = 'application/json';
      if (body && typeof body !== 'string') {
        body = JSON.stringify(body);
      }
    }
    var token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    var res;
    try {
      res = await fetch(API_BASE + path, {
        method: options.method || 'GET',
        headers: headers,
        body: body || undefined
      });
    } catch (e) {
      throw new ApiError('Cannot reach server. Please check your connection.', 0);
    }

    var data = {};
    try {
      data = await res.json();
    } catch (e) {
      data = {};
    }

    // ── 401: try to refresh once, then replay the request ──
    if (res.status === 401 && getRefreshToken() && options._retried !== true) {
      var refreshed = await refreshOnce();
      if (refreshed && refreshed.token) {
        // Replay the original request with the new token.
        var retryOptions = Object.assign({}, options, { _retried: true });
        retryOptions.headers = Object.assign({}, options.headers || {});
        retryOptions.headers['Authorization'] = 'Bearer ' + refreshed.token;
        return apiFetch(path, retryOptions);
      }
    }

    if (res.status === 401) {
      // Refresh failed or no refresh token — clear centralized auth state.
      clearTokens();
      if (window.Auth) window.Auth.clear();
      else { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(SESSION_KEY); }
      if (options.global401Redirect !== false && options.skipAuthRedirect !== true) {
        window.location.href = 'login.html';
      }
      return data;
    }

    if (res.status === 429 && data && data.code === 'RATE_LIMITED') {
      // Rate limited — surface the cooldown to the caller.
      var err = new ApiError(data.message || 'Too many requests.', 429, data);
      err.retryAfter = data.retryAfter || 60;
      throw err;
    }

    if (res.status === 403 && data && data.requiresVerification === true) {
      var email = data.email || '';
      if (email) {
        sessionStorage.setItem('pendingEmail', email);
        localStorage.setItem('pendingEmail', email);
      }
      // Best-effort: request a fresh code so the user lands on a valid OTP.
      // Ignore failures (throttle / offline) - the OTP page still loads.
      if (options.resendOtp !== false && email) {
        try {
          await fetch(API_BASE + '/api/auth/resend-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email })
          });
        } catch (e) { /* ignore */ }
      }
      var q = email ? ('?email=' + encodeURIComponent(email)) : '';
      window.location.href = 'verify-otp.html' + q;
      return data;
    }

    if (!res.ok) {
      throw new ApiError((data && data.message) || 'Request failed', res.status, data);
    }

    return data;
  }

  window.apiFetch = apiFetch;
  window.ApiError = ApiError;
  window.setAuthTokens = setTokens;
  window.clearAuthTokens = clearTokens;
})();
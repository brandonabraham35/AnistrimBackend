// Frontend/js/api.js — single API wrapper for all frontend auth calls.
// Uses the API base URL exposed by config.js (window.getApiBaseUrl).
// Attaches Authorization (JWT) when present, parses JSON once, and handles
// 403 (requiresVerification) and 401 globally. Throws ApiError otherwise.
//
// Must be loaded AFTER config.js/scrpt.js so it overrides window.apiFetch
// with this canonical version.

(function () {
  'use strict';

  var API_BASE = (typeof window.getApiBaseUrl === 'function')
    ? window.getApiBaseUrl()
    : 'https://anistrimbackend.onrender.com';

  function ApiError(message, status, data) {
    this.message = message || 'Request failed';
    this.status = status || 0;
    this.data = data || null;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  function getToken() {
    return localStorage.getItem('token') || localStorage.getItem('session_token') || '';
  }

  // ── Centralized post-authentication redirect ─────────────
  // Single source of truth for where the app goes after a successful
  // login/signup/OTP. Commits token + user atomically through Auth.save so the
  // session (including the admin role) is fully written to localStorage BEFORE
  // any navigation — the WebView writes storage slower than the browser, and a
  // hard redirect before the session is settled is exactly what caused the
  // "login -> lands nowhere" loop. Admin routes to admin.html (whose gate
  // re-verifies the role via /api/auth/me), everyone else -> index.html.
  // Callers must RETURN immediately after calling this.
  function redirectAfterAuthentication(user, token) {
    var tok = token || (window.Auth ? window.Auth.token : '') || localStorage.getItem('token') || '';
    if (window.Auth) {
      if (tok && user) window.Auth.save(tok, user);
      else if (user) window.Auth.setUser(user);
    } else {
      if (tok) localStorage.setItem('token', tok);
      if (user) localStorage.setItem('user', JSON.stringify(user));
    }
    sessionStorage.removeItem('pendingEmail');
    sessionStorage.removeItem('otpEmailSent');
    localStorage.removeItem('pendingEmail');
    // One-shot guard so scrpt.js's "logged in -> index" gate can't stomp this.
    sessionStorage.setItem('__authRedirecting', '1');
    // Resolve destination from the settled user object (server-authoritative
    // isAdmin at login time). admin.html's own gate will re-confirm the role.
    var dest = (user && user.isAdmin) ? 'admin.html' : 'index.html';
    window.location.replace(dest);
  }
  window.redirectAfterAuthentication = redirectAfterAuthentication;

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

    if (res.status === 401) {
      // Clear centralized auth state. Only force logout for auth-critical
      // requests; background calls pass skipAuthRedirect/global401Redirect:false
      // so a 401 there (watch progress, optional analytics) never logs them out.
      if (window.Auth) window.Auth.clear();
      else { localStorage.removeItem('token'); localStorage.removeItem('session_token'); }
      if (options.global401Redirect !== false && options.skipAuthRedirect !== true) {
        window.location.href = 'login.html';
      }
      return data;
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
})();
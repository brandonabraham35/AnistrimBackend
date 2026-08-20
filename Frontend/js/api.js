// Frontend/js/api.js — SINGLE canonical apiFetch for the whole frontend.
// This is the ONLY place apiFetch is defined. It returns a non-throwing
// envelope { ok, status, data } on every path so callers never need try/catch
// for HTTP status codes. It also:
//   • sets Content-Type: application/json unless body is FormData/URLSearchParams
//   • attaches Authorization (JWT) when present
//   • parses JSON once
//   • handles 403 (requiresVerification → OTP screen)
//   • handles 401 (auto-refresh once, then replay; else clear + login.html)
//   • handles 429 (RATE_LIMITED) by throwing ApiError (callers that opt in read
//     err.retryAfter)
//   • honors { timeout } by aborting the fetch and returning timedOut:true
//
// LOAD ORDER: must load AFTER config.js and scrpt.js so it overrides the thin
// deferred config.js apiFetch. No later script may reassign window.apiFetch —
// a dev-only guard at the bottom warns if anything tries.

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
    }).then(function (body) {
      // Support BOTH the legacy raw body ({ token }) and the standardized
      // envelope ({ success:true, data:{ token } }) for the refresh endpoint.
      var data = (body && body.success === true && body.data) ? body.data : body;
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

  // ── THE single apiFetch ───────────────────────────────────
  // Returns { ok, status, data, timedOut? } on every path except 429
  // (RATE_LIMITED), which throws ApiError with .retryAfter. Pages read the
  // envelope — never the raw body — so there is exactly ONE return contract.
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

    // ── Bounded request timeout ─────────────────────────────
    // watch.js / the player pass { timeout } and rely on timedOut to avoid
    // hanging the UI on a stalled request. Abort and surface timedOut.
    var abortCtrl = (typeof AbortController !== 'undefined' && options.timeout)
      ? new AbortController()
      : null;
    var timeoutId = null;
    if (abortCtrl) {
      timeoutId = setTimeout(function () { abortCtrl.abort(); }, options.timeout);
    }

    var res;
    try {
      res = await fetch(API_BASE + path, {
        method: options.method || 'GET',
        headers: headers,
        body: body || undefined,
        ...(abortCtrl ? { signal: abortCtrl.signal } : {})
      });
    } catch (e) {
      if (timeoutId) clearTimeout(timeoutId);
      var aborted = !!(e && (e.name === 'AbortError' || /abort|timeout/i.test(e.message || '')));
      return { ok: false, status: 0, data: {}, timedOut: aborted };
    }
    if (timeoutId) clearTimeout(timeoutId);

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
      return { ok: false, status: 401, data: data };
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
      return { ok: false, status: 403, data: data };
    }

    // Envelope on success AND any other failure — pages never need try/catch
    // for HTTP status.
    return unwrapEnvelope({ ok: res.ok, status: res.status, data: data });
  }

  // ── Response envelope compatibility shim ──────────────────
  // The backend standardized SUCCESS responses to
  //   { success:true, data:{...}, meta:{...} }
  // (see utils/response.js). To keep every existing page reading
  // `result.data.<field>` working unchanged, we unwrap the inner payload back
  // into `result.data`, and merge `meta` (e.g. pagination) alongside it so
  // list consumers still see `result.data.rows` / `result.data.pagination`.
  // Errors (no `data` key / `success:false`) and any response that does NOT
  // use the envelope (plain arrays / objects) pass through untouched, so
  // unmigrated endpoints keep working exactly as before.
  function unwrapEnvelope(envelope) {
    if (!envelope || !envelope.data || typeof envelope.data !== 'object') {
      return envelope;
    }
    var body = envelope.data;
    // Paginated list: { success, data:[...], meta:{pagination} } — expose
    // items + pagination at the top level of `data` so `result.data.items`
    // and `result.data.pagination` both work, plus `result.data.rows` alias.
    // This must be checked BEFORE the single-resource branch so arrays are not
    // coerced through the object path.
    if (body.success === true &&
        Object.prototype.hasOwnProperty.call(body, 'data') &&
        Array.isArray(body.data)) {
      var arr = body.data;
      return {
        ok: envelope.ok,
        status: envelope.status,
        data: Object.assign({ items: arr, rows: arr }, body.meta),
      };
    }
    // Only unwrap when the backend actually used the standard envelope.
    if (body.success === true && Object.prototype.hasOwnProperty.call(body, 'data')) {
      var inner = body.data;
      var result = (typeof inner === 'object' && inner !== null) ? Object.assign({}, inner) : inner;
      if (body.meta && typeof body.meta === 'object' && result !== null && typeof result === 'object') {
        result = Object.assign(result, body.meta);
      }
      if (result === null || result === undefined) result = {};
      return { ok: envelope.ok, status: envelope.status, data: result };
    }
    return envelope;
  }

  window.apiFetch = apiFetch;
  window.ApiError = ApiError;
  window.setAuthTokens = setTokens;
  window.clearAuthTokens = clearTokens;
  // Marker so config.js's thin delegate can detect that the canonical
  // implementation is installed (config.js can't compare function identity
  // because it assigns window.apiFetch = shared.apiFetch at load time).
  window.__CANONICAL_API_FETCH = true;

  // ── Load-order guard (dev only) ──────────────────────────
  // Exactly ONE apiFetch must exist. If a later script reassigns
  // window.apiFetch, the envelope contract is broken and pages will corrupt.
  // Lock it down so accidental reassignment is impossible, and log loudly.
  var canonical = window.apiFetch;
  try {
    Object.defineProperty(window, 'apiFetch', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: canonical
    });
  } catch (e) {
    // Non-strict scripts that already assigned it are fine; we only harden
    // against FUTURE reassignments.
    Object.defineProperty(window, 'apiFetch', {
      configurable: false,
      enumerable: true,
      get: function () { return canonical; },
      set: function (v) {
        // eslint-disable-next-line no-console
        console.error('[api.js] window.apiFetch reassigned — the single canonical apiFetch must not be replaced.', v && v.name);
      }
    });
  }

  if (typeof console !== 'undefined' && console.debug) {
    // eslint-disable-next-line no-console
    console.debug('[api.js] canonical apiFetch installed. Envelope = { ok, status, data }.');
  }

  // ── Startup health check with visible banner ──────────────
  // Pings GET /api/health once on load. If the API is unreachable (CORS,
  // DNS, network), shows a human-readable banner so failures are never
  // silent. This makes B1-class bugs (CORS blocking) immediately visible.
  (function startupHealthCheck() {
    var HEALTH_CHECKED_KEY = '__anistrim_health_checked';
    // Only check once per session to avoid banner spam on navigation.
    if (sessionStorage.getItem(HEALTH_CHECKED_KEY)) return;
    sessionStorage.setItem(HEALTH_CHECKED_KEY, '1');

    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timeoutId = controller ? setTimeout(function () { controller.abort(); }, 8000) : null;

    fetch(API_BASE + '/api/health', {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      if (timeoutId) clearTimeout(timeoutId);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      console.log('[api.js] Health check passed:', API_BASE);
    }).catch(function (err) {
      if (timeoutId) clearTimeout(timeoutId);
      var reason = 'network error';
      if (err && err.name === 'AbortError') reason = 'timeout (8s)';
      else if (err && err.message) reason = err.message;
      console.error('[api.js] Health check FAILED:', API_BASE, reason);
      showApiUnreachableBanner(reason);
    });

    function showApiUnreachableBanner(reason) {
      // Don't show banner if one already exists
      if (document.getElementById('api-health-banner')) return;
      var banner = document.createElement('div');
      banner.id = 'api-health-banner';
      banner.setAttribute('role', 'alert');
      banner.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
        'background:#dc2626', 'color:#fff', 'padding:12px 16px',
        'font-family:system-ui,-apple-system,sans-serif', 'font-size:14px',
        'text-align:center', 'box-shadow:0 2px 8px rgba(0,0,0,0.3)'
      ].join(';');
      banner.innerHTML = [
        '<strong>⚠️ Cannot reach AniStrim servers.</strong><br>',
        '<span style="font-size:12px;opacity:0.9">Check your internet connection. If this persists, the app may need an update.</span><br>',
        '<span style="font-size:11px;opacity:0.7">(' + escapeHtml(reason) + ')</span>',
        '<button onclick="this.parentElement.remove();window.location.reload();" ',
        'style="margin-left:12px;padding:4px 12px;background:#fff;color:#dc2626;border:none;border-radius:4px;cursor:pointer;font-weight:600">Retry</button>'
      ].join('');
      function escapeHtml(s) {
        return String(s).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
      }
      function insertBanner() {
        if (document.body) document.body.insertBefore(banner, document.body.firstChild);
        else document.addEventListener('DOMContentLoaded', function () {
          document.body.insertBefore(banner, document.body.firstChild);
        });
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', insertBanner);
      } else {
        insertBanner();
      }
    }
  })();
})();

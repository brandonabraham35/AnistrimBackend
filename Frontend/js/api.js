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

  var session = (window.AniStrimSession && window.AniStrimSession.create)
    ? window.AniStrimSession.create('mobile') : null;

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
    return session ? session.getToken() : '';
  }

  function getRefreshToken() {
    return session ? session.getRefreshToken() : '';
  }

  function setTokens(token, refreshToken) {
    if (session) session.setTokens(token, refreshToken);
  }

  function clearTokens() {
    if (session) session.clear();
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
    var tok = token || (window.Auth ? window.Auth.token : '') || getToken();
    if (window.Auth) {
      if (tok && user) window.Auth.save(tok, user);
      else if (user) window.Auth.setUser(user);
    } else {
      if (tok) setTokens(tok, refreshToken);
      if (user) localStorage.setItem('user', JSON.stringify(user));
    }
    if (refreshToken) setTokens('', refreshToken);
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
      headers: { 'Content-Type': 'application/json', 'X-Client': 'mobile' },
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
    // Send a stable client identity on JSON, URL-encoded, and FormData requests.
    // Set after caller headers so it cannot be overridden unintentionally.
    headers['X-Client'] = 'mobile';
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
      else { clearTokens(); }
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
            headers: { 'Content-Type': 'application/json', 'X-Client': 'mobile' },
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

  // ── Resilient fetch + startup health check (Render cold-start aware) ──
  // Free-tier hosts (e.g. Render) sleep after inactivity and take up to a
  // minute to wake. The health check therefore waits longer and retries with
  // backoff before ever showing a banner, and the "_checked" flag is only
  // stored AFTER a success so a transient failure can always be retried.

  // Reusable fetch helper: timeout + N retries with exponential backoff.
  // Returns the final fetch Response, or throws the last error when retries run out.
  function fetchWithRetry(url, options, opts) {
    opts = opts || {};
    var timeout = opts.timeout || 20000;
    var retries = opts.retries || 0;
    return attempt(url, options || {}, timeout, retries, 0);

    function attempt(u, o, t, remaining, backoffMs) {
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timeoutId = controller ? setTimeout(function () { controller.abort(); }, t) : null;
      return fetch(u, withSignal(o, controller)).then(function (res) {
        if (timeoutId) clearTimeout(timeoutId);
        return res;
      }).catch(function (err) {
        if (timeoutId) clearTimeout(timeoutId);
        if (remaining <= 0) throw err;
        var wait = backoffMs || 2000; // 2s, then 4s, then 8s…
        return sleep(wait).then(function () {
          return attempt(u, o, t, remaining - 1, wait * 2);
        });
      });
    }

    function withSignal(o, controller) {
      if (!controller) return o;
      var copy = {};
      for (var k in o) {
        if (Object.prototype.hasOwnProperty.call(o, k)) copy[k] = o[k];
      }
      copy.signal = controller.signal;
      return copy;
    }

    function sleep(ms) {
      return new Promise(function (r) { setTimeout(r, ms); });
    }
  }
  window.fetchWithRetry = fetchWithRetry;

  (function startupHealthCheck() {
    var HEALTH_CHECKED_KEY = '__anistrim_health_checked';
    var HEALTH_TIMEOUT_MS = 20000; // 20s per attempt (was 8s)
    var HEALTH_RETRIES = 3;        // 3 attempts total, backoff 2s/4s between

    var banner = null;

    function ping() {
      return fetchWithRetry(API_BASE + '/api/health', {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'X-Client': 'mobile' }
      }, { timeout: HEALTH_TIMEOUT_MS, retries: HEALTH_RETRIES - 1 });
    }

    // Layer 3 — warm-up: always fire one quiet ping when the app opens so a
    // sleeping server starts waking immediately. Errors are intentionally silent.
    function warmupPing() {
      if (window.__anistrimWarmupFired) return;
      window.__anistrimWarmupFired = true;
      fetchWithRetry(API_BASE + '/api/health', {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'X-Client': 'mobile' }
      }, { timeout: HEALTH_TIMEOUT_MS, retries: 0 }).catch(function () { /* silent */ });
    }

    function runHealthCheck() {
      ping().then(function (res) {
        if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
        // Only flag success AFTER the check actually passes, so a failed check
        // can be retried (flag-before-result bug fixed).
        sessionStorage.setItem(HEALTH_CHECKED_KEY, '1');
        console.log('[api.js] Health check passed:', API_BASE);
        removeBanner();
      }).catch(function (err) {
        var timedOut = !!(err && (err.name === 'AbortError' || /timeout|abort/i.test(err.message || '')));
        console.error('[api.js] Health check FAILED after ' + HEALTH_RETRIES + ' attempts:', API_BASE, err && err.message);
        showApiUnreachableBanner(timedOut);
      });
    }

    function removeBanner() {
      if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
      banner = null;
    }

    // Manual "Retry": clear the flag and re-run the whole retry chain in place —
    // no full WebView reload, and the "already checked" guard can't block it.
    window.recheckApiHealth = function () {
      sessionStorage.removeItem(HEALTH_CHECKED_KEY);
      if (banner && banner.querySelector('button')) banner.querySelector('button').disabled = true;
      if (banner && banner.querySelector('.ah-status')) {
        banner.querySelector('.ah-status').textContent = 'Waking up server, please wait up to a minute…';
      }
      runHealthCheck();
    };

    // Banner shown only after all attempts fail. Wording distinguishes a cold
    // start (timeout → "server is waking up") from a real outage.
    function showApiUnreachableBanner(timedOut) {
      if (document.getElementById('api-health-banner')) return;
      banner = document.createElement('div');
      banner.id = 'api-health-banner';
      banner.setAttribute('role', 'alert');
      banner.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
        'background:#dc2626', 'color:#fff', 'padding:12px 16px',
        'font-family:system-ui,-apple-system,sans-serif', 'font-size:14px',
        'text-align:center', 'box-shadow:0 2px 8px rgba(0,0,0,0.3)'
      ].join(';');
      var msg = timedOut
        ? 'Server is waking up — this can take up to a minute. Retrying…'
        : 'Cannot reach AniStrim servers. Check your internet connection.';
      banner.innerHTML = [
        '<strong>⚠️ ' + escapeHtml(msg) + '</strong><br>',
        '<span class="ah-status" style="font-size:12px;opacity:0.9">If this persists, the app may need an update.</span><br>',
        '<button onclick="window.recheckApiHealth && window.recheckApiHealth()" ',
        'style="margin-left:12px;padding:4px 12px;background:#fff;color:#dc2626;border:none;border-radius:4px;cursor:pointer;font-weight:600">Retry</button>'
      ].join('');
      function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      function insertBanner() {
        if (document.body) document.body.insertBefore(banner, document.body.firstChild);
        else document.addEventListener('DOMContentLoaded', function () {
          if (document.body) document.body.insertBefore(banner, document.body.firstChild);
        });
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', insertBanner);
      } else {
        insertBanner();
      }
    }

    // Kick off once. If already confirmed healthy this session, only do a
    // silent warm-up ping (no banner spam on navigation); otherwise run the
    // retrying check, whose first attempt doubles as the cold-start warm-up.
    if (sessionStorage.getItem(HEALTH_CHECKED_KEY)) {
      warmupPing();
    } else {
      runHealthCheck();
    }
  })();

  // ── Analytics (Phase 50: cross-platform analytics) ──────
  // Fire-and-forget event recording. Never throws to caller.
  var API_BASE_FOR_TRACKING = (typeof window.getApiBaseUrl === 'function') ? window.getApiBaseUrl() : 'https://anistrimbackend.onrender.com';
  window.trackEvent = function (eventType, metadata) {
    try {
      var headers = { 'Content-Type': 'application/json', 'X-Client': 'mobile' };
      var token = (typeof window.getAuthToken === 'function') ? window.getAuthToken() : '';
      if (token) headers['Authorization'] = 'Bearer ' + token;
      fetch(API_BASE_FOR_TRACKING + '/api/analytics/events', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ event_type: eventType, metadata: metadata || {} }),
      }).catch(function () { /* silent — analytics must never break UX */ });
    } catch (_) { /* silent */ }
  };
})();

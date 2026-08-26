// shared/client-contract/http.js
// One request() implementation with the full auth envelope:
//   - Bearer JWT attach
//   - X-Client header
//   - single-flight POST /api/auth/refresh
//   - 401 → refresh-once → replay → clear+redirect
//   - 403 requiresVerification → verify screen
//   - 429 with retryAfter
//   - timeout via AbortController
//   - typed error object
//
// ES5-safe IIFE for use in all clients (mobile, web, desktop, admin).
//
// Usage:
//   <script src="/shared/client-contract/endpoints.js"></script>
//   <script src="/shared/client-contract/envelope.js"></script>
//   <script src="/shared/client-contract/session.js"></script>
//   <script src="/shared/client-contract/http.js"></script>
//   var http = AniStrimHttp.create({
//     apiBase: 'https://api.example.com',
//     client: 'web',
//     session: sessionObj,
//     onUnauthorized: function () { window.location = '/login'; },
//     onRequiresVerification: function (email) { window.location = '/verify?email=' + encodeURIComponent(email); }
//   });
//   http.request('/api/anime/trending').then(function (res) { ... });

/* eslint-disable no-undef */
(function (root) {
  'use strict';

  /**
   * Create an HTTP client bound to a client identifier and session.
   * @param {object} opts - { apiBase, client, session, onUnauthorized, onRequiresVerification }
   * @returns {object} { request, get, post, put, patch, del }
   */
  function create(opts) {
    opts = opts || {};
    var apiBase = opts.apiBase || '';
    var client = opts.client || 'web';
    var session = opts.session || null;
    var onUnauthorized = opts.onUnauthorized || function () {};
    var onRequiresVerification = opts.onRequiresVerification || function () {};
    var onRateLimit = opts.onRateLimit || function () {};

    // Single-flight refresh promise
    var refreshPromise = null;

    /**
     * Typed API error.
     */
    function ApiError(message, status, code, data, retryAfter) {
      this.message = message || 'Request failed';
      this.status = status || 0;
      this.code = code || 'UNKNOWN_ERROR';
      this.data = data || null;
      if (retryAfter) this.retryAfter = retryAfter;
    }
    ApiError.prototype = Object.create(Error.prototype);
    ApiError.prototype.constructor = ApiError;

    /**
     * Unwrap the backend envelope from a parsed body.
     * Uses AniStrimEnvelope if available, otherwise inline.
     */
    function unwrapBody(body) {
      if (root.AniStrimEnvelope && root.AniStrimEnvelope.unwrap) {
        return root.AniStrimEnvelope.unwrap(body);
      }
      // Inline fallback
      if (body && body.success === false && body.error) {
        return {
          ok: false,
          error: { code: body.error.code || 'UNKNOWN_ERROR', message: body.error.message || 'Request failed', status: body.error.status || 0, requestId: body.error.requestId || null },
        };
      }
      if (body && body.success === true && Object.prototype.hasOwnProperty.call(body, 'data')) {
        return { ok: true, data: body.data, meta: body.meta || {} };
      }
      return { ok: true, data: body || {}, meta: {} };
    }

    /**
     * Perform a refresh POST once, sharing the promise across parallel 401s.
     */
    function doRefresh() {
      if (!session || !session.getRefreshToken) return Promise.resolve(null);
      var refreshToken = session.getRefreshToken();
      if (!refreshToken) return Promise.resolve(null);

      return fetch(apiBase + '/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client': client },
        body: JSON.stringify({ refreshToken: refreshToken }),
      }).then(function (res) {
        if (!res.ok) return null;
        return res.json().catch(function () { return null; });
      }).then(function (body) {
        var unwrapped = unwrapBody(body || {});
        if (!unwrapped.ok || !unwrapped.data) return null;
        var data = unwrapped.data;
        if (!data.token) return null;
        if (session.setTokens) session.setTokens(data.token, data.refreshToken || refreshToken);
        return data;
      }).catch(function () { return null; });
    }

    function refreshOnce() {
      if (!refreshPromise) {
        refreshPromise = doRefresh().then(function (result) {
          refreshPromise = null;
          return result;
        }, function () {
          refreshPromise = null;
          return null;
        });
      }
      return refreshPromise;
    }

    /**
     * Core request method.
     * @param {string} path - API path (e.g. '/api/anime/trending')
     * @param {object} [options] - { method, headers, body, timeout, _retried }
     * @returns {Promise<{ok, status, data, meta, timedOut?}>}
     */
    function request(path, options) {
      options = options || {};
      var method = options.method || 'GET';
      var headers = Object.assign({}, options.headers || {});
      headers['X-Client'] = client;
      if (options.headers && options.headers.Authorization) {
        headers['Authorization'] = options.headers['Authorization'];
      } else if (session && session.getToken) {
        var token = session.getToken();
        if (token) headers['Authorization'] = 'Bearer ' + token;
      }

      var body = options.body;
      var isFormData = (typeof FormData !== 'undefined') && (body instanceof FormData);
      if (!isFormData && !(body instanceof URLSearchParams)) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        if (body && typeof body !== 'string') body = JSON.stringify(body);
      }

      // Timeout via AbortController
      var abortCtrl = (typeof AbortController !== 'undefined' && options.timeout)
        ? new AbortController()
        : null;
      var timeoutId = null;
      if (abortCtrl) {
        timeoutId = setTimeout(function () { abortCtrl.abort(); }, options.timeout);
      }

      var fetchOpts = { method: method, headers: headers, body: body || undefined };
      if (abortCtrl) fetchOpts.signal = abortCtrl.signal;

      return fetch(apiBase + path, fetchOpts).then(function (res) {
        if (timeoutId) clearTimeout(timeoutId);
        // Parse JSON body (handle empty responses)
        var contentType = res.headers && res.headers.get ? res.headers.get('content-type') || '' : '';
        var parsePromise = (contentType.indexOf('json') !== -1)
          ? res.json().catch(function () { return {}; })
          : res.text().then(function (t) {
              try { return t ? JSON.parse(t) : {}; } catch (e) { return { raw: t }; }
            });

        return parsePromise.then(function (body) {
          var unwrapped = unwrapBody(body);

          // ── 401: try refresh once, then replay ────────────
          if (res.status === 401 && !options._retried) {
            return refreshOnce().then(function (refreshed) {
              if (refreshed && refreshed.token) {
                var retryOpts = Object.assign({}, options, { _retried: true });
                retryOpts.headers = Object.assign({}, options.headers || {});
                retryOpts.headers['Authorization'] = 'Bearer ' + refreshed.token;
                return request(path, retryOpts);
              }
              // Refresh failed — clear + redirect
              if (session && session.clear) session.clear();
              onUnauthorized();
              return { ok: false, status: 401, data: unwrapped.data || {}, error: unwrapped.error };
            });
          }

          // ── 429: rate limited ─────────────────────────────
          if (res.status === 429) {
            var retryAfter = 60;
            var raHeader = res.headers && res.headers.get ? res.headers.get('Retry-After') : null;
            if (raHeader) retryAfter = parseInt(raHeader, 10) || 60;
            if (unwrapped.error && unwrapped.error.retryAfter) retryAfter = unwrapped.error.retryAfter;
            var rateErr = new ApiError(
              (unwrapped.error && unwrapped.error.message) || 'Too many requests.',
              res.status,
              (unwrapped.error && unwrapped.error.code) || 'RATE_LIMITED',
              unwrapped,
              retryAfter
            );
            onRateLimit(rateErr);
            throw rateErr;
          }

          // ── 403 requiresVerification ──────────────────────
          if (res.status === 403 && unwrapped.data && unwrapped.data.requiresVerification === true) {
            var email = unwrapped.data.email || '';
            onRequiresVerification(email);
            return { ok: false, status: 403, data: unwrapped.data, error: unwrapped.error };
          }

          // ── Success or other error ────────────────────────
          return {
            ok: res.ok,
            status: res.status,
            data: unwrapped.data,
            meta: unwrapped.meta,
            error: unwrapped.error || null,
          };
        });
      }).catch(function (err) {
        if (timeoutId) clearTimeout(timeoutId);
        var aborted = !!(err && (err.name === 'AbortError' || /abort|timeout/i.test(err.message || '')));
        return { ok: false, status: 0, data: {}, timedOut: aborted, error: err };
      });
    }

    return {
      request: request,

      get: function (path, options) {
        return request(path, Object.assign({ method: 'GET' }, options));
      },
      post: function (path, body, options) {
        return request(path, Object.assign({ method: 'POST', body: body }, options));
      },
      put: function (path, body, options) {
        return request(path, Object.assign({ method: 'PUT', body: body }, options));
      },
      patch: function (path, body, options) {
        return request(path, Object.assign({ method: 'PATCH', body: body }, options));
      },
      del: function (path, options) {
        return request(path, Object.assign({ method: 'DELETE' }, options));
      },
      ApiError: ApiError,
    };
  }

  // Export for browser (IIFE) and CommonJS (tests)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { create: create };
  } else {
    root.AniStrimHttp = { create: create };
  }

  // ── Analytics helper for Desktop (Phase 50) ─────────────
  // Fire-and-forget; never throws. Uses the same apiBase from endpoints.
  if (typeof window !== 'undefined' && !root.trackEvent) {
    root.trackEvent = function (eventType, metadata) {
      try {
        var apiBase = (typeof root.AniStrimEndpoints !== 'undefined' && root.AniStrimEndpoints.get)
          ? root.AniStrimEndpoints.get('apiBase') : 'https://anistrimbackend.onrender.com';
        var headers = { 'Content-Type': 'application/json', 'X-Client': 'desktop' };
        if (root.AniStrimSession) {
          var s = root.AniStrimSession.create('desktop');
          var t = s && s.getToken ? s.getToken() : '';
          if (t) headers['Authorization'] = 'Bearer ' + t;
        }
        fetch(apiBase + '/api/analytics/events', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ event_type: eventType, metadata: metadata || {} }),
        }).catch(function () {});
      } catch (_) {}
    };
  }
})(typeof window !== 'undefined' ? window : this);
/**
 * config.js — AniStrim Dynamic API Configuration
 * 
 * Detects the runtime environment (Capacitor native vs browser)
 * and returns the correct API base URL.
 * 
 * In Capacitor Android: the WebView origin is https://localhost,
 * so we must use the absolute Render backend URL for all API calls.
 * In browser: same — always use the Render backend.
 * 
 * This file must be loaded BEFORE scrpt.js in every HTML page.
 */

(function() {
  var API_BASE_URL = 'https://anistrimbackend.onrender.com';

  // Detect if we're running inside Capacitor native app
  function isCapacitorNative() {
    return typeof window.Capacitor !== 'undefined' 
        && window.Capacitor.isNative === true;
  }

  // Get the correct API base URL for the current environment
  function getApiBaseUrl() {
    // (B3 fix) Honour an explicit override FIRST so local / self-hosted
    // deployments can point at the correct backend without editing source.
    // '' = same-origin relative (no CORS). This is additive — it does NOT
    // change Capacitor/native behavior below, which still uses the absolute
    // production URL because the Capacitor WebView origin is not the API origin.
    if (typeof window !== 'undefined' && typeof window.__ANISTRIM_API !== 'undefined') {
      return String(window.__ANISTRIM_API === null ? '' : window.__ANISTRIM_API).replace(/\/+$/, '');
    }
    try {
      var _meta = document.querySelector('meta[name="anistrim-api"]');
      if (_meta && _meta.content) return _meta.content.trim().replace(/\/+$/, '');
    } catch (e) { /* non-browser / no document */ }

    const isNative = isCapacitorNative();
    const isFile = window.location.protocol === 'file:';
    // Capacitor's webview on Android serves from a `localhost` origin. This check ensures
    // that any 'localhost' origin inside the native shell defaults to the live API.
    const isCapacitorLocalhost = window.location.hostname === 'localhost';

    // If running in a native mobile context, always force the production URL.
    if (isNative || isFile || isCapacitorLocalhost) {
      return API_BASE_URL;
    }

    // For all other cases (e.g., standard browser development, web deployment), default to production.
    return API_BASE_URL;
  }

  // Shared frontend runtime for duplicated DOM and utility helpers.
  // This keeps the exact browser/mobile behavior intact while consolidating the
  // duplicated helper implementation into a single source of truth.
  const shared = window.AniStrimShared || {};

  // ── NavGuard: the single, loop-proof navigation authority ──────────────
  // Every auth-related redirect in the app goes through this. It (a) refuses to
  // navigate to the page we are already on, and (b) enforces a budget of 3
  // auth redirects per 10s window per tab. A stale token, a 401 storm or two
  // gates disagreeing can therefore never produce an infinite reload loop —
  // the 4th redirect is dropped and logged instead.
  var NavGuard = window.NavGuard || (function () {
    var KEY = '__navBudget';
    function currentPage() {
      var last = (window.location.pathname || '').split('/').pop();
      return last || 'index.html';
    }
    return {
      currentPage: currentPage,
      // Returns true if the navigation was actually performed.
      go: function (dest, opts) {
        opts = opts || {};
        var target = String(dest).split('/').pop();
        if (currentPage() === target) return false;      // already here
        try {
          var now = Date.now();
          var st = JSON.parse(sessionStorage.getItem(KEY) || 'null') || { n: 0, t: now };
          if (now - st.t > 10000) st = { n: 0, t: now };
          st.n += 1;
          sessionStorage.setItem(KEY, JSON.stringify(st));
          if (st.n > 3) {
            console.error('[NavGuard] redirect loop blocked, staying put. wanted:', dest);
            return false;
          }
        } catch (e) { /* private mode — fall through */ }
        // Always root-absolute so a sub-path like /admin/users can never
        // resolve a relative target back onto itself.
        window.location.replace('/' + target);
        return true;
      },
      reset: function () { try { sessionStorage.removeItem(KEY); } catch (e) {} }
    };
  })();
  window.NavGuard = NavGuard;

  // ── apiFetch (thin deferral) ──────────────────────────────
  // The canonical apiFetch lives in js/api.js (loaded after config.js on every
  // page that needs it). config.js only installs a THIN delegate so pages that
  // load only config.js+scrpt.js (e.g. upgrade.html) still get the canonical
  // behavior once js/api.js is present. There is exactly ONE apiFetch
  // implementation in the repo. It returns the envelope { ok, status, data }.
  shared.apiFetch = shared.apiFetch || async function apiFetch(endpoint, options = {}) {
    // Delegate to the canonical implementation (js/api.js) once it is loaded.
    // js/api.js sets window.__CANONICAL_API_FETCH, which is unambiguous — we
    // cannot compare function identity here because config.js assigns
    // window.apiFetch = shared.apiFetch at load time (before js/api.js runs).
    if (window.__CANONICAL_API_FETCH === true && typeof window.apiFetch === 'function') {
      return window.apiFetch(endpoint, options);
    }
    // Fallback (js/api.js not loaded): minimal last-resort fetch so the page
    // still has a working request path without duplicating the full body.
    const API_BASE = (typeof window.getApiBaseUrl === 'function') ? window.getApiBaseUrl() : '';
    try {
      const headers = { ...(options.headers || {}) };
      const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
      if (!isFormData) headers['Content-Type'] = 'application/json';
      if (State?.token) headers['Authorization'] = `Bearer ${State.token}`;
      const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      const timedOut = e && (e.name === 'AbortError' || /abort|timeout/i.test(e.message || ''));
      return { ok: false, timedOut, data: {} };
    }
  };

  shared.escapeHTML = shared.escapeHTML || function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  shared.toggleMenu = shared.toggleMenu || function toggleMenu() {
    document.getElementById('side-menu')?.classList.toggle('active');
    document.getElementById('menu-overlay')?.classList.toggle('active');
  };

  shared.handleSignOut = shared.handleSignOut || function handleSignOut() {
    State?.clear?.();
    window.location.href = 'login.html';
  };

  shared.closePopup = shared.closePopup || function closePopup() {
    document.getElementById('welcome-popup')?.style.setProperty('display', 'none');
  };

  shared.setText = shared.setText || function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  shared.showToast = shared.showToast || function showToast(msg, type = 'success') {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.style.cssText = `
        position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
        background:var(--card-bg); border:1px solid var(--border);
        color:var(--text); padding:10px 20px; border-radius:8px;
        font-family:'Outfit',sans-serif; font-size:0.88rem; font-weight:500;
        z-index:9999; box-shadow:0 4px 20px rgba(0,0,0,0.4);
        transition:opacity 0.3s; pointer-events:none;
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    toast.style.borderColor = type === 'error' ? '#ef4444' : 'var(--purple)';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
  };

  shared.makeFallbackImg = shared.makeFallbackImg || function makeFallbackImg(title) {
    const letter = (title || '?').charAt(0).toUpperCase();
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='450'>
      <rect width='300' height='450' fill='%231a1a2e'/>
      <rect x='30' y='170' width='240' height='110' rx='8' fill='%23252540'/>
      <text x='150' y='240' font-family='sans-serif' font-size='64' fill='%238b5cf6'
            text-anchor='middle' dominant-baseline='middle'>${letter}</text>
    </svg>`;
    return `data:image/svg+xml,${svg}`;
  };

  shared.cardImgError = shared.cardImgError || function cardImgError(el, title) {
    el.onerror = null;
    el.src = shared.makeFallbackImg(title);
  };

  // ── Centralized Auth State ─────────────────────────────
  // Single source of truth for the JWT + user. All flows write through Auth,
  // never via scattered localStorage calls. The JWT backend contract is
  // unchanged; the token is decoded ONLY for UX/expiry awareness.
  //
  // save(token, user)   — store token + user (and any session_token fallback)
  // clear()             — remove token, user, and all temporary auth/redirect state
  // get user/token      — lazy readers
  // isLoggedIn          — token present AND not expired (server is authoritative
  //                       for authorization; this is only UX gating)
  // refresh()           — call GET /api/auth/me and update the stored user from
  //                       the server (authoritative for isPremium/isVerified/
  //                       isAdmin/avatar/auth_provider/premium_expires_at)
  var Auth = window.Auth || (function () {
    var session = (window.AniStrimSession && window.AniStrimSession.create)
      ? window.AniStrimSession.create('mobile') : null;
    var USER_KEY = 'user';

    function readUser() {
      try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch (e) { return null; }
    }
    function writeUser(u) { localStorage.setItem(USER_KEY, JSON.stringify(u)); }
    function readToken() { return session ? session.getToken() : ''; }

    function decodeExp(token) {
      try {
        var parts = String(token).split('.');
        if (parts.length === 3) {
          var p = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
          if (p && typeof p.exp === 'number') return p.exp * 1000;
        }
      } catch (e) { /* malformed — treat as no exp */ }
      return null;
    }

    return {
      get token() { return readToken(); },
      get user() { return readUser(); },
      set user(u) { if (u) writeUser(u); else localStorage.removeItem(USER_KEY); },
      isExpired() {
        var exp = decodeExp(readToken());
        return exp !== null && exp < Date.now();
      },
      get isLoggedIn() {
        var t = readToken();
        if (!t) return false;
        var exp = decodeExp(t);
        if (exp !== null && exp < Date.now()) return false; // expired => not logged in
        return true;
      },
      save(token, user, refreshToken) {
        if (session) session.setTokens(token, refreshToken);
        if (user) { writeUser(user); }
      },
      get refreshToken() { return session ? session.getRefreshToken() : ''; },
      set refreshToken(v) { if (session) { if (v) session.setTokens('', v); else session.storage.removeItem(session.prefix + 'refreshToken'); } },
      setUser(user) { if (user) writeUser(user); },
      getUser() { return readUser(); },
      clear() {
        if (session) session.clear();
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem('isFirstVisit');
        sessionStorage.removeItem('pendingEmail');
        sessionStorage.removeItem('otpEmailSent');
        sessionStorage.removeItem('__authRedirecting');
      },
      async refresh() {
        var t = readToken();
        if (!t || this.isExpired()) { this.clear(); return null; }
        try {
          var res = await fetch((window.getApiBaseUrl ? window.getApiBaseUrl() : API_BASE_URL) + '/api/auth/me', {
            headers: { 'Authorization': 'Bearer ' + t, 'Accept': 'application/json' }
          });
          if (res.status === 401) { this.clear(); return null; }
          var data = await res.json().catch(function () { return null; });
          if (data && data.id) { writeUser(data); return data; }
          return readUser();
        } catch (e) { return readUser(); }
      }
    };
  })();
  window.Auth = Auth;

  // Preserve the public browser globals used by the existing page scripts.
  window.AniStrimShared = shared;
  window._escapeHTML = shared.escapeHTML;
  window.apiFetch = shared.apiFetch;
  window.toggleMenu = shared.toggleMenu;
  window.handleSignOut = shared.handleSignOut;
  window.closePopup = shared.closePopup;
  window.setText = shared.setText;
  window.showToast = shared.showToast;
  window.makeFallbackImg = shared.makeFallbackImg;
  window.cardImgError = shared.cardImgError;

  // Expose globally
  window.__API_BASE_URL = API_BASE_URL;
  window.getApiBaseUrl = getApiBaseUrl;
  window.isCapacitorNative = isCapacitorNative;

  // Log environment info for debugging
  console.log('[Config] Environment:', isCapacitorNative() ? 'Capacitor Native' : 'Browser');
  console.log('[Config] API Base URL:', getApiBaseUrl());
})();

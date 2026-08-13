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

  shared.apiFetch = shared.apiFetch || async function apiFetch(endpoint, options = {}) {
    // When the body is FormData (e.g. multipart avatar upload), we must NOT set
    // Content-Type: application/json — the browser sets the correct multipart
    // boundary automatically. Forcing JSON would break file uploads.
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const headers = { ...(options.headers || {}) };
    if (!isFormData) headers['Content-Type'] = 'application/json';
    if (State?.token) headers['Authorization'] = `Bearer ${State.token}`;

    // ── Bounded request timeout ─────────────────────────────
    // Standard fetch() has NO automatic timeout. Without this, a hung
    // network request can leave the player stuck on "Loading stream..."
    // forever. Every request gets a hard upper bound (default 30s) and
    // an AbortController so the fetch is actually cancelled.
    const timeoutMs = options.timeout || 30000;
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    let timeoutId = null;
    if (controller) {
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    try {
      const res = await fetch(`${API}${endpoint}`, {
        ...options,
        headers,
        ...(controller ? { signal: controller.signal } : {}),
      });
      const data = await res.json().catch(() => ({}));
      // Only force a login redirect on authentication-critical requests.
      // Background/fire-and-forget requests (e.g. watch progress polling) pass
      // { skipAuthRedirect: true } so a 401 there never kicks the user out of
      // the player mid-watch.
      if (res.status === 401 && !options.skipAuthRedirect) {
        State?.clear?.();
        window.location.href = 'login.html';
      }
      if (res.status === 403 && data?.requiresVerification) {
        const em = data.email || State?.user?.email || '';
        if (em) { sessionStorage.setItem('pendingEmail', em); localStorage.setItem('pendingEmail', em); }
        window.location.href = em ? ('verify-otp.html?email=' + encodeURIComponent(em)) : 'verify-otp.html';
        return { ok: false, status: 403, data };
      }
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      const timedOut = e && (e.name === 'AbortError' || /abort|timeout/i.test(e.message || ''));
      console.error('API error:', endpoint, e.message, timedOut ? '(timeout)' : '');
      return { ok: false, timedOut, data: {} };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
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
    var TOKEN_KEY = 'token';
    var SESSION_KEY = 'session_token';
    var USER_KEY = 'user';

    function readUser() {
      try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch (e) { return null; }
    }
    function writeUser(u) { localStorage.setItem(USER_KEY, JSON.stringify(u)); }
    function readToken() { return localStorage.getItem(TOKEN_KEY) || localStorage.getItem(SESSION_KEY) || ''; }

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
      save(token, user) {
        if (token) { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(SESSION_KEY, token); }
        if (user) { writeUser(user); }
      },
      setUser(user) { if (user) writeUser(user); },
      getUser() { return readUser(); },
      clear() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(SESSION_KEY);
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

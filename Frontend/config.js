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
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
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
      if (res.status === 401) {
        State?.clear?.();
        window.location.href = 'login.html';
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

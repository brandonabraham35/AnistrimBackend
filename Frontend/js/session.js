// Frontend/js/session.js — the single shared session module (Item 1.5).
//
// Every page calls this once on load. It caches the user DTO in memory (NOT
// localStorage) and exposes:
//   getUser()   — returns the cached user (or null)
//   refresh()   — calls GET /api/auth/me and updates the in-memory cache
//   onChange(cb) — register a callback fired when the user changes
//   setUser(user) — push a fresh DTO into the cache AND the persisted Auth copy
//
// This replaces every ad-hoc localStorage.getItem('user') read. The token is
// still stored in localStorage (Auth module in config.js) for persistence, but
// the user DTO is always fetched fresh from the server on page load.

(function () {
  'use strict';

  var API_BASE = (typeof window.getApiBaseUrl === 'function')
    ? window.getApiBaseUrl()
    : 'https://anistrimbackend.onrender.com';

  var cachedUser = null;
  var listeners = [];

  function getToken() {
    return (window.Auth && window.Auth.token) || localStorage.getItem('token') || localStorage.getItem('session_token') || '';
  }

  function setUser(user) {
    var changed = JSON.stringify(cachedUser) !== JSON.stringify(user);
    cachedUser = user;
    // Write through to the persisted Auth snapshot so localStorage('user')
    // always carries the freshest DTO (e.g. avatarUrl after an upload).
    // Auth lives in config.js which loads before session.js on every page.
    if (user && window.Auth && window.Auth.setUser) {
      try { window.Auth.setUser(user); } catch (e) { console.error('[Session] Auth.setUser error:', e); }
    }
    if (changed) {
      listeners.forEach(function (cb) {
        try { cb(user); } catch (e) { console.error('[Session] onChange error:', e); }
      });
    }
  }

  // Public alias so callers (e.g. profile.js avatar upload) can push a fresh
  // DTO into the in-memory snapshot AND the persisted Auth copy in one call.
  function setUserPublic(user) { setUser(user); }

  // Fetch the authoritative user DTO from /api/auth/me.
  // Uses the canonical apiFetch helper (js/api.js) which unwraps the standard
  // { success: true, data: { ... } } envelope, handles 401 refresh-token
  // rotation, and returns { ok, status, data }.
  async function refresh() {
    var token = getToken();
    if (!token) {
      setUser(null);
      return null;
    }
    try {
      // When the canonical apiFetch is installed, delegate to it for correct
      // envelope unwrapping and automatic 401 → refresh → replay.
      if (typeof window.apiFetch === 'function') {
        var result = await window.apiFetch('/api/auth/me');
        if (result.ok && result.data && result.data.id) {
          setUser(result.data);
          return result.data;
        }
        // 401 or invalid response — session is gone.
        setUser(null);
        return null;
      }

      // Fallback: direct fetch with manual envelope unwrap
      // (used when js/api.js has not loaded yet, e.g. very early page init).
      var res = await fetch(API_BASE + '/api/auth/me', {
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
      });
      if (res.status === 401) {
        if (window.Auth) window.Auth.clear();
        setUser(null);
        return null;
      }
      var body = await res.json().catch(function () { return null; });
      // Unwrap standard envelope: { success: true, data: { id, ... } }
      var data = (body && body.success === true && body.data) ? body.data : body;
      if (data && data.id) {
        setUser(data);
        return data;
      }
      return cachedUser;
    } catch (e) {
      console.error('[Session] refresh error:', e);
      return cachedUser;
    }
  }

  function getUser() {
    return cachedUser;
  }

  function onChange(cb) {
    if (typeof cb === 'function') listeners.push(cb);
  }

  // Expose globally.
  window.Session = {
    getUser: getUser,
    refresh: refresh,
    onChange: onChange,
    setUser: setUserPublic,
  };
})();
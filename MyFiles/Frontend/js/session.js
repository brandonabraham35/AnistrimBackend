// Frontend/js/session.js — the single shared session module (Item 1.5).
//
// Every page calls this once on load. It caches the user DTO in memory (NOT
// localStorage) and exposes:
//   getUser()   — returns the cached user (or null)
//   refresh()   — calls GET /api/auth/me and updates the in-memory cache
//   onChange(cb) — register a callback fired when the user changes
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
    if (changed) {
      listeners.forEach(function (cb) {
        try { cb(user); } catch (e) { console.error('[Session] onChange error:', e); }
      });
    }
  }

  // Fetch the authoritative user DTO from /api/auth/me.
  async function refresh() {
    var token = getToken();
    if (!token) {
      setUser(null);
      return null;
    }
    try {
      var res = await fetch(API_BASE + '/api/auth/me', {
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
      });
      if (res.status === 401) {
        if (window.Auth) window.Auth.clear();
        setUser(null);
        return null;
      }
      var data = await res.json().catch(function () { return null; });
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
  };
})();
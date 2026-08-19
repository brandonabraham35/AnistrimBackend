// Frontend/js/avatar.js — first-class avatar rendering (Phase 2, item 2.2).
//
// Exposes:
//   renderAvatarEverywhere(url) — updates every mounted <img data-avatar>
//   avatarFallback(name, size)  — deterministic initials-on-hashed-colour SVG
//
// Every avatar element should carry a data-avatar attribute. After a session
// refresh or upload, call renderAvatarEverywhere(url) and all mounted avatars
// (header, profile, comments, admin user table) update from one place.

(function () {
  'use strict';

  // Deterministic colour from a string hash (stable across visits).
  function hashString(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  }

  // A pleasant, coordinated palette (dark-friendly).
  var PALETTE = [
    ['#6c2bd9', '#a78bfa'], ['#3b82f6', '#93c5fd'], ['#10b981', '#6ee7b7'],
    ['#f59e0b', '#fcd34d'], ['#ef4444', '#fca5a5'], ['#8b5cf6', '#c4b5fd'],
  ];

  function initials(name) {
    var n = String(name || '?').trim();
    if (!n) return '?';
    var parts = n.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return n.slice(0, 2).toUpperCase();
  }

  // Deterministic initials-on-hashed-colour SVG data URI (never broken image).
  function avatarFallback(name, size) {
    var s = size || 96;
    var h = hashString(String(name || 'anistrim'));
    var pair = PALETTE[h % PALETTE.length];
    var text = initials(name);
    var svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}'>` +
      `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
      `<stop offset='0' stop-color='${pair[0]}'/><stop offset='1' stop-color='${pair[1]}'/></linearGradient></defs>` +
      `<rect width='${s}' height='${s}' fill='url(#g)'/>` +
      `<text x='50%' y='54%' font-family='sans-serif' font-size='${Math.floor(s*0.4)}' font-weight='700' fill='#fff' text-anchor='middle' dominant-baseline='middle'>${text}</text>` +
      `</svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  // Update every mounted avatar element with the given URL (or fallback).
  function renderAvatarEverywhere(url, name) {
    var els = document.querySelectorAll('[data-avatar]');
    els.forEach(function (el) {
      renderAvatarOn(el, url, name);
    });
  }

  // Render a single avatar element: <img data-avatar> or a letter/div fallback.
  function renderAvatarOn(el, url, name) {
    if (!el) return;
    var nameForFallback = name || el.getAttribute('data-name') || 'U';
    var fallback = avatarFallback(nameForFallback, parseInt(el.getAttribute('data-size'), 10) || 96);

    if (el.tagName === 'IMG') {
      if (url) {
        el.onerror = function () { el.src = fallback; };
        el.src = url;
        el.style.display = 'block';
      } else {
        el.onerror = null;
        el.src = fallback;
        el.style.display = 'block';
      }
    } else {
      // Div/span letter avatar.
      el.textContent = initials(nameForFallback);
      el.style.backgroundImage = 'url(' + fallback + ')';
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.style.color = 'transparent';
    }
  }

  // Initialize: when the session/user changes, refresh all avatars.
  function init() {
    var session = window.Session;
    if (session && session.onChange) {
      session.onChange(function (user) {
        var url = (user && (user.avatarUrl || user.avatar || user.avatar_url)) || null;
        var name = (user && (user.displayName || user.name)) || 'U';
        renderAvatarEverywhere(url, name);
      });
    }
    // Hydrate the session from the server before the first paint so a freshly
    // uploaded avatar is present on every page (e.g. home) — previously the
    // home page never refreshed, so it rendered the stale snapshot fallback.
    async function hydrateAndRender() {
      try {
        if (session && session.refresh) await session.refresh();
      } catch (e) { /* non-fatal — fall back to the cached user */ }
      var user = (session && session.getUser()) || (window.State && window.State.user) || null;
      var url = (user && (user.avatarUrl || user.avatar || user.avatar_url)) || null;
      var name = (user && (user.displayName || user.name)) || 'U';
      renderAvatarEverywhere(url, name);
    }
    hydrateAndRender();
  }

  window.Avatar = {
    renderAvatarEverywhere: renderAvatarEverywhere,
    renderAvatarOn: renderAvatarOn,
    avatarFallback: avatarFallback,
    initials: initials,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
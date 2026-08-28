// Frontend/js/navigation.js — the single redirect contract (Item 15).
//
// afterAuth(user, redirectParam) is the ONLY place the app decides where to go
// after a successful login/signup/OTP/Google auth. It:
//   1. Sanitizes the redirect param (same-origin, allowlisted pages only).
//   2. Never navigates before /api/auth/me resolves (caller must pass the
//      authoritative user DTO from the server).
//   3. Uses location.replace() so the back-button can't return to the login page.
//   4. In Capacitor uses relative paths only (index.html, not /index.html)
//      because the WebView base is file:// or https://localhost.
//
// Guarded pages (watch.html, watchlist.html, profile.html) redirect to
// login.html?redirect=<encodeURIComponent(current path+search)>.

(function () {
  'use strict';

  // Pages that are safe to redirect to after auth. Everything else is ignored.
  var ALLOWLIST = new Set([
    'index.html', 'browse.html', 'details.html', 'watch.html',
    'watchlist.html', 'profile.html', 'upgrade.html', 'admin.html',
    'onboarding.html', 'verify-otp.html',
  ]);

  // Pages that require an authenticated session.
  var GUARDED_PAGES = new Set([
    'watch.html', 'watchlist.html', 'profile.html',
  ]);

  function isCapacitor() {
    // Capacitor >=6 exposes the isNativePlatform() method; there is no isNative boolean.
    return typeof window.Capacitor !== 'undefined' && !!window.Capacitor.isNativePlatform?.();
  }

  // Reject anything with a scheme or // (open redirect protection).
  function sanitizeRedirect(raw) {
    if (!raw || typeof raw !== 'string') return null;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;   // scheme: e.g. javascript:, https:
    if (raw.includes('//')) return null;                       // protocol-relative or double slash
    var page = raw.split('?')[0].split('#')[0].split('/').pop();
    if (!page) return null;
    if (!ALLOWLIST.has(page)) return null;
    return page;
  }

  // Build a relative path (Capacitor-safe).
  function go(page) {
    if (isCapacitor()) {
      // Relative path only — the WebView base is file:// or https://localhost.
      window.location.replace(page);
    } else {
      window.location.replace('/' + page);
    }
  }

  // The single post-auth decision point.
  // user: the authoritative DTO from /api/auth/me (or the login response).
  // redirectParam: the ?redirect= value from the login URL (optional).
  function afterAuth(user, redirectParam) {
    if (!user) {
      go('login.html');
      return;
    }

    var safe = sanitizeRedirect(redirectParam);

    // Suspended / deactivated / deleted users see a status screen, not a loop.
    if (user.status && user.status !== 'active') {
      go('account-status.html?status=' + encodeURIComponent(user.status));
      return;
    }

    if (!user.emailVerified) {
      go('verify-otp.html');
      return;
    }

    if (!user.onboarded) {
      go('onboarding.html');
      return;
    }

    if (user.isAdmin && !safe) {
      go('admin.html');
      return;
    }

    go(safe || 'index.html');
  }

  // Guarded pages call this on load. If not logged in, redirect to login with
  // the current path+search preserved so the user returns to the exact page.
  function guardPage() {
    var current = window.location.pathname.split('/').pop() || 'index.html';
    if (!GUARDED_PAGES.has(current)) return;

    var token = (window.Auth && window.Auth.token) || localStorage.getItem('token') || '';
    if (token) return;

    var currentPath = window.location.pathname + window.location.search;
    var redirect = encodeURIComponent(currentPath);
    go('login.html?redirect=' + redirect);
  }

  window.Navigation = {
    afterAuth: afterAuth,
    sanitizeRedirect: sanitizeRedirect,
    guardPage: guardPage,
    go: go,
    ALLOWLIST: ALLOWLIST,
    GUARDED_PAGES: GUARDED_PAGES,
  };
})();
// google-auth-handler.js
// Handles the deep link anistrim://auth?code=xxx when app is opened
// Include on: login.html, signup.html, index.html

(function() {
  var BACKEND = 'https://anistrimbackend.onrender.com';

  // ── Extract code from URL or deep link ───────────────────
  function getCodeFromUrl(url) {
    try {
      // Try as full URL first
      var u = new URL(url);
      var code = u.searchParams.get('code');
      if (code) return code;
    } catch(e) {}

    // Try regex for anistrim://auth?code=xxx format
    var match = (url || '').match(/[?&]code=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  // ── Fetch JWT using the one-time code ───────────────────
  async function fetchAndLogin(code) {
    if (!code) return;

    showOverlay('Signing you in...');

    try {
      var res  = await fetch(BACKEND + '/api/auth/google/token?code=' + encodeURIComponent(code));
      var data = await res.json();

      if (!res.ok || !data.token || !data.user) {
        hideOverlay();
        showAuthError(data.message || 'Sign-in failed. Please try again.');
        return;
      }

      // Save token — same as email login
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('isFirstVisit', 'true');

      // Clean URL
      window.history.replaceState({}, document.title, window.location.pathname);

      hideOverlay();

      // Redirect to home
      window.location.href = data.user.isAdmin ? 'admin.html' : 'index.html';

    } catch(e) {
      hideOverlay();
      console.error('Google auth handler error:', e);
      showAuthError('Could not complete sign-in. Please try again.');
    }
  }

  // ── Check URL params on page load ───────────────────────
  function checkUrlOnLoad() {
    var code = getCodeFromUrl(window.location.href);
    if (code) {
      fetchAndLogin(code);
      return true;
    }
    return false;
  }

  // ── Listen for Capacitor deep link event ────────────────
  function listenForDeepLink() {
    if (typeof window.Capacitor === 'undefined') return;
    if (!window.Capacitor.Plugins || !window.Capacitor.Plugins.App) return;

    try {
      window.Capacitor.Plugins.App.addListener('appUrlOpen', function(data) {
        if (!data || !data.url) return;
        if (!data.url.includes('anistrim://auth')) return;

        // Close the Custom Tab FIRST before doing anything
        // Otherwise redirect to index.html happens behind the browser
        try { window.Capacitor.Plugins.Browser.close(); } catch(e) {}

        // Check for error
        if (data.url.includes('error=')) return;

        var code = getCodeFromUrl(data.url);
        if (code) fetchAndLogin(code);
      });
    } catch(e) {
      console.log('Deep link listener error:', e.message);
    }
  }

  // ── UI helpers ───────────────────────────────────────────
  function showOverlay(msg) {
    if (document.getElementById('g-auth-overlay')) return;
    var div = document.createElement('div');
    div.id = 'g-auth-overlay';
    div.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(10,10,15,0.96);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;';
    div.innerHTML = '<div style="width:48px;height:48px;border:4px solid rgba(108,43,217,0.2);border-top-color:#6c2bd9;border-radius:50%;animation:gspin 0.8s linear infinite;"></div><p style="color:#aaa;font-size:0.9rem;font-family:sans-serif;">' + msg + '</p><style>@keyframes gspin{to{transform:rotate(360deg)}}</style>';
    document.body.appendChild(div);
  }

  function hideOverlay() {
    var el = document.getElementById('g-auth-overlay');
    if (el) el.remove();
  }

  function showAuthError(msg) {
    var el = document.getElementById('auth-error');
    if (!el) {
      el = document.createElement('p');
      el.id = 'auth-error';
      el.style.cssText = 'color:#f87171;font-size:0.85rem;text-align:center;margin-bottom:10px;';
      var btn = document.querySelector('.auth-submit');
      if (btn) btn.before(el);
      else document.body.prepend(el);
    }
    el.textContent = msg;
  }

  // ── Run ──────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      if (!checkUrlOnLoad()) listenForDeepLink();
    });
  } else {
    if (!checkUrlOnLoad()) listenForDeepLink();
  }

})();

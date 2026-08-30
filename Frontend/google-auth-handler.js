// google-auth-handler.js
// Handles the deep link anistrim://auth?code=xxx when app is opened
// Include on: login.html, signup.html, index.html
//
// This module does NOT use Google Identity Services (GIS),
// @capawesome/capacitor-google-sign-in, or Credential Manager.
// It relies on the Capacitor Browser OAuth redirect flow only.

(function () {
  'use strict';

  var BACKEND = (typeof window.getApiBaseUrl === 'function')
    ? window.getApiBaseUrl()
    : 'https://anistrimbackend.onrender.com';

  var _codeProcessed = false;

  function getCodeFromUrl(url) {
    try {
      var u = new URL(url);
      var code = u.searchParams.get('code');
      if (code) return code;
    } catch (e) { }
    var match = (url || '').match(/[?&]code=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  async function fetchAndLogin(code) {
    if (!code) return;
    if (_codeProcessed) {
      console.log('[GOOGLE-OAUTH-TRACE] Code already processed - skipping duplicate');
      return;
    }
    _codeProcessed = true;
    console.log('[GOOGLE-OAUTH-TRACE] fetchAndLogin START, code length:', code.length);

    showOverlay('Signing you in...');
    try {
      console.log('[GOOGLE-OAUTH-TRACE] token endpoint START');
      var res = await fetch(BACKEND + '/api/auth/google/token?code=' + encodeURIComponent(code));
      console.log('[GOOGLE-OAUTH-TRACE] token endpoint RESPONSE status:', res.status);
      var raw = await res.json();
      console.log('[GOOGLE-OAUTH-TRACE] token endpoint RESPONSE body keys:', Object.keys(raw || {}).join(', '));
      var data = (raw && raw.success === true && raw.data) ? raw.data : raw;

      if (!res.ok || !data.token) {
        console.log('[GOOGLE-OAUTH-TRACE] token endpoint FAILED:', data && data.message ? data.message : 'Unknown error');
        hideOverlay();
        showDLError(data && data.message ? data.message : 'Sign-in failed. Please try again.');
        return;
      }

      console.log('[GOOGLE-OAUTH-TRACE] token received (length:', data.token.length, ')');
      if (data.user) {
        try { 
          localStorage.setItem('user', JSON.stringify(data.user));
          console.log('[GOOGLE-OAUTH-TRACE] user saved to localStorage');
        } catch (e) {
          console.log('[GOOGLE-OAUTH-TRACE] ERROR saving user:', e.message);
        }
      } else {
        console.log('[GOOGLE-OAUTH-TRACE] WARNING: No user data in response');
      }
      localStorage.setItem('isFirstVisit', 'true');
      window.history.replaceState({}, document.title, window.location.pathname);
      hideOverlay();
      console.log('[GOOGLE-OAUTH-TRACE] redirectAfterAuthentication START');
      window.redirectAfterAuthentication(data.user, data.token, data.refreshToken);
    } catch (e) {
      hideOverlay();
      _codeProcessed = false;
      console.error('[GOOGLE-OAUTH-TRACE] Deep link auth error:', e);
      showDLError('Could not complete sign-in. Please check your connection and try again.');
    }
  }

  function checkUrlOnLoad() {
    var code = getCodeFromUrl(window.location.href);
    if (code) {
      fetchAndLogin(code);
      return true;
    }
    return false;
  }

  function listenForDeepLink() {
    if (typeof window.Capacitor === 'undefined') return;
    if (!window.Capacitor.Plugins || !window.Capacitor.Plugins.App) return;

    try {
      console.log('[GOOGLE-OAUTH-TRACE] Registering appUrlOpen listener');
      window.Capacitor.Plugins.App.addListener('appUrlOpen', function (data) {
        console.log('[GOOGLE-OAUTH-TRACE] appUrlOpen received, URL:', data && data.url ? data.url : 'none');
        if (!data || !data.url) return;
        if (!data.url.includes('anistrim://auth')) {
          console.log('[GOOGLE-OAUTH-TRACE] URL does not match anistrim://auth pattern');
          return;
        }
        console.log('[GOOGLE-OAUTH-TRACE] Deep link detected - anistrim://auth');
        try { window.Capacitor.Plugins.Browser.close(); } catch (e) {}
        if (data.url.includes('error=') || data.url.includes('auth-error')) {
          console.log('[GOOGLE-OAUTH-TRACE] Error URL detected, skipping');
          return;
        }
        var code = getCodeFromUrl(data.url);
        console.log('[GOOGLE-OAUTH-TRACE] extracted code =', code ? 'YES (length: ' + code.length + ')' : 'NO');
        if (code) {
          console.log('[GOOGLE-OAUTH-TRACE] Calling fetchAndLogin from appUrlOpen');
          fetchAndLogin(code);
        }
      });
    } catch (e) {
      console.log('[GOOGLE-OAUTH-TRACE] Deep link listener error:', e.message);
    }
  }

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

  function showDLError(msg) {
    var el = document.getElementById('auth-error');
    if (!el) {
      el = document.createElement('p');
      el.id = 'auth-error';
      el.style.cssText = 'color:#f87171;font-size:0.85rem;text-align:center;margin-bottom:10px;';
      var btn = document.querySelector('.auth-submit');
      if (btn && btn.parentNode) {
        btn.parentNode.insertBefore(el, btn.nextSibling);
      } else {
        document.body.prepend(el);
      }
    }
    el.textContent = msg;
  }

  // Expose helpers for login.js / signup.js browserPageLoaded listener
  // so the Capacitor Browser callback can be detected INSIDE the browser
  // without relying on Android intent delivery.
  window.__googleAuthGetCodeFromUrl = getCodeFromUrl;
  window.__googleAuthFetchAndLogin = fetchAndLogin;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      if (!checkUrlOnLoad()) listenForDeepLink();
    });
  } else {
    if (!checkUrlOnLoad()) listenForDeepLink();
  }
})();

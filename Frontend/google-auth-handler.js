// google-auth-handler.js
// Handles the deep link anistrim://auth?code=xxx when app is opened
// Include on: login.html, signup.html, index.html
//
// This module does NOT use Google Identity Services (GIS),
// @capawesome/capacitor-google-sign-in, or Credential Manager.
// It relies on the Capacitor Browser OAuth redirect flow only.
//
// Callback detection uses TWO mechanisms:
//   1. App.addListener('appUrlOpen', ...) — warm app deep links
//   2. App.getLaunchUrl() — cold start recovery
// Both call the same centralized handleGoogleOAuthCallback(url).

(function () {
  'use strict';

  var BACKEND = (typeof window.getApiBaseUrl === 'function')
    ? window.getApiBaseUrl()
    : 'https://anistrimbackend.onrender.com';

  var _codeProcessed = false;
  var _processing = false;

  function getCodeFromUrl(url) {
    try {
      var u = new URL(url);
      var code = u.searchParams.get('code');
      if (code) return code;
    } catch (e) { }
    var match = (url || '').match(/[?&]code=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function handleGoogleOAuthCallback(url) {
    console.log('[GOOGLE-OAUTH-TRACE] handleGoogleOAuthCallback called, url present:', !!url);
    if (!url) return;
    if (!url.includes('anistrim://auth')) {
      console.log('[GOOGLE-OAUTH-TRACE] URL does not match anistrim://auth pattern, ignoring');
      return;
    }
    if (url.includes('error=') || url.includes('auth-error')) {
      console.log('[GOOGLE-OAUTH-TRACE] Error URL detected, skipping');
      return;
    }
    var code = getCodeFromUrl(url);
    console.log('[GOOGLE-OAUTH-TRACE] extracted code =', code ? 'YES (length: ' + code.length + ')' : 'NO');
    if (!code) return;
    if (_codeProcessed) {
      console.log('[GOOGLE-OAUTH-TRACE] duplicate callback ignored - code already processed');
      return;
    }
    _codeProcessed = true;
    try {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
        console.log('[GOOGLE-OAUTH-TRACE] Closing browser');
        window.Capacitor.Plugins.Browser.close().catch(function () {});
      }
    } catch (e) {
      console.log('[GOOGLE-OAUTH-TRACE] browser close error (non-fatal):', e.message);
    }
    console.log('[GOOGLE-OAUTH-TRACE] Calling fetchAndLogin from handleGoogleOAuthCallback');
    fetchAndLogin(code);
  }

  async function fetchAndLogin(code) {
    if (!code) {
      _codeProcessed = false;
      _processing = false;
      return;
    }
    if (_processing) {
      console.log('[GOOGLE-OAUTH-TRACE] fetchAndLogin already in progress - skipping');
      return;
    }
    _processing = true;
    console.log('[GOOGLE-OAUTH-TRACE] fetchAndLogin START, code length:', code.length);
    showOverlay('Signing you in...');
    var controller = new AbortController();
    var timeoutId = setTimeout(function () {
      console.log('[GOOGLE-OAUTH-TRACE] fetch TIMEOUT after 15s - aborting');
      controller.abort();
    }, 15000);
    try {
      console.log('[GOOGLE-OAUTH-TRACE] token endpoint START');
      var res = await fetch(BACKEND + '/api/auth/google/token?code=' + encodeURIComponent(code), {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      console.log('[GOOGLE-OAUTH-TRACE] token endpoint RESPONSE status:', res.status);
      var raw = await res.json();
      console.log('[GOOGLE-OAUTH-TRACE] token endpoint RESPONSE body keys:', Object.keys(raw || {}).join(', '));
      var data = (raw && raw.success === true && raw.data) ? raw.data : raw;
      if (!res.ok || !data.token) {
        console.log('[GOOGLE-OAUTH-TRACE] token endpoint FAILED:', data && data.message ? data.message : 'Unknown error');
        _codeProcessed = false;
        _processing = false;
        showDLError(data && data.message ? data.message : 'Sign-in failed. Please try again.');
        return;
      }
      console.log('[GOOGLE-OAUTH-TRACE] authentication success - token received (length:', data.token.length, ')');
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
      console.log('[GOOGLE-OAUTH-TRACE] redirectAfterAuthentication START');
      hideOverlay();
      window.redirectAfterAuthentication(data.user, data.token, data.refreshToken);
      _processing = false;
      return;
    } catch (e) {
      clearTimeout(timeoutId);
      _codeProcessed = false;
      _processing = false;
      var errMsg = 'Could not complete sign-in. Please check your connection and try again.';
      if (e.name === 'AbortError') {
        console.error('[GOOGLE-OAUTH-TRACE] fetch ABORTED (timeout)');
        errMsg = 'Sign-in timed out. Please try again.';
      } else {
        console.error('[GOOGLE-OAUTH-TRACE] Deep link auth error:', e.message || e);
      }
      showDLError(errMsg);
    } finally {
      console.log('[GOOGLE-OAUTH-TRACE] overlay cleanup');
      hideOverlay();
    }
  }


  function checkUrlOnLoad() {
    var code = getCodeFromUrl(window.location.href);
    if (code) {
      console.log('[GOOGLE-OAUTH-TRACE] code found in page URL on load');
      handleGoogleOAuthCallback('anistrim://auth?code=' + encodeURIComponent(code));
      return true;
    }
    return false;
  }

  // appUrlOpen listener — handles warm-app deep links
  function listenForDeepLink() {
    if (typeof window.Capacitor === 'undefined') return;
    if (!window.Capacitor.Plugins || !window.Capacitor.Plugins.App) return;

    try {
      console.log('[GOOGLE-OAUTH-TRACE] Registering appUrlOpen listener');
      window.Capacitor.Plugins.App.addListener('appUrlOpen', function (data) {
        console.log('[GOOGLE-OAUTH-TRACE] appUrlOpen received, URL:', data && data.url ? data.url : 'none');
        if (!data || !data.url) return;
        handleGoogleOAuthCallback(data.url);
      });
    } catch (e) {
      console.log('[GOOGLE-OAUTH-TRACE] Deep link listener error:', e.message);
    }
  }

  // getLaunchUrl — handles cold-start recovery when Activity was recreated
  function checkLaunchUrl() {
    if (typeof window.Capacitor === 'undefined') return;
    if (!window.Capacitor.Plugins || !window.Capacitor.Plugins.App) return;
    if (typeof window.Capacitor.Plugins.App.getLaunchUrl !== 'function') {
      console.log('[GOOGLE-OAUTH-TRACE] getLaunchUrl not available');
      return;
    }

    try {
      console.log('[GOOGLE-OAUTH-TRACE] getLaunchUrl called');
      var launchData = window.Capacitor.Plugins.App.getLaunchUrl();

      // getLaunchUrl may return a Promise or a synchronous object
      if (launchData && typeof launchData.then === 'function') {
        launchData.then(function (result) {
          var url = result && result.url ? result.url : null;
          console.log('[GOOGLE-OAUTH-TRACE] getLaunchUrl resolved, URL:', url ? 'present' : 'none');
          if (url) {
            console.log('[GOOGLE-OAUTH-TRACE] launch URL detected');
            handleGoogleOAuthCallback(url);
          }
        }).catch(function (e) {
          console.log('[GOOGLE-OAUTH-TRACE] getLaunchUrl promise error:', e.message);
        });
      } else if (launchData && launchData.url) {
        console.log('[GOOGLE-OAUTH-TRACE] launch URL detected (sync)');
        handleGoogleOAuthCallback(launchData.url);
      } else {
        console.log('[GOOGLE-OAUTH-TRACE] getLaunchUrl returned no URL');
      }
    } catch (e) {
      console.log('[GOOGLE-OAUTH-TRACE] getLaunchUrl error:', e.message);
    }
  }

  // App resume handler — re-check launch URL when app becomes active
  function listenForAppResume() {
    if (typeof window.Capacitor === 'undefined') return;
    if (!window.Capacitor.Plugins || !window.Capacitor.Plugins.App) return;

    try {
      window.Capacitor.Plugins.App.addListener('appStateChange', function (data) {
        if (data && data.isActive) {
          console.log('[GOOGLE-OAUTH-TRACE] app became active, checking launch URL');
          checkLaunchUrl();
        }
      });
    } catch (e) {
      console.log('[GOOGLE-OAUTH-TRACE] appStateChange listener error:', e.message);
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

  // Expose helpers for login.js / signup.js
  window.__googleAuthGetCodeFromUrl = getCodeFromUrl;
  window.__googleAuthFetchAndLogin = fetchAndLogin;
  window.__googleAuthHandleCallback = handleGoogleOAuthCallback;

  // Initialize
  function init() {
    if (!checkUrlOnLoad()) {
      listenForDeepLink();
      // Check launch URL after a short delay to let the app settle
      setTimeout(checkLaunchUrl, 500);
      listenForAppResume();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

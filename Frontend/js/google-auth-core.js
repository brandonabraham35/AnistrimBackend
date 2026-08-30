  // ── Boot diagnostic — platform validation ─────────────────────────────────────────────────
  (function () {
    try {
      var isCapNative = typeof window.Capacitor !== "undefined" && !!window.Capacitor.isNativePlatform?.();
      if (!isCapNative) return;
      var hasPlugin = !!(window.Capacitor.Plugins && window.Capacitor.Plugins.GoogleSignIn);
      var hasInitFn = hasPlugin && typeof window.Capacitor.Plugins.GoogleSignIn.initialize === "function";
      var ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
      var isAndroid = ua.indexOf("Android") >= 0 || ua.indexOf("Linux") >= 0;
      var isIOS = !isAndroid && (ua.indexOf("iPhone") >= 0 || ua.indexOf("iPad") >= 0 || ua.indexOf("iPod") >= 0);
      var platformLabel = isAndroid ? "Android" : (isIOS ? "iOS" : "native-unknown");
      console.log("[GoogleAuth][CONFIG] Platform: " + platformLabel + " (com.anistrim.render)");
      if (isAndroid) {
        if (!hasPlugin) {
          console.error("[GoogleAuth][CONFIG] ** Android FAIL ** GoogleSignIn plugin NOT registered in capacitor.plugins.json");
        } else if (!hasInitFn) {
          console.error("[GoogleAuth][CONFIG] ** Android WARN ** GoogleSignIn plugin loaded but initialize() is not a function");
        } else {
          console.log("[GoogleAuth][CONFIG] Android: GoogleSignIn plugin registered OK");
          console.log("[GoogleAuth][CONFIG] Android: anistrim:// scheme in AndroidManifest.xml OK - deep links OK");
          console.log("[GoogleAuth][CONFIG] Android: INTERNET permission present");
          console.log("[GoogleAuth][CONFIG] Android: launchMode=singleTask - activity re-use OK");
          console.log("[GoogleAuth][CONFIG] Android: SHA-1/SHA-256 of debug AND release keystores must both be registered in Google Cloud Console");
        }
      }
      if (isIOS) {
        if (!hasPlugin) {
          console.error("[GoogleAuth][CONFIG] ** iOS FAIL ** GoogleSignIn plugin NOT in packageClassList");
        } else if (!hasInitFn) {
          console.error("[GoogleAuth][CONFIG] ** iOS WARN ** GoogleSignIn plugin loaded but initialize() is not a function");
        } else {
          console.log("[GoogleAuth][CONFIG] iOS: GoogleSignIn plugin registered OK");
        }
        console.warn("[GoogleAuth][CONFIG] ** iOS CHECK ** CFBundleURLTypes must be registered in Info.plist for anistrim:// + Google reversed-client-id");
      }
      console.log("[GoogleAuth][CONFIG] GoogleSignIn plugin: " + (hasPlugin ? "PRESENT" : "MISSING"));
      if (hasPlugin) console.log("[GoogleAuth][CONFIG] Plugin initialize(): " + (hasInitFn ? "OK" : "NOT A FUNCTION"));
      console.log("[GoogleAuth][CONFIG] Initialized: " + (!!window.__googleSignInInitialized ? "YES" : "NO (will lazy-init on tap)"));
      if (!hasPlugin) console.log("[GoogleAuth][CONFIG] Missing native Google configuration - sign-in may fall back to browser path");
    } catch (e) { console.error("[GoogleAuth][CONFIG] Diagnostic error:", (e && e.message) || String(e)); }
  })();﻿/**
 * google-auth-core.js
 * Shared Google Authentication Core for login/signup pages.
 */
(function () {
  'use strict';
  var _gState = 'IDLE';
  var _gAttemptId = null;
  var _gTimeoutId = null;
  var _gPausedWhileActive = false;
  var S = {
    IDLE: 'IDLE', INITIALIZING: 'INITIALIZING', READY: 'READY',
    SIGNING_IN: 'SIGNING_IN', EXCHANGING: 'EXCHANGING', PERSISTING: 'PERSISTING',
    VERIFYING: 'VERIFYING', NAVIGATING: 'NAVIGATING', SUCCESS: 'SUCCESS',
    CANCELLED: 'CANCELLED', TIMEOUT: 'TIMEOUT',
    NETWORK_ERROR: 'NETWORK_ERROR', BACKEND_ERROR: 'BACKEND_ERROR',
    CONFIG_ERROR: 'CONFIG_ERROR', PROVIDER_FAILURE: 'PROVIDER_FAILURE', UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  };
  var T = { INIT: 15000, SIGN_IN: 60000, BACKEND: 30000, PROVIDER: 30000, SESSION_VERIFY: 15000, NAVIGATION: 10000 };
  var E = {
    CANCELLED:        { code: 'AUTH_CANCELLED',           userMessage: '' },
    TIMEOUT:          { code: 'AUTH_TIMEOUT',             userMessage: 'Google sign-in is taking too long. Please try again.' },
    NETWORK:          { code: 'AUTH_NETWORK',             userMessage: 'Connection problem. Check your internet connection and try again.' },
    BACKEND:          { code: 'AUTH_BACKEND',             userMessage: "AniStrim couldn't complete your sign-in. Please try again." },
    INVALID_ID_TOKEN: { code: 'AUTH_INVALID_ID_TOKEN',    userMessage: "Google sign-in didn't complete. Please try again." },
    CONFIG:           { code: 'AUTH_NATIVE_CONFIGURATION',  userMessage: 'Google sign-in is temporarily unavailable. Please try another sign-in method.' },
    TRANSIENT:        { code: 'AUTH_TRANSIENT',           userMessage: "Google sign-in didn't complete. Please try again." },
    UNKNOWN:          { code: 'AUTH_UNKNOWN',             userMessage: 'Google sign-in failed. Please try again.' },
  };
  function _genId() { return Math.random().toString(16).substring(2, 10).toUpperCase(); }
  function _log(m) { console.log('[GoogleAuth][' + (_gAttemptId || '------') + '] ' + m); }
  function _err(m) { console.error('[GoogleAuth][' + (_gAttemptId || '------') + '] ' + m); }
  function _setState(s) { var prev = _gState; _gState = s; _log('State: ' + prev + ' -> ' + s); }
  function _clearT() { if (_gTimeoutId) { clearTimeout(_gTimeoutId); _gTimeoutId = null; } }
  function _setT(ms, fn) { _clearT(); _gTimeoutId = setTimeout(fn, ms); }
  function _reset() { _clearT(); _gState = 'IDLE'; _gAttemptId = null; _gPausedWhileActive = false; try { sessionStorage.removeItem('__authPending'); } catch (e) {} }
  function _isActive() { return _gState === S.SIGNING_IN || _gState === S.EXCHANGING || _gState === S.PERSISTING || _gState === S.VERIFYING || _gState === S.NAVIGATING; }
  window.__GoogleAuth = {
    STATES: S, TIMEOUTS: T, ERRORS: E,
    log: _log, err: _err, setState: _setState, clearTimeout: _clearT, setTimeout: _setT, reset: _reset, genId: _genId,
    get state() { return _gState; },
    get attemptId() { return _gAttemptId; }, set attemptId(v) { _gAttemptId = v; },
    get isActive() { return _isActive(); },
    get pausedWhileActive() { return _gPausedWhileActive; }, set pausedWhileActive(v) { _gPausedWhileActive = v; },
    audit: function () {
      var r = { platform: null, packageId: null, googleSignInPlugin: false, configOk: false, warnings: [] };
      try {
        if (typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform?.()) {
          r.platform = 'native'; r.packageId = 'com.anistrim.render';
          r.googleSignInPlugin = !!(window.Capacitor.Plugins && window.Capacitor.Plugins.GoogleSignIn);
          r.configOk = r.googleSignInPlugin;
          if (window.__googleSignInInitialized) r.initialized = true;
          else if (window.__googleSignInInitInProgress) r.initializing = true;
        } else if (typeof window.Capacitor !== 'undefined') { r.platform = 'capacitor-but-not-native'; }
        else { r.platform = 'browser'; }
      } catch (e) { r.warnings.push('audit-error: ' + (e.message || String(e))); }
      return r;
    },
  };
  var _auth = window.__GoogleAuth;
  (function () {
    try {
      var c = typeof window.Capacitor !== 'undefined' && !!window.Capacitor.isNativePlatform?.();
      if (!c) return;
      var hp = !!(window.Capacitor.Plugins && window.Capacitor.Plugins.GoogleSignIn);
      var hf = hp && typeof window.Capacitor.Plugins.GoogleSignIn.initialize === 'function';
      var hi = !!window.__googleSignInInitialized;
      console.log('[GoogleAuth][CONFIG] Platform: Capacitor native');
      console.log('[GoogleAuth][CONFIG] Package ID: com.anistrim.render');
      console.log('[GoogleAuth][CONFIG] GoogleSignIn plugin: ' + (hp ? 'PRESENT' : 'MISSING'));
      if (hp) console.log('[GoogleAuth][CONFIG] Plugin initialize: ' + (hf ? 'OK' : 'NOT A FUNCTION'));
      console.log('[GoogleAuth][CONFIG] Initialized: ' + (hi ? 'YES' : 'NO (will lazy-init on tap)'));
      if (hp && !hf) console.warn('[GoogleAuth][CONFIG] WARNING: GoogleSignIn plugin loaded but initialize() missing');
    } catch (e) { console.error('[GoogleAuth][CONFIG] Diagnostic error:', (e && e.message) || String(e)); }
  })();
  function doInit() {
    if (window.__googleSignInInitInProgress) return window.__googleSignInInitInProgress;
    if (window.__googleSignInInitialized) { _auth.setState(S.READY); return Promise.resolve(); }
    if (typeof window.Capacitor === 'undefined' || !window.Capacitor.isNativePlatform?.()) { return Promise.resolve(); }
    var p = window.Capacitor.Plugins?.GoogleSignIn;
    if (!p || typeof p.initialize !== 'function') { return Promise.resolve(); }
    _auth.setState(S.INITIALIZING);
    var rp; window.__googleSignInInitInProgress = new Promise(function (r) { rp = r; });
    var to = false; var it = setTimeout(function () { to = true; window.__googleSignInInitInProgress = null; rp(); }, T.INIT);
    var bu = (typeof window.getApiBaseUrl === 'function') ? window.getApiBaseUrl() : 'https://anistrimbackend.onrender.com';
    var cid = function () {
      var url = bu + '/api/auth/google/client-id';
      var o = { headers: { 'Accept': 'application/json' } };
      if (typeof window.fetchWithRetry === 'function') return window.fetchWithRetry(url, o, { timeout: 20000, retries: 2 });
      return fetch(url, o);
    };
    cid().then(function (res) { return res.json(); })
    .then(function (data) {
      if (to) return;
      var c = (data && data.success === true && data.data) ? data.data.clientId : data.clientId;
      if (c) { return p.initialize({ clientId: c }).then(function () { window.__googleSignInInitialized = true; _auth.setState(S.READY); }); }
    }).catch(function (e) { if (!to) console.error('[GoogleAuth][INIT] Failed:', e?.message || e); })
    .finally(function () { clearTimeout(it); window.__googleSignInInitInProgress = null; rp(); });
    return window.__googleSignInInitInProgress;
  }
  window.__ensureGoogleSignInInit = function () {
    if (typeof window.Capacitor === 'undefined' || !window.Capacitor.isNativePlatform?.()) return Promise.resolve();
    return doInit();
  };
  var si = function () { doInit(); };
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', si); } else { si(); }
  window.setGoogleBtnLoading = function (text) {
    var b = document.getElementById('google-login-btn') || document.getElementById('google-signup-btn');
    var l = document.getElementById('google-btn-text'); if (b) b.disabled = true; if (l) l.textContent = text || 'Signing in\u2026';
  };
  window.setGoogleBtnReady = function () {
    var b = document.getElementById('google-login-btn') || document.getElementById('google-signup-btn');
    var l = document.getElementById('google-btn-text'); if (b) b.disabled = false; if (l) l.textContent = 'Continue with Google';
  };
  window.showError = function (msg) {
    if (!msg) return; var el = document.getElementById('auth-error');
    if (!el) {
      el = document.createElement('p'); el.id = 'auth-error'; el.style.cssText = 'color:#f87171;font-size:0.85rem;text-align:center;margin-bottom:10px;';
      var b = document.getElementById('google-login-btn') || document.getElementById('google-signup-btn');
      if (b && b.parentNode) { b.parentNode.insertBefore(el, b.nextSibling); }
      else { var s = document.querySelector('.auth-submit'); if (s && s.parentNode) s.parentNode.insertBefore(el, s); }
    }
    el.style.display = 'block'; el.textContent = msg;
    if (el._clearTimer) clearTimeout(el._clearTimer);
    el._clearTimer = setTimeout(function () { if (el && el.parentNode) { el.style.display = 'none'; el.textContent = ''; } }, 10000);
  };
  var CapApp = window.Capacitor?.Plugins?.App;
  if (CapApp?.addListener) {
    CapApp.addListener('appStateChange', function (state) {
      if (!_auth) return;
      if (!state.isActive && _auth.isActive) { _auth.pausedWhileActive = true; _auth.log('App paused while auth active'); }
      else if (state.isActive && _auth.pausedWhileActive) {
        _auth.pausedWhileActive = false; _auth.log('App resumed after pause during auth');
        if (_auth.isActive) { _auth.log('Auth still active after resume - continuing'); }
        else {
          var pg = window.location.pathname.split('/').pop();
          if (pg === 'login.html' || pg === 'signup.html') {
            var st = (window.Auth && window.Auth.token) || localStorage.getItem('token') || localStorage.getItem('anistrim.mobile.token') || '';
            if (st && window.State && window.State.isLoggedIn) {
              _auth.log('Resume recovery - session valid, navigating');
              var rp2 = ''; try { rp2 = sessionStorage.getItem('__loginRedirect') || ''; } catch (e) {}
              if (window.Navigation && window.Navigation.afterAuth) { window.Navigation.afterAuth(window.State.user, rp2); }
              else { window.location.replace(rp2 || 'index.html'); }
            } else if (_auth.state !== 'SUCCESS' && _auth.state !== 'CANCELLED') {
              _auth.err('Resume recovery - auth failed while paused');
              window.setGoogleBtnReady(); window.showError('Google sign-in was interrupted. Please try again.');
            }
          }
        }
      }
    });
  }
})();

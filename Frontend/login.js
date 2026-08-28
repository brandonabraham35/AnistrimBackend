// login.js — BACKEND defined in scrpt.js
//
// Google login supports two environments:
//   • Native (Capacitor WebView): Native Google Sign-In via the
//     @capawesome/capacitor-google-sign-in plugin. Returns an idToken
//     directly to JavaScript — no browser, no deep links, no race conditions.
//   • Web (plain browser): Google Identity Services (GIS) via the shared
//     google-auth-handler.js module.
//
// Email/password login uses the shared apiFetch wrapper (js/api.js), which
// handles 403 (requiresVerification → OTP screen), 401 (clear + login.html),
// and throws ApiError with a friendly message for other errors.
//
// No ES-module imports are used — this file is a plain script, matching the
// rest of the codebase, so it runs in the raw WebView without a bundler.

// ── Capacitor plugin handles (present only inside the native app) ──
const CapBrowser = window.Capacitor?.Plugins?.Browser;
const CapApp     = window.Capacitor?.Plugins?.App;
const CapGoogleSignIn = window.Capacitor?.Plugins?.GoogleSignIn;
const isNative   = !!window.Capacitor?.isNativePlatform?.();

// ── Single-use guard for deep-link callback processing ──
// Prevents the same login code from being consumed twice when both
// login.js and google-auth-handler.js receive the same appUrlOpen event.
var _googleCallbackProcessed = false;

// ── Google Auth Reliability (native path only) ────────────
// Single state machine, timeouts, error types for native Google sign-in.
// The web GIS path (google-auth-handler.js) has its own authInProgress guard.
(function () {
  'use strict';

  var _gState = 'IDLE';
  var _gAttemptId = null;
  var _gTimeoutId = null;
  var _gPausedWhileActive = false;

  var S = {
    IDLE: 'IDLE',
    READY: 'READY',
    SIGNING_IN: 'SIGNING_IN',
    EXCHANGING: 'EXCHANGING',
    PERSISTING: 'PERSISTING',
    VERIFYING: 'VERIFYING',
    NAVIGATING: 'NAVIGATING',
    SUCCESS: 'SUCCESS',
    CANCELLED: 'CANCELLED',
    TIMEOUT: 'TIMEOUT',
    NETWORK_ERROR: 'NETWORK_ERROR',
    BACKEND_ERROR: 'BACKEND_ERROR',
    CONFIG_ERROR: 'CONFIG_ERROR',
    UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  };

  var T = {
    SIGN_IN: 60000,
    BACKEND: 30000,
    SESSION_VERIFY: 15000,
    NAVIGATION: 10000,
  };

  var E = {
    CANCELLED:        { code: 'AUTH_CANCELLED',          userMessage: '' },
    TIMEOUT:          { code: 'AUTH_TIMEOUT',            userMessage: 'Google sign-in is taking too long. Please try again.' },
    NETWORK:          { code: 'AUTH_NETWORK',            userMessage: 'Connection problem. Check your internet connection and try again.' },
    BACKEND:          { code: 'AUTH_BACKEND',            userMessage: "AniStrim couldn't complete your sign-in. Please try again." },
    INVALID_ID_TOKEN: { code: 'AUTH_INVALID_ID_TOKEN',   userMessage: "Google sign-in didn't complete. Please try again." },
    CONFIG:           { code: 'AUTH_NATIVE_CONFIGURATION', userMessage: 'Google sign-in is temporarily unavailable. Please try another sign-in method.' },
    TRANSIENT:        { code: 'AUTH_TRANSIENT',          userMessage: "Google sign-in didn't complete. Please try again." },
    UNKNOWN:          { code: 'AUTH_UNKNOWN',            userMessage: 'Google sign-in failed. Please try again.' },
  };

  function _genId() { return Math.random().toString(16).substring(2, 10).toUpperCase(); }
  function _log(m)   { console.log('[GoogleAuth][' + (_gAttemptId || '------') + '] ' + m); }
  function _err(m)   { console.error('[GoogleAuth][' + (_gAttemptId || '------') + '] ' + m); }

  function _setState(s) {
    var prev = _gState;
    _gState = s;
    _log('State: ' + prev + ' \u2192 ' + s);  // arrow character
  }

  function _clearT() { if (_gTimeoutId) { clearTimeout(_gTimeoutId); _gTimeoutId = null; } }

  function _setT(ms, fn) { _clearT(); _gTimeoutId = setTimeout(fn, ms); }

  function _reset() {
    _clearT();
    _gState = 'IDLE';
    _gAttemptId = null;
    _gPausedWhileActive = false;
    // ── Recovery: clear pending flag on every reset
    try { sessionStorage.removeItem('__authPending'); } catch (e) {}
  }

  // Expose on window — consumed by loginWithInAppBrowser() and login.html init IIFE.
  window.__GoogleAuth = {
    STATES: S,
    TIMEOUTS: T,
    ERRORS: E,
    log: _log,
    err: _err,
    setState: _setState,
    clearTimeout: _clearT,
    setTimeout: _setT,
    reset: _reset,
    genId: _genId,
    get state() { return _gState; },
    get attemptId() { return _gAttemptId; },
    set attemptId(v) { _gAttemptId = v; },
    get isActive() { return _gState === S.SIGNING_IN || _gState === S.EXCHANGING || _gState === S.PERSISTING || _gState === S.VERIFYING || _gState === S.NAVIGATING; },
    get pausedWhileActive() { return _gPausedWhileActive; },
    set pausedWhileActive(v) { _gPausedWhileActive = v; },
    // ── Configuration audit (development diagnostic) ─────────
    // Reports native configuration status without exposing secrets.
    // Called once at boot and exposed for console inspection.
    audit: function () {
      var report = { platform: null, packageId: null, googleSignInPlugin: false, configOk: false, warnings: [] };
      try {
        if (typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform?.()) {
          report.platform = 'native';
          report.packageId = 'com.anistrim.render';
          report.googleSignInPlugin = !!(window.Capacitor.Plugins && window.Capacitor.Plugins.GoogleSignIn);
          report.configOk = report.googleSignInPlugin;
          // Check init status
          if (window.__googleSignInInitialized) {
            report.initialized = true;
          } else if (window.__googleSignInInitInProgress) {
            report.initializing = true;
          }
        } else if (typeof window.Capacitor !== 'undefined') {
          report.platform = 'capacitor-but-not-native';
        } else {
          report.platform = 'browser';
        }
      } catch (e) {
        report.warnings.push('audit-error: ' + (e.message || String(e)));
      }
      return report;
    },
  };

  // ── Boot diagnostic ──────────────────────────────────────
  // Safe configuration check — never exposes secrets.
  // Logs diagnostic at application start so developers can see
  // whether native Google Sign-In is wired correctly.
  (function () {
    try {
      var isCapNative = typeof window.Capacitor !== 'undefined' && !!window.Capacitor.isNativePlatform?.();
      if (!isCapNative) return;
      var hasPlugin = !!(window.Capacitor.Plugins && window.Capacitor.Plugins.GoogleSignIn);
      var hasInitFn = hasPlugin && typeof window.Capacitor.Plugins.GoogleSignIn.initialize === 'function';
      var hasInitFlag = !!window.__googleSignInInitialized;
      var prefix = '[GoogleAuth][CONFIG]';
      console.log(prefix + ' Platform: Capacitor native');
      console.log(prefix + ' Package ID: com.anistrim.render');
      console.log(prefix + ' GoogleSignIn plugin: ' + (hasPlugin ? 'PRESENT' : 'MISSING'));
      if (hasPlugin) {
        console.log(prefix + ' Plugin initialize: ' + (hasInitFn ? 'OK' : 'NOT A FUNCTION'));
      }
      console.log(prefix + ' Initialized: ' + (hasInitFlag ? 'YES' : 'NO (will lazy-init on tap)'));
      if (hasPlugin && !hasInitFn) {
        console.warn(prefix + ' WARNING: GoogleSignIn plugin loaded but initialize() missing');
      }
    } catch (e) {
      console.error('[GoogleAuth][CONFIG] Diagnostic error:', (e && e.message) || String(e));
    }
  })();
})();

// ── Google button state helpers ───────────────────────────
function setGoogleBtnLoading(text) {
  var btn = document.getElementById('google-login-btn');
  var lbl = document.getElementById('google-btn-text');
  if (btn) btn.disabled = true;
  if (lbl) lbl.textContent = text || 'Signing in\u2026';
}
function setGoogleBtnReady() {
  var btn = document.getElementById('google-login-btn');
  var lbl = document.getElementById('google-btn-text');
  if (btn) btn.disabled = false;
  if (lbl) lbl.textContent = 'Continue with Google';
}

// ── Email/Password Login ────────────────────────────────────
async function handleLogin() {
  const email    = document.getElementById('login-email')?.value?.trim();
  const password = document.getElementById('login-pass')?.value;
  const btn      = document.querySelector('.auth-submit');

  if (!email || !password) { showError('Please fill in all fields.'); return; }
  btn.textContent = 'Signing in...';
  btn.disabled = true;

  // apiFetch returns the envelope { ok, status, data }. On 403 requiresVerification
  // it fires resend-otp and redirects to the OTP screen; on 401 it clears the
  // token and redirects to login.html. Other failures come back via ok:false.
  const { ok, data } = await window.apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
    resendOtp: true
  });

  if (ok && data && data.token) {
    // Analytics: track login
    if (window.trackEvent) window.trackEvent('login');
    // Store both access + refresh tokens via the canonical helper.
    if (window.setAuthTokens) window.setAuthTokens(data.token, data.refreshToken);
    else localStorage.setItem('token', data.token);
    localStorage.setItem('isFirstVisit', 'true');
    // Use the canonical session + navigation contract.
    const redirectParam = new URLSearchParams(window.location.search).get('redirect');
    const user = data.user || (await window.Session?.refresh?.());
    window.redirectAfterAuthentication?.(user, data.token, data.refreshToken);
    return;
  }

  showError((data && data.message) || 'Incorrect email or password.');
  btn.textContent = 'Sign In';
  btn.disabled = false;
}
window.handleLogin = handleLogin;

// ── Google Login (native + web) ─────────────────────────────
async function loginWithInAppBrowser() {
  // NATIVE PATH: Use the native Google Sign-In plugin (already installed).
  // This returns an idToken directly — no browser, no deep links.
  // Uses the shared __GoogleAuth state machine for reliability.
  if (isNative && CapGoogleSignIn) {
    var _auth = window.__GoogleAuth;
    if (!_auth) { showError('Auth state machine not initialized.'); return; }

    // ── Guard: prevent duplicate taps ────────────────────
    if (_auth.isActive) {
      _auth.log('Duplicate tap prevented — auth already active');
      return;
    }

    var _aid = _auth.genId();
    _auth.attemptId = _aid;
    _auth.log('Attempt started');
    setGoogleBtnLoading();

    // ── Recovery: mark auth as pending so a kill/reload mid-flight recovers
    try { sessionStorage.setItem('__authPending', '1'); } catch (e) {}

    try {
      // ── Ensure initialization ──────────────────────────
      // __googleSignInInitInProgress is cleared to null once init settles.
      var initWasInFlight = !!window.__googleSignInInitInProgress;
      if (initWasInFlight) {
        _auth.log('Init still in progress — waiting');
        await window.__googleSignInInitInProgress;
      }
      // Lazy init: only when NO init is in flight and none has ever completed.
      if (!window.__googleSignInInitialized && !initWasInFlight && typeof window.__ensureGoogleSignInInit === 'function') {
        _auth.log('Plugin not yet initialized — lazy init');
        await window.__ensureGoogleSignInInit();
      }
      if (!window.__googleSignInInitialized) {
        _auth.err('Plugin not initialized — can\'t sign in');
        setGoogleBtnReady();
        showError(_auth.ERRORS.CONFIG.userMessage);
        _auth.reset();
        return;
      }

      // ── Start native sign-in with timeout ──────────────
      _auth.setState('SIGNING_IN');
      _auth.log('Native sign-in started');
      _auth.setTimeout(_auth.TIMEOUTS.SIGN_IN, function () {
        _auth.log('Sign-in timed out after ' + _auth.TIMEOUTS.SIGN_IN + 'ms');
        _auth.setState('TIMEOUT');
        setGoogleBtnReady();
        showError(_auth.ERRORS.TIMEOUT.userMessage);
        _auth.reset();
      });

      var result = await CapGoogleSignIn.signIn();
      _auth.clearTimeout();

      // ── Handle result ──────────────────────────────────
      // Log result structure (never the credential values themselves).
      _auth.log('Native sign-in succeeded');
      _auth.log('Result keys: ' + (result ? Object.keys(result).join(', ') : 'null'));
      _auth.log('Has idToken: ' + !!(result && result.idToken));

      if (!result || !result.idToken) {
        _auth.err('No idToken in result');
        setGoogleBtnReady();
        showError(_auth.ERRORS.INVALID_ID_TOKEN.userMessage);
        _auth.reset();
        return;
      }

      _auth.log('ID token present:', Boolean(result.idToken));
      await sendIdTokenToBackend(result.idToken);
      // sendIdTokenToBackend handles persistence, verification, and navigation.
      // On success it resets the state machine; on failure it shows error and resets.
      return;
    } catch (err) {
      _auth.clearTimeout();

      var errCode = (err && err.code) || 'UNKNOWN';
      var errMsg = (err && err.message) || String(err);
      _auth.err('Sign-in error — code=' + errCode + ' msg=' + errMsg);

      // User cancelled — silent return
      if (errCode === 'SIGN_IN_CANCELED') {
        _auth.log('User cancelled');
        _auth.setState('CANCELLED');
        setGoogleBtnReady();
        _auth.reset();
        return;
      }

      // Configuration errors — not retryable
      if (errCode === 'NOT_INITIALIZED' || errMsg.toLowerCase().indexOf('not initialized') >= 0 ||
          errCode === 'CLIENT_ID_MISSING' || errMsg.indexOf('clientId') >= 0) {
        _auth.setState('CONFIG_ERROR');
        setGoogleBtnReady();
        showError(_auth.ERRORS.CONFIG.userMessage);
        _auth.reset();
        return;
      }

      // All other errors — transient
      _auth.setState('TRANSIENT_ERROR');
      setGoogleBtnReady();
      showError(_auth.ERRORS.TRANSIENT.userMessage);
      _auth.reset();
    }
    return;
  }

  // FALLBACK PATH: In-App Browser OAuth (legacy, kept for environments
  // where the native plugin is not available or not configured).
  const oauthUrl = `${BACKEND}/api/auth/google/start?intent=login`;

  if (isNative && CapBrowser) {
    console.log('[GoogleAuth] OAuth started — In-App Browser fallback');
    try {
      await CapBrowser.open({ url: oauthUrl, windowName: '_blank' });
    } catch (err) {
      console.error('[GoogleAuth] In-App Browser error:', err?.message || err);
      showError('Could not open Google sign-in. Please try again.');
    }
    return;
  }

  // WEB PATH: Google Identity Services (GIS) via google-auth-handler.js
  try {
    const response = await window.initGoogleAuth('google-login-btn');
    if (!response || !response.credential) {
      showError('Google sign-in failed. No credential received.');
      return;
    }
    console.log('[GoogleAuth] Callback received — web GIS returned credential');
    await sendIdTokenToBackend(response.credential);
  } catch (err) {
    console.error('[GoogleAuth] Web GIS auth error:', err?.message || err);
  }
}
window.loginWithInAppBrowser = loginWithInAppBrowser;

// Send the ID token to POST /api/auth/google/verify
// Used by both native path (with __GoogleAuth state machine) and web GIS path.
// When called from the native path, __GoogleAuth provides state tracking, timeouts,
// attempt IDs, and error classification.
async function sendIdTokenToBackend(idToken) {
  var _auth = window.__GoogleAuth;
  var _isNative = _auth && (_auth.attemptId || _auth.isActive);

  // ── State tracking ─────────────────────────────────────
  if (_isNative) {
    _auth.setState('EXCHANGING');
    _auth.log('Backend exchange started — POST /api/auth/google/verify');
    _auth.setTimeout(_auth.TIMEOUTS.BACKEND, function () {
      _auth.log('Backend timed out after ' + _auth.TIMEOUTS.BACKEND + 'ms');
      _auth.setState('TIMEOUT');
      setGoogleBtnReady();
      showError(_auth.ERRORS.TIMEOUT.userMessage);
      _auth.reset();
    });
  } else {
    console.log('[GoogleAuth][BACKEND] ID token present:', Boolean(idToken));
  }

  // ── Backend request ─────────────────────────────────────
  const { ok, data } = await window.apiFetch('/api/auth/google/verify', {
    method: 'POST',
    body: JSON.stringify({ idToken })
  });

  if (_isNative) _auth.clearTimeout();

  // ── Success ─────────────────────────────────────────────
  if (ok && data && data.token && data.user) {
    if (!_isNative) {
      console.log('[GoogleAuth][BACKEND] Response: 200 — OK');
      console.log('[GoogleAuth][BACKEND] Token received:', !!data.token);
      console.log('[GoogleAuth][BACKEND] User received:', !!data.user);
    } else {
      _auth.log('Backend exchange succeeded — status 200');
    }

    // ── Persist session ────────────────────────────────────
    if (_isNative) {
      _auth.setState('PERSISTING');
      _auth.log('Session persistence started');
    }

    try {
      if (window.setAuthTokens) window.setAuthTokens(data.token, data.refreshToken);
      else localStorage.setItem('token', data.token);
      // Write user DTO
      try { localStorage.setItem('user', JSON.stringify(data.user)); } catch (e) { /* non-fatal */ }
      localStorage.setItem('isFirstVisit', 'true');
    } catch (e) {
      var persistErr = e && e.message ? e.message : String(e);
      if (_isNative) {
        _auth.err('Session persistence failed: ' + persistErr);
        _auth.setState('UNKNOWN_ERROR');
      } else {
        console.error('[GoogleAuth] Token persistence failed:', persistErr);
      }
      setGoogleBtnReady();
      showError('Could not save session. Please try again.');
      if (_isNative) _auth.reset();
      return;
    }

    if (_isNative) _auth.log('Session persisted');

    // ── Verify session ─────────────────────────────────────
    if (_isNative) {
      _auth.setState('VERIFYING');
      _auth.log('Session verification started');
      // Check that the token was actually written to storage.
      var stored = (window.Auth && window.Auth.token) || localStorage.getItem('token') || localStorage.getItem('anistrim.mobile.token') || '';
      if (!stored) {
        _auth.err('Session verification failed — no token in storage');
        setGoogleBtnReady();
        showError('Could not save session. Please try again.');
        _auth.reset();
        return;
      }
      _auth.log('Session verified');
    }

    // ── Navigate ───────────────────────────────────────────
    if (_isNative) {
      _auth.setState('NAVIGATING');
      _auth.log('Navigation started');
    } else {
      console.log('[GoogleAuth] Redirecting after authentication');
    }

    // ── Clear pending flag before navigation
    try { sessionStorage.removeItem('__authPending'); } catch (e) {}

    window.redirectAfterAuthentication?.(data.user, data.token, data.refreshToken);

    // ── Navigation watchdog ─────────────────────────────────
    // If navigation fails (redirectAfterAuthentication is undefined, throws,
    // or the redirect is blocked), we're still on login.html with a valid
    // session. Detect this and recover.
    if (_isNative) {
      _auth.setTimeout(_auth.TIMEOUTS.NAVIGATION, function () {
        var stillOnLogin = window.location.pathname.split('/').pop() === 'login.html';
        if (stillOnLogin) {
          _auth.err('Navigation watchdog — still on login.html after ' + _auth.TIMEOUTS.NAVIGATION + 'ms');
          // Session was already verified — attempt recovery redirect
          var stored = (window.Auth && window.Auth.token) || localStorage.getItem('token') || localStorage.getItem('anistrim.mobile.token') || '';
          if (stored && window.State && window.State.isLoggedIn) {
            _auth.log('Navigation watchdog — session valid, recovering');
            var redirectParam = '';
            try { redirectParam = sessionStorage.getItem('__loginRedirect') || ''; } catch (e) {}
            if (window.Navigation && window.Navigation.afterAuth) {
              window.Navigation.afterAuth(window.State.user, redirectParam);
            } else {
              window.location.replace(redirectParam || 'index.html');
            }
          } else {
            _auth.err('Navigation watchdog — no valid session, showing error');
            setGoogleBtnReady();
            showError('Sign-in completed but navigation failed. Please try again.');
          }
          _auth.reset();
        }
      });
    }

    // ── Terminal success ────────────────────────────────────
    if (_isNative) {
      _auth.setState('SUCCESS');
      _auth.log('Authentication complete');
      _auth.reset();
    }
    return;
  }

  // ── Backend error — classify ────────────────────────────
  var code = data && data.code;
  var msg = (data && data.message) || 'Google sign-in failed. Please try again.';
  var isServerError = !ok && (!data || data.status >= 500 || data.status === 429 || data.status === 0);

  if (code === 'GOOGLE_ACCOUNT_NOT_FOUND')           msg = 'No AniStrim account exists for this Google account. Please create an account first.';
  else if (code === 'GOOGLE_ACCOUNT_NOT_LINKED')     msg = 'An AniStrim account already exists with this email. Please log in using your email and password.';
  else if (code === 'ACCOUNT_SUSPENDED')              msg = 'This account has been suspended.';
  else if (code === 'ACCOUNT_DEACTIVATED')            msg = 'This account has been deactivated.';
  else if (code === 'ACCOUNT_DELETED')                msg = 'This account has been deleted.';
  else if (isServerError)                             msg = "AniStrim couldn't complete your sign-in. Please try again.";

  if (_isNative) {
    _auth.err('Backend error — code=' + (code || 'none') + ' ok=' + ok);
    _auth.setState(isServerError ? 'BACKEND_ERROR' : 'BACKEND_ERROR');
  } else {
    console.error('[GoogleAuth] Backend verification failed:', data || ok);
  }

  setGoogleBtnReady();
  showError(msg);
  if (_isNative) _auth.reset();
}

// ── Deep Link Handler (native only — fallback for legacy browser OAuth) ──
// This handler is the fallback path for the legacy In-App Browser OAuth flow.
// It processes anistrim://auth?code=XXX deep links delivered via appUrlOpen.
// A single-use guard prevents duplicate processing when multiple listeners
// are registered (login.js + google-auth-handler.js).
async function handleAppUrlOpen(data) {
  // Single-use guard: prevent the same callback from being processed twice
  if (_googleCallbackProcessed) {
    console.log('[GoogleAuth] Callback already processed — ignoring duplicate');
    return;
  }

  try {
    await CapBrowser?.close();
  } catch (e) {
    // Browser may already be closed — safe to ignore
  }

  if (!data || !data.url) return;

  try {
    console.log('[GoogleAuth] Callback URL parsed:', data.url.split('?')[0] + '?...');
    const url = new URL(data.url);
    const token = url.searchParams.get('token');

    if (token) {
      console.log('[GoogleAuth] Token detected — direct token path');
      _googleCallbackProcessed = true;
      if (window.setAuthTokens) window.setAuthTokens(token, null);
      else { localStorage.setItem('session_token', token); localStorage.setItem('token', token); }
      console.log('[GoogleAuth] Tokens persisted');
      const user = JSON.parse(localStorage.getItem('user') || 'null');
      console.log('[GoogleAuth] User persisted');
      console.log('[GoogleAuth] Redirecting after authentication');
      window.redirectAfterAuthentication?.(user, token, null);
      return;
    }

    const code = url.searchParams.get('code');
    if (code) {
      console.log('[GoogleAuth] Login code detected — code exchange path');
      _googleCallbackProcessed = true;
      console.log('[GoogleAuth] Login code exchange started — GET /api/auth/google/token');
      const res = await fetch(`${BACKEND}/api/auth/google/token?code=${encodeURIComponent(code)}`);
      const raw2 = await res.json();
      const data2 = (raw2 && raw2.success === true && raw2.data) ? raw2.data : raw2;
      if (res.ok && data2.token) {
        console.log('[GoogleAuth] Login code exchange succeeded');
        if (window.setAuthTokens) window.setAuthTokens(data2.token, data2.refreshToken);
        else { localStorage.setItem('session_token', data2.token); localStorage.setItem('token', data2.token); }
        console.log('[GoogleAuth] Tokens persisted');
        if (data2.user) localStorage.setItem('user', JSON.stringify(data2.user));
        console.log('[GoogleAuth] User persisted');
        localStorage.setItem('isFirstVisit', 'true');
        console.log('[GoogleAuth] Redirecting after authentication');
        window.redirectAfterAuthentication?.(data2.user, data2.token, data2.refreshToken);
      } else {
        // Code may have already been consumed by another handler — check for
        // the specific "invalid or expired" message to avoid showing a generic
        // error when the login actually succeeded elsewhere.
        if (data2.message && data2.message.includes('invalid or expired')) {
          console.log('[GoogleAuth] Login code already consumed by another handler — login may have succeeded');
          // Don't show an error — the other handler may have already redirected.
          // Check if we're still on login.html and if tokens exist.
          var hasToken = localStorage.getItem('anistrim.mobile.token') ||
                         localStorage.getItem('token') ||
                         localStorage.getItem('session_token');
          if (hasToken && window.State && window.State.isLoggedIn) {
            console.log('[GoogleAuth] Tokens found — redirecting anyway');
            window.redirectAfterAuthentication?.(window.State.user, hasToken, null);
          }
        } else {
          showError(data2.message || 'Google sign-in failed. Please try again.');
        }
      }
      return;
    }

    if (url.href.includes('auth-error')) {
      showError('Google sign-in was cancelled or failed.');
    }
  } catch (err) {
    console.error('[GoogleAuth] Deep link parse error:', err?.message || err);
  }
}

// Register the deep link listener (native only)
if (CapApp?.addListener) {
  CapApp.addListener('appUrlOpen', handleAppUrlOpen);
  console.log('[GoogleAuth] appUrlOpen listener registered');
}

// ── Error Display ─────────────────────────────────────────
function showError(msg) {
  if (!msg) return;
  let el = document.getElementById('auth-error');
  if (!el) {
    el = document.createElement('p');
    el.id = 'auth-error';
    el.style.cssText = 'color:#f87171;font-size:0.85rem;text-align:center;margin-bottom:10px;';
    const btn = document.getElementById('google-login-btn');
    if (btn && btn.parentNode) {
      btn.parentNode.insertBefore(el, btn.nextSibling);
    } else {
      document.querySelector('.auth-submit')?.before(el);
    }
  }
  el.style.display = 'block';
  el.textContent = msg;
  if (el._clearTimer) clearTimeout(el._clearTimer);
  el._clearTimer = setTimeout(() => {
    if (el && el.parentNode) {
      el.style.display = 'none';
      el.textContent = '';
    }
  }, 10000);
}

// ── Event Listeners ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // ── Stale auth attempt recovery ─────────────────────────
  // If the page was killed/reloaded while auth was in progress,
  // the pending flag is still set. Clear it and restore the UI.
  var _auth = window.__GoogleAuth;
  if (_auth) {
    var hadPending = false;
    try { hadPending = sessionStorage.getItem('__authPending') === '1'; } catch (e) {}
    if (hadPending) {
      _auth.log('Stale auth attempt detected on load — clearing');
      try { sessionStorage.removeItem('__authPending'); } catch (e) {}
      // Ensure button is restored (auth was interrupted).
      setGoogleBtnReady();
      // If we have a valid session, the login.html recovery layer already
      // redirected. If we're here, auth didn't complete — show a message.
      var stored = (window.Auth && window.Auth.token) || localStorage.getItem('token') || localStorage.getItem('anistrim.mobile.token') || '';
      if (!stored || !window.State || !window.State.isLoggedIn) {
        showError('Previous sign-in was interrupted. Please try again.');
      }
    }
  }

  document.getElementById('google-login-btn')?.addEventListener('click', loginWithInAppBrowser);

  document.getElementById('login-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });
  document.getElementById('login-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });
});

// ── App Lifecycle (pause/resume during native Google auth) ─
// Google's native account selector is an overlay that does NOT pause the app,
// but some In-App Browser fallback paths may cause the app to go into the
// background. We must NOT reset the auth attempt on pause — only note it.
// On resume, we check whether the auth attempt is still valid or needs recovery.
if (CapApp?.addListener && window.__GoogleAuth) {
  CapApp.addListener('appStateChange', function (state) {
    var _auth = window.__GoogleAuth;
    if (!_auth) return;
    if (!state.isActive && _auth.isActive) {
      // App backgrounded while auth is pending — note it, do NOT reset.
      _auth.pausedWhileActive = true;
      _auth.log('App paused while auth active');
    } else if (state.isActive && _auth.pausedWhileActive) {
      // App resumed after being paused during auth — check state.
      _auth.pausedWhileActive = false;
      _auth.log('App resumed after pause during auth');
      if (_auth.isActive) {
        // Auth still pending — continue waiting (timeouts still running).
        _auth.log('Auth still active after resume — continuing');
      } else {
        // Auth completed while paused — check if we're still on login.html
        // (navigation may not have completed while app was backgrounded).
        var stillOnLogin = window.location.pathname.split('/').pop() === 'login.html';
        if (stillOnLogin) {
          var stored = (window.Auth && window.Auth.token) || localStorage.getItem('token') || localStorage.getItem('anistrim.mobile.token') || '';
          if (stored && window.State && window.State.isLoggedIn) {
            _auth.log('Resume recovery — session valid, navigating');
            var redirectParam = '';
            try { redirectParam = sessionStorage.getItem('__loginRedirect') || ''; } catch (e) {}
            if (window.Navigation && window.Navigation.afterAuth) {
              window.Navigation.afterAuth(window.State.user, redirectParam);
            } else {
              window.location.replace(redirectParam || 'index.html');
            }
          } else if (_auth.state !== 'SUCCESS' && _auth.state !== 'CANCELLED') {
            // Auth failed while paused — ensure UI is restored.
            _auth.err('Resume recovery — auth failed while paused');
            setGoogleBtnReady();
            showError('Google sign-in was interrupted. Please try again.');
          }
        }
      }
    }
  });
}

// Export globally
window.handleLogin = handleLogin;
window.loginWithInAppBrowser = loginWithInAppBrowser;
window.showError = showError;

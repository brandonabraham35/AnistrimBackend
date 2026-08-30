// login.js â€” BACKEND defined in scrpt.js
//
// Google login supports two environments:
//   â€¢ Native (Capacitor WebView): Native Google Sign-In via the
//     @capawesome/capacitor-google-sign-in plugin. Returns an idToken
//     directly to JavaScript â€” no browser, no deep links, no race conditions.
//   â€¢ Web (plain browser): Google Identity Services (GIS) via the shared
//     google-auth-handler.js module.
//
// Email/password login uses the shared apiFetch wrapper (js/api.js), which
// handles 403 (requiresVerification â†’ OTP screen), 401 (clear + login.html),
// and throws ApiError with a friendly message for other errors.
//
// No ES-module imports are used â€” this file is a plain script, matching the
// rest of the codebase, so it runs in the raw WebView without a bundler.

// â”€â”€ Capacitor plugin handles (present only inside the native app) â”€â”€
const CapBrowser = window.Capacitor?.Plugins?.Browser;
const CapApp     = window.Capacitor?.Plugins?.App;
const CapGoogleSignIn = window.Capacitor?.Plugins?.GoogleSignIn;
const isNative   = !!window.Capacitor?.isNativePlatform?.();

// â”€â”€ Single-use guard for deep-link callback processing â”€â”€
// Prevents the same login code from being consumed twice when both
// login.js and google-auth-handler.js receive the same appUrlOpen event.
var _googleCallbackProcessed = false;

// â”€â”€ Email/Password Login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Google Login (native + web) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loginWithInAppBrowser() {
  // NATIVE PATH: Use the native Google Sign-In plugin (already installed).
  // This returns an idToken directly â€” no browser, no deep links.
  // Uses the shared __GoogleAuth state machine for reliability.
  if (isNative && CapGoogleSignIn) {
    var _auth = window.__GoogleAuth;
    if (!_auth) { showError('Auth state machine not initialized.'); return; }

    // â”€â”€ Guard: prevent duplicate taps â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (_auth.isActive) {
      _auth.log('Duplicate tap prevented â€” auth already active');
      return;
    }

    var _aid = _auth.genId();
    _auth.attemptId = _aid;
    _auth.log('Attempt started');
    setGoogleBtnLoading();

    // â”€â”€ Recovery: mark auth as pending so a kill/reload mid-flight recovers
    try { sessionStorage.setItem('__authPending', '1'); } catch (e) {}

    try {
      // â”€â”€ Ensure initialization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // __googleSignInInitInProgress is cleared to null once init settles.
      var initWasInFlight = !!window.__googleSignInInitInProgress;
      if (initWasInFlight) {
        _auth.log('Init still in progress â€” waiting');
        await window.__googleSignInInitInProgress;
      }
      // Lazy init: only when NO init is in flight and none has ever completed.
      if (!window.__googleSignInInitialized && !initWasInFlight && typeof window.__ensureGoogleSignInInit === 'function') {
        _auth.log('Plugin not yet initialized â€” lazy init');
        await window.__ensureGoogleSignInInit();
      }
      if (!window.__googleSignInInitialized) {
        _auth.err('Plugin not initialized â€” can\'t sign in');
        setGoogleBtnReady();
        showError(_auth.ERRORS.CONFIG.userMessage);
        _auth.reset();
        return;
      }

      // â”€â”€ Start native sign-in with timeout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

      // â”€â”€ Handle result â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Log result structure (never the credential values themselves).
      _auth.log('Native sign-in succeeded');
      _auth.log('Result keys: ' + (result ? Object.keys(result).join(', ') : 'null'));
      _auth.log('Duration: ' + (Date.now() - (_auth.DIAG ? _auth.DIAG.signInStart || Date.now() : Date.now())) + 'ms');
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
      _auth.err('Sign-in error â€” code=' + errCode + ' msg=' + errMsg);

      // User cancelled â€” silent return
      if (errCode === 'SIGN_IN_CANCELED') {
        _auth.log('User cancelled');
        _auth.setState('CANCELLED');
        setGoogleBtnReady();
        _auth.reset();
        return;
      }

      // Configuration errors â€” not retryable
      if (errCode === 'NOT_INITIALIZED' || errMsg.toLowerCase().indexOf('not initialized') >= 0 ||
          errCode === 'CLIENT_ID_MISSING' || errMsg.indexOf('clientId') >= 0) {
        _auth.setState('CONFIG_ERROR');
        setGoogleBtnReady();
        showError(_auth.ERRORS.CONFIG.userMessage);
        _auth.reset();
        return;
      }

      // All other errors â€” transient
            if (errCode === 'CREDENTIAL_CONFIG_FAILURE') {
              _auth.log('Credential config failure');
              _auth.setState('CONFIG_ERROR');
              setGoogleBtnReady();
              showError(_auth.ERRORS.CONFIG.userMessage);
              _auth.reset();
              return;
            }
            if (errCode === 'CREDENTIAL_NO_CREDENTIAL') {
              _auth.log('No saved credential');
              _auth.setState('CONFIG_ERROR');
              setGoogleBtnReady();
              showError(_auth.ERRORS.CONFIG.userMessage);
              _auth.reset();
              return;
            }
            if (errCode === 'CREDENTIAL_PROVIDER_FAILURE') {
              _auth.log('Provider error');
              _auth.setState('PROVIDER_FAILURE');
              setGoogleBtnReady();
              showError(_auth.ERRORS.TRANSIENT.userMessage);
              _auth.reset();
              return;
            }
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
    console.log('[GoogleAuth] OAuth started â€” In-App Browser fallback');
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
    console.log('[GoogleAuth] Callback received â€” web GIS returned credential');
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

  // â”€â”€ State tracking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (_isNative) {
    _auth.setState('EXCHANGING');
    _auth.log('Backend exchange started â€” POST /api/auth/google/verify');
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

  // â”€â”€ Backend request â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var _timeoutMs = 30000;
  if (_isNative && _auth.TIMEOUTS && _auth.TIMEOUTS.BACKEND) {
    _timeoutMs = _auth.TIMEOUTS.BACKEND;
  }
  var fetchRes = await window.apiFetch('/api/auth/google/verify', {
    method: 'POST',
    body: JSON.stringify({ idToken }),
    timeout: _timeoutMs
  });
  var ok = fetchRes.ok;
  var data = fetchRes.data;
  var timedOut = fetchRes.timedOut;

  if (_isNative) _auth.clearTimeout();

  if (timedOut) {
    if (_isNative) {
      _auth.setState('TIMEOUT');
      _auth.log('Backend request timed out');
    } else {
      console.log('[GoogleAuth][BACKEND] Request timed out');
    }
    setGoogleBtnReady();
    showError('Google sign-in is taking too long. Please try again.');
    if (_isNative) _auth.reset();
    return;
  }

  if (_isNative) _auth.setState('BACKEND_RESPONSE');

  if (_isNative) _auth.clearTimeout();

  // â”€â”€ Success â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (ok && data && data.token && data.user) {
    if (!_isNative) {
      console.log('[GoogleAuth][BACKEND] Response: 200 â€” OK');
      console.log('[GoogleAuth][BACKEND] Token received:', !!data.token);
      console.log('[GoogleAuth][BACKEND] User received:', !!data.user);
    } else {
      _auth.log('Backend exchange succeeded â€” status 200');
    }

    // â”€â”€ Persist session â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ Verify session â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (_isNative) {
      _auth.setState('VERIFYING');
      _auth.log('Session verification started');
      // Check that the token was actually written to storage.
      var stored = (window.Auth && window.Auth.token) || localStorage.getItem('token') || localStorage.getItem('anistrim.mobile.token') || '';
      if (!stored) {
        _auth.err('Session verification failed â€” no token in storage');
        setGoogleBtnReady();
        showError('Could not save session. Please try again.');
        _auth.reset();
        return;
      }
      _auth.log('Session verified');
    }

    // â”€â”€ Navigate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (_isNative) {
      _auth.setState('NAVIGATING');
      _auth.log('Navigation started');
    } else {
      console.log('[GoogleAuth] Redirecting after authentication');
    }

    // â”€â”€ Clear pending flag before navigation
    try { sessionStorage.removeItem('__authPending'); } catch (e) {}

    window.redirectAfterAuthentication?.(data.user, data.token, data.refreshToken);

    // â”€â”€ Navigation watchdog â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // If navigation fails (redirectAfterAuthentication is undefined, throws,
    // or the redirect is blocked), we're still on login.html with a valid
    // session. Detect this and recover.
    if (_isNative) {
      _auth.setTimeout(_auth.TIMEOUTS.NAVIGATION, function () {
        var stillOnLogin = window.location.pathname.split('/').pop() === 'login.html';
        if (stillOnLogin) {
          _auth.err('Navigation watchdog â€” still on login.html after ' + _auth.TIMEOUTS.NAVIGATION + 'ms');
          // Session was already verified â€” attempt recovery redirect
          var stored = (window.Auth && window.Auth.token) || localStorage.getItem('token') || localStorage.getItem('anistrim.mobile.token') || '';
          if (stored && window.State && window.State.isLoggedIn) {
            _auth.log('Navigation watchdog â€” session valid, recovering');
            var redirectParam = '';
            try { redirectParam = sessionStorage.getItem('__loginRedirect') || ''; } catch (e) {}
            if (window.Navigation && window.Navigation.afterAuth) {
              window.Navigation.afterAuth(window.State.user, redirectParam);
            } else {
              window.location.replace(redirectParam || 'index.html');
            }
          } else {
            _auth.err('Navigation watchdog â€” no valid session, showing error');
            setGoogleBtnReady();
            showError('Sign-in completed but navigation failed. Please try again.');
          }
          _auth.reset();
        }
      });
    }

    // â”€â”€ Terminal success â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (_isNative) {
      _auth.setState('SUCCESS');
      _auth.log('Authentication complete');
      _auth.reset();
    }
    return;
  }

  // â”€â”€ Backend error â€” classify â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    _auth.err('Backend error â€” code=' + (code || 'none') + ' ok=' + ok);
    _auth.setState(isServerError ? 'BACKEND_ERROR' : 'BACKEND_ERROR');
  } else {
    console.error('[GoogleAuth] Backend verification failed: code=' + ((data && data.code) || 'none') + ' ok=' + ok);
  }

  setGoogleBtnReady();
  showError(msg);
  if (_isNative) _auth.reset();
}

// â”€â”€ Deep Link Handler (native only â€” fallback for legacy browser OAuth) â”€â”€
// This handler is the fallback path for the legacy In-App Browser OAuth flow.
// It processes anistrim://auth?code=XXX deep links delivered via appUrlOpen.
// A single-use guard prevents duplicate processing when multiple listeners
// are registered (login.js + google-auth-handler.js).
async function handleAppUrlOpen(data) {
  // Single-use guard: prevent the same callback from being processed twice
  if (_googleCallbackProcessed) {
    console.log('[GoogleAuth] Callback already processed â€” ignoring duplicate');
    return;
  }

  try {
    await CapBrowser?.close();
  } catch (e) {
    // Browser may already be closed â€” safe to ignore
  }

  if (!data || !data.url) return;

  try {
    console.log('[GoogleAuth] Callback URL parsed:', data.url.split('?')[0] + '?...');
    const url = new URL(data.url);
    const token = url.searchParams.get('token');

    if (token) {
      console.log('[GoogleAuth] Token detected â€” direct token path');
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
      console.log('[GoogleAuth] Login code detected â€” code exchange path');
      _googleCallbackProcessed = true;
      console.log('[GoogleAuth] Login code exchange started â€” GET /api/auth/google/token');
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
        // Code may have already been consumed by another handler â€” check for
        // the specific "invalid or expired" message to avoid showing a generic
        // error when the login actually succeeded elsewhere.
        if (data2.message && data2.message.includes('invalid or expired')) {
          console.log('[GoogleAuth] Login code already consumed by another handler â€” login may have succeeded');
          // Don't show an error â€” the other handler may have already redirected.
          // Check if we're still on login.html and if tokens exist.
          var hasToken = localStorage.getItem('anistrim.mobile.token') ||
                         localStorage.getItem('token') ||
                         localStorage.getItem('session_token');
          if (hasToken && window.State && window.State.isLoggedIn) {
            console.log('[GoogleAuth] Tokens found â€” redirecting anyway');
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

// â”€â”€ Event Listeners â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.addEventListener('DOMContentLoaded', () => {
  // â”€â”€ Stale auth attempt recovery â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // If the page was killed/reloaded while auth was in progress,
  // the pending flag is still set. Clear it and restore the UI.
  var _auth = window.__GoogleAuth;
  if (_auth) {
    var hadPending = false;
    try { hadPending = sessionStorage.getItem('__authPending') === '1'; } catch (e) {}
    if (hadPending) {
      _auth.log('Stale auth attempt detected on load â€” clearing');
      try { sessionStorage.removeItem('__authPending'); } catch (e) {}
      // Ensure button is restored (auth was interrupted).
      setGoogleBtnReady();
      // If we have a valid session, the login.html recovery layer already
      // redirected. If we're here, auth didn't complete â€” show a message.
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

// â”€Export globally
window.handleLogin = handleLogin;
window.loginWithInAppBrowser = loginWithInAppBrowser;

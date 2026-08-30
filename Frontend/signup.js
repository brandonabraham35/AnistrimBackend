// signup.js â€” BACKEND defined in scrpt.js
//
// Google sign-up supports two environments:
//   â€¢ Native (Capacitor WebView): In-App Browser OAuth via the Capacitor
//     Browser + App plugins (accessed off the window.Capacitor global).
//   â€¢ Web (plain browser): Google Identity Services (GIS) via the shared
//     google-auth-handler.js module.
//
// Manual email/password registration uses the shared apiFetch wrapper
// (js/api.js), which throws ApiError on failure and handles 401/403 globally.
//
// No ES-module imports are used â€” this file is a plain script, matching the
// rest of the codebase, so it runs in the raw WebView without a bundler.

// â”€â”€ Capacitor plugin handles (present only inside the native app) â”€â”€
const CapBrowser = window.Capacitor?.Plugins?.Browser;
const CapApp     = window.Capacitor?.Plugins?.App;
const CapGoogleSignIn = window.Capacitor?.Plugins?.GoogleSignIn;
const isNative   = !!window.Capacitor?.isNativePlatform?.();

// â”€â”€ Single-use guard for deep-link callback processing â”€â”€
var _googleCallbackProcessed = false;

// â”€â”€ Email/Password Sign Up â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function handleSignUp() {
  const name     = document.getElementById('signup-name')?.value?.trim();
  const email    = document.getElementById('signup-email')?.value?.trim();
  const password = document.getElementById('signup-pass')?.value;
  const btn      = document.querySelector('.auth-submit');

  if (!name || !email || !password) { showError('Please fill in all fields.'); return; }
  if (password.length < 6) { showError('Password must be at least 6 characters.'); return; }

  btn.textContent = 'Creating account...';
  btn.disabled = true;

  // apiFetch returns the envelope { ok, status, data }. 201 requiresVerification
  // is handled by the data.requiresVerification branch below (a "success" for
  // the OTP funnel). 401/403 redirects are handled globally by js/api.js.
  const { ok, data } = await window.apiFetch('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ name, email, password })
  });

  // New registration returns 201 + requiresVerification â†’ send the user to
  // the OTP funnel. Do NOT store a token (the 201 body carries none).
  if (data && data.requiresVerification) {
    sessionStorage.setItem('pendingEmail', email);
    const emailSent = data.emailSent ? '1' : '0';
    sessionStorage.setItem('otpEmailSent', emailSent);
    window.location.href = `verify-otp.html?email=${encodeURIComponent(email)}&emailSent=${emailSent}`;
    return;
  }

  // EMAIL_SEND_FAILED (502): the account could NOT be created/verified because
  // the OTP email failed to send. NEVER silently redirect â€” surface a clear,
  // actionable error so the user knows to retry.
  if (!ok && data && data.code === 'EMAIL_SEND_FAILED') {
    showError(data.message || "We couldn't send your verification email. Please try again.");
    btn.textContent = 'Create Account';
    btn.disabled = false;
    return;
  }

  if (ok && data && data.token) {
    if (window.setAuthTokens) window.setAuthTokens(data.token, data.refreshToken);
    else localStorage.setItem('token', data.token);
    localStorage.setItem('isFirstVisit', 'true');
    window.redirectAfterAuthentication(data.user, data.token, data.refreshToken);
    return;
  }

  showError((data && data.message) || 'Registration failed. Please try again.');
  btn.textContent = 'Create Account';
  btn.disabled = false;
}
window.handleSignUp = handleSignUp;

// â”€â”€ Google Sign Up (native + web) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loginWithInAppBrowser() {
  // NATIVE PATH: Use the native Google Sign-In plugin.
  if (isNative && CapGoogleSignIn) {
    var _auth = window.__GoogleAuth;
    if (!_auth) { showError('Auth state machine not initialized.'); return; }
    if (_auth.isActive) {
      _auth.log('Duplicate tap prevented - auth already active (signup)');
      return;
    }
    var _aid = _auth.genId();
    _auth.attemptId = _aid;
    _auth.log('Attempt started');
    setGoogleBtnLoading();
    try { sessionStorage.setItem('__authPending', '1'); } catch (e) {}
    try {
      var initWasInFlight = !!window.__googleSignInInitInProgress;
      if (initWasInFlight) {
        _auth.log('Init still in progress - waiting');
        await window.__googleSignInInitInProgress;
      }
      if (!window.__googleSignInInitialized && !initWasInFlight && typeof window.__ensureGoogleSignInInit === 'function') {
        _auth.log('Plugin not yet initialized - lazy init');
        await window.__ensureGoogleSignInInit();
      }
      if (!window.__googleSignInInitialized) {
        _auth.err('Plugin not initialized - cant sign in');
        setGoogleBtnReady();
        showError(_auth.ERRORS.CONFIG.userMessage);
        _auth.reset();
        return;
      }
      _auth.setState('SIGNING_IN');
      _auth.log('Native sign-in started (signup)');
      _auth.setTimeout(_auth.TIMEOUTS.SIGN_IN, function () {
        _auth.log('Sign-in timed out after ' + _auth.TIMEOUTS.SIGN_IN + 'ms');
        _auth.setState('TIMEOUT');
        setGoogleBtnReady();
        showError(_auth.ERRORS.TIMEOUT.userMessage);
        _auth.reset();
      });
      var result = await CapGoogleSignIn.signIn();
      _auth.clearTimeout();
      _auth.log('Native sign-in succeeded (signup)');
      _auth.log('Result keys: ' + (result ? Object.keys(result).join(', ') : 'null'));
      _auth.log('Has idToken: ' + !!(result && result.idToken));
      if (!result || !result.idToken) {
        _auth.err('No idToken in result');
        setGoogleBtnReady();
        showError(_auth.ERRORS.INVALID_ID_TOKEN.userMessage);
        _auth.reset();
        return;
      }
      await sendIdTokenToBackend(result.idToken);
      return;
    } catch (err) {
      _auth.clearTimeout();
      var errCode = (err && err.code) || 'UNKNOWN';
      var errMsg = (err && err.message) || String(err);
      _auth.err('Sign-in error - code=' + errCode + ' msg=' + errMsg);
      if (errCode === 'SIGN_IN_CANCELED') {
        _auth.log('User cancelled (signup)');
        _auth.setState('CANCELLED');
        setGoogleBtnReady();
        _auth.reset();
        return;
      }
      if (errCode === 'NOT_INITIALIZED' || errMsg.toLowerCase().indexOf('not initialized') >= 0 ||
          errCode === 'CLIENT_ID_MISSING' || errMsg.indexOf('clientId') >= 0) {
        _auth.setState('CONFIG_ERROR');
        setGoogleBtnReady();
        showError(_auth.ERRORS.CONFIG.userMessage);
        _auth.reset();
        return;
      }
      _auth.setState('TRANSIENT_ERROR');
      setGoogleBtnReady();
      showError(_auth.ERRORS.TRANSIENT.userMessage);
      _auth.reset();
    }
    return;
  }  // FALLBACK PATH: In-App Browser OAuth (legacy).
  const oauthUrl = `${BACKEND}/api/auth/google/start?intent=signup`;

  if (isNative && CapBrowser) {
    console.log('[GoogleAuth] OAuth started â€” In-App Browser fallback (signup)');
    try {
      await CapBrowser.open({ url: oauthUrl, windowName: '_blank' });
    } catch (err) {
      console.error('[GoogleAuth] In-App Browser error (signup):', err?.message || err);
      showError('Could not open Google sign-in. Please try again.');
    }
    return;
  }

  // WEB PATH: Google Identity Services (GIS).
  try {
    const response = await window.initGoogleAuth('google-signup-btn');
    if (!response || !response.credential) {
      showError('Google sign-in failed. No credential received.');
      return;
    }
    console.log('[GoogleAuth] Callback received â€” web GIS returned credential (signup)');
    await sendIdTokenToBackend(response.credential);
  } catch (err) {
    console.error('[GoogleAuth] Web GIS auth error (signup):', err?.message || err);
  }
}
window.loginWithInAppBrowser = loginWithInAppBrowser;

// Send the ID token to POST /api/auth/google/verify (web GIS flow)
async function sendIdTokenToBackend(idToken) {
  var _auth = window.__GoogleAuth;
  var _isNative = _auth && (_auth.attemptId || _auth.isActive);

  if (_isNative) {
    _auth.setState('EXCHANGING');
    _auth.log('Backend exchange started - POST /api/auth/google/signup');
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

  const { ok, data } = await window.apiFetch('/api/auth/google/signup', {
    method: 'POST',
    body: JSON.stringify({ idToken })
  });

  if (_isNative) _auth.clearTimeout();

  if (ok && data && data.token && data.user) {
    if (_isNative) {
      _auth.log('Backend exchange succeeded - status 200');
    } else {
      console.log('[GoogleAuth][BACKEND] Response: 200 - OK');
      console.log('[GoogleAuth][BACKEND] Token received:', !!data.token);
      console.log('[GoogleAuth][BACKEND] User received:', !!data.user);
    }
    if (_isNative) {
      _auth.setState('PERSISTING');
      _auth.log('Session persistence started');
    }
    try {
      if (window.setAuthTokens) window.setAuthTokens(data.token, data.refreshToken);
      else localStorage.setItem('token', data.token);
      try { localStorage.setItem('user', JSON.stringify(data.user)); } catch (e) {}
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
    if (_isNative) {
      _auth.setState('VERIFYING');
      _auth.log('Session verification started');
      var stored = (window.Auth && window.Auth.token) || localStorage.getItem('token') || localStorage.getItem('anistrim.mobile.token') || '';
      if (!stored) {
        _auth.err('Session verification failed - no token in storage');
        setGoogleBtnReady();
        showError('Could not save session. Please try again.');
        _auth.reset();
        return;
      }
      _auth.log('Session verified');
    }
    if (_isNative) {
      _auth.setState('NAVIGATING');
      _auth.log('Navigation started');
    } else {
      console.log('[GoogleAuth] Redirecting after authentication');
    }
    try { sessionStorage.removeItem('__authPending'); } catch (e) {}
    window.redirectAfterAuthentication?.(data.user, data.token, data.refreshToken);
    if (_isNative) {
      _auth.setTimeout(_auth.TIMEOUTS.NAVIGATION, function () {
        var stillOnSignup = window.location.pathname.split('/').pop() === 'signup.html';
        if (stillOnSignup) {
          _auth.err('Navigation watchdog - still on signup.html after ' + _auth.TIMEOUTS.NAVIGATION + 'ms');
          var stored2 = (window.Auth && window.Auth.token) || localStorage.getItem('token') || localStorage.getItem('anistrim.mobile.token') || '';
          if (stored2 && window.State && window.State.isLoggedIn) {
            _auth.log('Navigation watchdog - session valid, recovering');
            if (window.Navigation && window.Navigation.afterAuth) {
              window.Navigation.afterAuth(window.State.user, '');
            } else {
              window.location.replace('index.html');
            }
          } else {
            _auth.err('Navigation watchdog - no valid session, showing error');
            setGoogleBtnReady();
            showError('Sign-in completed but navigation failed. Please try again.');
          }
          _auth.reset();
        }
      });
    }
    if (_isNative) {
      _auth.setState('SUCCESS');
      _auth.log('Authentication complete');
      _auth.reset();
    }
    return;
  }

  var code = data && data.code;
  var msg = (data && data.message) || 'Google sign-in failed. Please try again.';
  if (code === 'ACCOUNT_ALREADY_EXISTS') msg = 'An AniStrim account already exists with this email or Google account. Please log in instead.';

  if (_isNative) {
    _auth.err('Backend error - code=' + (code || 'none') + ' ok=' + ok);
    _auth.setState('BACKEND_ERROR');
  } else {
    console.error('[GoogleAuth] Backend verification failed (signup): code=' + ((data && data.code) || 'none') + ' ok=' + ok);
  }

  setGoogleBtnReady();
  showError(msg);
  if (_isNative) _auth.reset();
}// â”€â”€ Deep Link Handler (native only â€” fallback for legacy browser OAuth) â”€â”€
async function handleAppUrlOpen(data) {
  // Single-use guard: prevent the same callback from being processed twice
  if (_googleCallbackProcessed) {
    console.log('[GoogleAuth] Callback already processed â€” ignoring duplicate (signup)');
    return;
  }

  try {
    await CapBrowser?.close();
  } catch (e) {
    // Browser may already be closed â€” safe to ignore
  }

  if (!data || !data.url) return;

  try {
    console.log('[GoogleAuth] Callback URL parsed (signup):', data.url.split('?')[0] + '?...');
    const url = new URL(data.url);
    const token = url.searchParams.get('token');

    if (token) {
      console.log('[GoogleAuth] Token detected â€” direct token path (signup)');
      _googleCallbackProcessed = true;
      if (window.setAuthTokens) window.setAuthTokens(token, null);
      else { localStorage.setItem('session_token', token); localStorage.setItem('token', token); }
      console.log('[GoogleAuth] Tokens persisted (signup)');
      console.log('[GoogleAuth] Redirecting after authentication (signup)');
      window.redirectAfterAuthentication(JSON.parse(localStorage.getItem('user') || 'null'), token, null);
      return;
    }

    const code = url.searchParams.get('code');
    if (code) {
      console.log('[GoogleAuth] Login code detected â€” code exchange path (signup)');
      _googleCallbackProcessed = true;
      console.log('[GoogleAuth] Login code exchange started â€” GET /api/auth/google/token (signup)');
      const res = await fetch(`${BACKEND}/api/auth/google/token?code=${encodeURIComponent(code)}`);
      const raw2 = await res.json();
      const data2 = (raw2 && raw2.success === true && raw2.data) ? raw2.data : raw2;
      if (res.ok && data2.token) {
        console.log('[GoogleAuth] Login code exchange succeeded (signup)');
        if (window.setAuthTokens) window.setAuthTokens(data2.token, data2.refreshToken);
        else { localStorage.setItem('session_token', data2.token); localStorage.setItem('token', data2.token); }
        console.log('[GoogleAuth] Tokens persisted (signup)');
        if (data2.user) localStorage.setItem('user', JSON.stringify(data2.user));
        console.log('[GoogleAuth] User persisted (signup)');
        localStorage.setItem('isFirstVisit', 'true');
        console.log('[GoogleAuth] Redirecting after authentication (signup)');
        window.redirectAfterAuthentication(data2.user, data2.token, data2.refreshToken);
      } else {
        if (data2.message && data2.message.includes('invalid or expired')) {
          console.log('[GoogleAuth] Login code already consumed by another handler (signup)');
          var hasToken = localStorage.getItem('anistrim.mobile.token') ||
                         localStorage.getItem('token') ||
                         localStorage.getItem('session_token');
          if (hasToken && window.State && window.State.isLoggedIn) {
            console.log('[GoogleAuth] Tokens found â€” redirecting anyway (signup)');
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
    console.error('[GoogleAuth] Deep link parse error (signup):', err?.message || err);
  }
}

if (CapApp?.addListener) {
  CapApp.addListener('appUrlOpen', handleAppUrlOpen);
}

// â”€â”€ Event Listeners â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('google-signup-btn')?.addEventListener('click', loginWithInAppBrowser);

  document.getElementById('signup-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSignUp();
  });
});

// Export globally
window.handleSignUp = handleSignUp;
window.loginWithInAppBrowser = loginWithInAppBrowser;

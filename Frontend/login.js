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
  if (isNative && CapGoogleSignIn) {
    try {
      console.log('[GoogleAuth] OAuth started — native Google Sign-In');
      const result = await CapGoogleSignIn.signIn();
      if (!result || !result.idToken) {
        showError('Google sign-in failed. No credential received.');
        return;
      }
      console.log('[GoogleAuth] Callback received — native Google Sign-In returned idToken');
      await sendIdTokenToBackend(result.idToken);
    } catch (err) {
      // User canceled the sign-in flow
      if (err && err.code === 'SIGN_IN_CANCELED') {
        console.log('[GoogleAuth] User canceled Google sign-in');
        return;
      }
      console.error('[GoogleAuth] Native Google sign-in error:', err?.message || err);
      showError('Google sign-in failed. Please try again.');
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

// Send the ID token to POST /api/auth/google/verify (web GIS flow)
async function sendIdTokenToBackend(idToken) {
  console.log('[GoogleAuth] Login code exchange started — POST /api/auth/google/verify');
  const { ok, data } = await window.apiFetch('/api/auth/google/verify', {
    method: 'POST',
    body: JSON.stringify({ idToken })
  });

  if (ok && data && data.token && data.user) {
    console.log('[GoogleAuth] Login code exchange succeeded');
    if (window.setAuthTokens) window.setAuthTokens(data.token, data.refreshToken);
    else localStorage.setItem('token', data.token);
    console.log('[GoogleAuth] Tokens persisted');
    localStorage.setItem('user', JSON.stringify(data.user));
    console.log('[GoogleAuth] User persisted');
    localStorage.setItem('isFirstVisit', 'true');
    const redirectParam = new URLSearchParams(window.location.search).get('redirect');
    console.log('[GoogleAuth] Redirecting after authentication');
    window.redirectAfterAuthentication?.(data.user, data.token, data.refreshToken);
    return;
  }

  console.error('[GoogleAuth] Backend verification failed:', data || ok);
  // Distinguish the Google login business errors for a clear message.
  const code = data && data.code;
  let msg = (data && data.message) || 'Google sign-in failed. Please try again.';
  if (code === 'GOOGLE_ACCOUNT_NOT_FOUND') msg = 'No AniStrim account exists for this Google account. Please create an account first.';
  else if (code === 'GOOGLE_ACCOUNT_NOT_LINKED') msg = 'An AniStrim account already exists with this email. Please log in using your email and password.';
  else if (code === 'ACCOUNT_SUSPENDED') msg = 'This account has been suspended.';
  else if (code === 'ACCOUNT_DEACTIVATED') msg = 'This account has been deactivated.';
  else if (code === 'ACCOUNT_DELETED') msg = 'This account has been deleted.';
  showError(msg);
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
  document.getElementById('google-login-btn')?.addEventListener('click', loginWithInAppBrowser);

  document.getElementById('login-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });
  document.getElementById('login-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });
});

// Export globally
window.handleLogin = handleLogin;
window.loginWithInAppBrowser = loginWithInAppBrowser;
window.showError = showError;

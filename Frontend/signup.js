// signup.js — BACKEND defined in scrpt.js
//
// Google sign-up supports two environments:
//   • Native (Capacitor WebView): In-App Browser OAuth via the Capacitor
//     Browser + App plugins (accessed off the window.Capacitor global).
//   • Web (plain browser): Google Identity Services (GIS) via the shared
//     google-auth-handler.js module.
//
// Manual email/password registration uses the shared apiFetch wrapper
// (js/api.js), which throws ApiError on failure and handles 401/403 globally.
//
// No ES-module imports are used — this file is a plain script, matching the
// rest of the codebase, so it runs in the raw WebView without a bundler.

// ── Capacitor plugin handles (present only inside the native app) ──
const CapBrowser = window.Capacitor?.Plugins?.Browser;
const CapApp     = window.Capacitor?.Plugins?.App;
const isNative   = !!window.Capacitor?.isNativePlatform?.();

// ── Email/Password Sign Up ────────────────────────────────
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

  // New registration returns 201 + requiresVerification → send the user to
  // the OTP funnel. Do NOT store a token (the 201 body carries none).
  if (data && data.requiresVerification) {
    sessionStorage.setItem('pendingEmail', email);
    const emailSent = data.emailSent ? '1' : '0';
    sessionStorage.setItem('otpEmailSent', emailSent);
    window.location.href = `verify-otp.html?email=${encodeURIComponent(email)}&emailSent=${emailSent}`;
    return;
  }

  // EMAIL_SEND_FAILED (502): the account could NOT be created/verified because
  // the OTP email failed to send. NEVER silently redirect — surface a clear,
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

// ── Google Sign Up (native + web) ─────────────────────────
async function loginWithInAppBrowser() {
  const oauthUrl = `${BACKEND}/api/auth/google/start?intent=signup`;

  if (isNative && CapBrowser) {
    try {
      await CapBrowser.open({ url: oauthUrl, windowName: '_blank' });
    } catch (err) {
      console.error('[Signup] In-App Browser error:', err?.message || err);
      showError('Could not open Google sign-in. Please try again.');
    }
    return;
  }

  try {
    const response = await window.initGoogleAuth('google-signup-btn');
    if (!response || !response.credential) {
      showError('Google sign-in failed. No credential received.');
      return;
    }
    console.log('[Signup] Google ID token received, verifying with backend...');
    await sendIdTokenToBackend(response.credential);
  } catch (err) {
    console.error('[Signup] Google auth error:', err?.message || err);
  }
}
window.loginWithInAppBrowser = loginWithInAppBrowser;

// Send the ID token to POST /api/auth/google/verify (web GIS flow)
async function sendIdTokenToBackend(idToken) {
  const { ok, data } = await window.apiFetch('/api/auth/google/signup', {
    method: 'POST',
    body: JSON.stringify({ idToken })
  });

  if (ok && data && data.token && data.user) {
    if (window.setAuthTokens) window.setAuthTokens(data.token, data.refreshToken);
    else localStorage.setItem('token', data.token);
    localStorage.setItem('isFirstVisit', 'true');
    window.redirectAfterAuthentication(data.user, data.token, data.refreshToken);
    return;
  }

  console.error('[Signup] Backend verification failed:', data || ok);
  // Distinguish the Google signup business error for a clear message.
  const code = data && data.code;
  let msg = (data && data.message) || 'Google sign-in failed. Please try again.';
  if (code === 'ACCOUNT_ALREADY_EXISTS') msg = 'An AniStrim account already exists with this email or Google account. Please log in instead.';
  showError(msg);
}

// ── Deep Link Handler (native only) ─────────────────────────
async function handleAppUrlOpen(data) {
  try {
    await CapBrowser?.close();
  } catch (e) {
    // Browser may already be closed — safe to ignore
  }

  if (!data || !data.url) return;

  try {
    const url = new URL(data.url);
    const token = url.searchParams.get('token');

    if (token) {
      if (window.setAuthTokens) window.setAuthTokens(token, null);
      else { localStorage.setItem('session_token', token); localStorage.setItem('token', token); }
      window.redirectAfterAuthentication(JSON.parse(localStorage.getItem('user') || 'null'), token, null);
      return;
    }

    const code = url.searchParams.get('code');
    if (code) {
      const res = await fetch(`${BACKEND}/api/auth/google/token?code=${encodeURIComponent(code)}`);
      const raw2 = await res.json();
      const data2 = (raw2 && raw2.success === true && raw2.data) ? raw2.data : raw2;
      if (res.ok && data2.token) {
        if (window.setAuthTokens) window.setAuthTokens(data2.token, data2.refreshToken);
        else { localStorage.setItem('session_token', data2.token); localStorage.setItem('token', data2.token); }
        if (data2.user) localStorage.setItem('user', JSON.stringify(data2.user));
        localStorage.setItem('isFirstVisit', 'true');
        window.redirectAfterAuthentication(data2.user, data2.token, data2.refreshToken);
      } else {
        showError(data2.message || 'Google sign-in failed. Please try again.');
      }
      return;
    }

    if (url.href.includes('auth-error')) {
      showError('Google sign-in was cancelled or failed.');
    }
  } catch (err) {
    console.error('[Signup] Deep link parse error:', err?.message || err);
  }
}

if (CapApp?.addListener) {
  CapApp.addListener('appUrlOpen', handleAppUrlOpen);
}

// ── Error Display ─────────────────────────────────────────
function showError(msg) {
  if (!msg) return;
  let el = document.getElementById('auth-error');
  if (!el) {
    el = document.createElement('p');
    el.id = 'auth-error';
    el.style.cssText = 'color:#f87171;font-size:0.85rem;text-align:center;margin-bottom:10px;';
    const btn = document.getElementById('google-signup-btn');
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
  document.getElementById('google-signup-btn')?.addEventListener('click', loginWithInAppBrowser);

  document.getElementById('signup-pass')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSignUp();
  });
});

// Export globally
window.handleSignUp = handleSignUp;
window.loginWithInAppBrowser = loginWithInAppBrowser;
window.showError = showError;

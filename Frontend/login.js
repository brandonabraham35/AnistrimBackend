// login.js — BACKEND defined in scrpt.js
//
// Google login supports two environments:
//   • Native (Capacitor WebView): In-App Browser OAuth via the Capacitor
//     Browser + App plugins (accessed off the window.Capacitor global).
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
const isNative   = !!window.Capacitor?.isNativePlatform?.();

// ── Email/Password Login ────────────────────────────────────
async function handleLogin() {
  const email    = document.getElementById('login-email')?.value?.trim();
  const password = document.getElementById('login-pass')?.value;
  const btn      = document.querySelector('.auth-submit');

  if (!email || !password) { showError('Please fill in all fields.'); return; }
  btn.textContent = 'Signing in...';
  btn.disabled = true;

  try {
    // apiFetch: on 403 requiresVerification it fires resend-otp and redirects
    // to the OTP screen; on 401 it clears the token and goes to login.html.
    const data = await window.apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      resendOtp: true
    });

    if (data && data.token) {
      localStorage.setItem('token', data.token);
      localStorage.setItem('isFirstVisit', 'true');
      window.redirectAfterAuthentication(data.user);
      return;
    }

    showError((data && data.message) || 'Incorrect email or password.');
    btn.textContent = 'Sign In';
    btn.disabled = false;
  } catch (e) {
    showError(e && e.message ? e.message : 'Cannot reach server. Please check your connection.');
    btn.textContent = 'Sign In';
    btn.disabled = false;
  }
}
window.handleLogin = handleLogin;

// ── Google Login (native + web) ─────────────────────────────
async function loginWithInAppBrowser() {
  const oauthUrl = `${BACKEND}/api/auth/google/start?intent=login`;

  if (isNative && CapBrowser) {
    try {
      await CapBrowser.open({ url: oauthUrl, windowName: '_blank' });
    } catch (err) {
      console.error('[Login] In-App Browser error:', err?.message || err);
      showError('Could not open Google sign-in. Please try again.');
    }
    return;
  }

  try {
    const response = await window.initGoogleAuth('google-login-btn');
    if (!response || !response.credential) {
      showError('Google sign-in failed. No credential received.');
      return;
    }
    console.log('[Login] Google ID token received, verifying with backend...');
    await sendIdTokenToBackend(response.credential);
  } catch (err) {
    console.error('[Login] Google auth error:', err?.message || err);
  }
}
window.loginWithInAppBrowser = loginWithInAppBrowser;

// Send the ID token to POST /api/auth/google/verify (web GIS flow)
async function sendIdTokenToBackend(idToken) {
  try {
    const data = await window.apiFetch('/api/auth/google/verify', {
      method: 'POST',
      body: JSON.stringify({ idToken })
    });
    if (data && data.token && data.user) {
      localStorage.setItem('token', data.token);
      localStorage.setItem('isFirstVisit', 'true');
      window.redirectAfterAuthentication(data.user);
      return;
    }
    showError((data && data.message) || 'Google sign-in failed. Please try again.');
  } catch (e) {
    console.error('[Login] Backend verification error:', e);
    // Distinguish the Google login business errors for a clear message.
    const code = e && e.data && e.data.code;
    let msg = e && e.message ? e.message : 'Cannot reach server. Please check your connection.';
    if (code === 'GOOGLE_ACCOUNT_NOT_FOUND') msg = 'No AniStrim account exists for this Google account. Please create an account first.';
    else if (code === 'GOOGLE_ACCOUNT_NOT_LINKED') msg = 'An AniStrim account already exists with this email. Please log in using your email and password.';
    showError(msg);
  }
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
      localStorage.setItem('session_token', token);
      localStorage.setItem('token', token);
      window.redirectAfterAuthentication(JSON.parse(localStorage.getItem('user') || 'null'));
      return;
    }

    const code = url.searchParams.get('code');
    if (code) {
      const res = await fetch(`${BACKEND}/api/auth/google/token?code=${encodeURIComponent(code)}`);
      const data2 = await res.json();
      if (res.ok && data2.token) {
        localStorage.setItem('session_token', data2.token);
        localStorage.setItem('token', data2.token);
        if (data2.user) localStorage.setItem('user', JSON.stringify(data2.user));
        localStorage.setItem('isFirstVisit', 'true');
        window.redirectAfterAuthentication(data2.user);
      } else {
        showError(data2.message || 'Google sign-in failed. Please try again.');
      }
      return;
    }

    if (url.href.includes('auth-error')) {
      showError('Google sign-in was cancelled or failed.');
    }
  } catch (err) {
    console.error('[Login] Deep link parse error:', err?.message || err);
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
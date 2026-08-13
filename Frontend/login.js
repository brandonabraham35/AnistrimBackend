// login.js — BACKEND defined in scrpt.js
//
// Google login supports two environments:
//   • Native (Capacitor WebView): In-App Browser OAuth via the Capacitor
//     Browser + App plugins (accessed off the window.Capacitor global).
//   • Web (plain browser): Google Identity Services (GIS) via the shared
//     google-auth-handler.js module.
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
    const res  = await fetch(`${BACKEND}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (res.ok) {
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('isFirstVisit', 'true');
      window.location.href = data.user.isAdmin ? 'admin.html' : 'index.html';
    } else if (res.status === 403 && data.requiresVerification) {
      // Unverified account — route to the OTP screen. The backend already
      // re-issued a fresh code on this 403 (see authController.login).
      const pending = data.email || email;
      const emailSent = data.emailSent ? '1' : '0';
      sessionStorage.setItem('pendingEmail', pending);
      sessionStorage.setItem('otpEmailSent', emailSent);
      window.location.href = `verify-otp.html?email=${encodeURIComponent(pending)}&emailSent=${emailSent}`;
      return;
    } else {
      showError(data.message || 'Incorrect email or password.');
      btn.textContent = 'Sign In';
      btn.disabled = false;
    }
  } catch (e) {
    showError('Cannot reach server. Please check your connection.');
    btn.textContent = 'Sign In';
    btn.disabled = false;
  }
}
window.handleLogin = handleLogin;

// ── Google Login (native + web) ─────────────────────────────
async function loginWithInAppBrowser() {
  const oauthUrl = `${BACKEND}/api/auth/google/start`;

  if (isNative && CapBrowser) {
    // Native: open the backend OAuth start endpoint in the in-app browser.
    // The backend redirects back to the app via a deep link handled below.
    try {
      await CapBrowser.open({ url: oauthUrl, windowName: '_blank' });
    } catch (err) {
      console.error('[Login] In-App Browser error:', err?.message || err);
      showError('Could not open Google sign-in. Please try again.');
    }
    return;
  }

  // Web: use the shared Google Identity Services module (google-auth-handler.js)
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
    const res = await fetch(`${BACKEND}/api/auth/google/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    });

    const data = await res.json();

    if (res.ok && data.token && data.user) {
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('isFirstVisit', 'true');
      window.location.href = data.user.isAdmin ? 'admin.html' : 'index.html';
    } else {
      showError(data.message || 'Google sign-in failed. Please try again.');
    }
  } catch (e) {
    console.error('[Login] Backend verification error:', e);
    showError('Cannot reach server. Please check your connection.');
  }
}

// ── Deep Link Handler (native only) ─────────────────────────
// Fires when the app is woken up via a deep link (e.g. anistrim://auth?token=...).
async function handleAppUrlOpen(data) {
  try {
    // Shut down the in-app browser window
    await CapBrowser?.close();
  } catch (e) {
    // Browser may already be closed — safe to ignore
  }

  if (!data || !data.url) return;

  try {
    const url = new URL(data.url);
    const token = url.searchParams.get('token');

    // Preferred flow: backend hands back a direct session token
    if (token) {
      localStorage.setItem('session_token', token);
      localStorage.setItem('token', token);
      window.location.href = 'index.html';
      return;
    }

    // Fallback for the existing backend handoff: a short-lived exchange code.
    const code = url.searchParams.get('code');
    if (code) {
      const res = await fetch(`${BACKEND}/api/auth/google/token?code=${encodeURIComponent(code)}`);
      const data2 = await res.json();
      if (res.ok && data2.token) {
        localStorage.setItem('session_token', data2.token);
        localStorage.setItem('token', data2.token);
        if (data2.user) localStorage.setItem('user', JSON.stringify(data2.user));
        localStorage.setItem('isFirstVisit', 'true');
        window.location.href = data2.user?.isAdmin ? 'admin.html' : 'index.html';
      } else {
        showError(data2.message || 'Google sign-in failed. Please try again.');
      }
      return;
    }

    // Cancelled / error deep link (e.g. anistrim://auth-error)
    if (url.href.includes('auth-error')) {
      showError('Google sign-in was cancelled or failed.');
    }
  } catch (err) {
    console.error('[Login] Deep link parse error:', err?.message || err);
  }
}

// Register the global appUrlOpen listener (native only)
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
  // Auto-clear after 10 seconds
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
  // Bind the Google login to the "Continue with Google" button
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
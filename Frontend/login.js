// login.js - BACKEND defined in scrpt.js
//
// Google Sign-In uses the Capacitor Browser OAuth redirect flow.
// This module does NOT use GIS, @capawesome/capacitor-google-sign-in,
// or Credential Manager.

const CapBrowser = window.Capacitor?.Plugins?.Browser;
const isNative = !!window.Capacitor?.isNativePlatform?.();

async function handleLogin() {
  const email = document.getElementById('login-email')?.value?.trim();
  const password = document.getElementById('login-pass')?.value;
  const btn = document.querySelector('.auth-submit');
  if (!email || !password) { showError('Please fill in all fields.'); return; }
  btn.textContent = 'Signing in...';
  btn.disabled = true;
  const { ok, data } = await window.apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
    resendOtp: true
  });
  if (ok && data && data.token) {
    if (window.trackEvent) window.trackEvent('login');
    if (window.setAuthTokens) window.setAuthTokens(data.token, data.refreshToken);
    else localStorage.setItem('token', data.token);
    localStorage.setItem('isFirstVisit', 'true');
    const user = data.user || (await window.Session?.refresh?.());
    window.redirectAfterAuthentication?.(user, data.token, data.refreshToken);
    return;
  }
  showError((data && data.message) || 'Incorrect email or password.');
  btn.textContent = 'Sign In';
  btn.disabled = false;
}
window.handleLogin = handleLogin;

async function googleLogin() {
  try {
    const backend = (typeof window.getApiBaseUrl === 'function') ? window.getApiBaseUrl() : 'https://anistrimbackend.onrender.com';
    if (CapBrowser) {
      // ── Detect the OAuth callback INSIDE the browser ──────────
      // Chrome Custom Tab does not reliably deliver intent:// URLs to
      // the Android app, so appUrlOpen may never fire. This listener
      // catches the fallback navigation and processes the login code
      // directly, before any deep-link handoff is attempted.
      var _browserCodeProcessed = false;
      CapBrowser.addListener('browserPageLoaded', function (event) {
        if (_browserCodeProcessed) return;
        if (!event || !event.url) return;
        if (!event.url.includes('code=')) return;
        // Only process the one-time login code URL patterns, not
        // the intermediate Google OAuth code on the callback page.
        if (!event.url.includes('/callback-fallback') && !event.url.includes('anistrim://auth')) return;
        _browserCodeProcessed = true;
        var code = (typeof window.__googleAuthGetCodeFromUrl === 'function')
          ? window.__googleAuthGetCodeFromUrl(event.url)
          : null;
        if (!code) { _browserCodeProcessed = false; return; }
        // Close the browser, then let the shared handler complete
        // the token exchange, persist the session, and redirect.
        CapBrowser.close().catch(function () {});
        if (typeof window.__googleAuthFetchAndLogin === 'function') {
          window.__googleAuthFetchAndLogin(code);
        }
      });
      await CapBrowser.open({ url: backend + '/api/auth/google', windowName: '_self', presentationStyle: 'fullscreen' });
    } else {
      window.location.href = backend + '/api/auth/google';
    }
  } catch (e) {
    console.error('Google login error:', e);
    showError('Could not open Google sign-in. Please try again.');
  }
}
window.googleLogin = googleLogin;

function showError(msg) {
  if (!msg) return;
  var el = document.getElementById('auth-error');
  if (!el) {
    el = document.createElement('p');
    el.id = 'auth-error';
    el.style.cssText = 'color:#f87171;font-size:0.85rem;text-align:center;margin-bottom:10px;';
    var s = document.querySelector('.auth-submit');
    if (s && s.parentNode) s.parentNode.insertBefore(el, s.nextSibling);
  }
  el.textContent = msg;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('google-login-btn')?.addEventListener('click', googleLogin);
  document.getElementById('login-pass')?.addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
  document.getElementById('login-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
});

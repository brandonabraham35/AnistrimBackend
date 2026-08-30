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
      CapBrowser.addListener('browserFinished', function () {
        var t = localStorage.getItem('token') || '';
        var u = localStorage.getItem('user');
        if (t && u) {
          try { var ud = JSON.parse(u); window.location.href = (ud && ud.isAdmin) ? 'admin.html' : 'index.html'; } catch (e) { }
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
